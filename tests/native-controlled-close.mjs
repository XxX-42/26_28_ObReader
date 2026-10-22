// These callbacks are serialized into the Obsidian runtime with Function#toString.
// Keep their full dependencies in their explicit argument or the Native globals.
export async function prepareNativeFixtureClose({ path, token, maintenanceOffset }) {
  const plugin = app.plugins.plugins["pdf-web-reader"];
  const matches = [...plugin.views].filter(view => view.requestedPath === path && (!token || view.token === token));
  if (matches.length === 0) return { alreadyAbsent: true, remaining: [...plugin.views].filter(view => view.requestedPath === path).length };
  if (matches.length !== 1) return { ok: false, reason: "fixture-view-identity-not-unique", matchCount: matches.length };

  const view = matches[0], application = view.iframe?.contentWindow?.PDFViewerApplication;
  const before = {
    path: view.requestedPath,
    token: view.token,
    documentId: view.documentId,
    openRequest: view.openRequest,
    docKey: view.annotationDocument?.docKey,
    sourceHash: view.annotationDocument?.source?.sourceHash,
    revision: view.currentRevision,
    confirmed: view.confirmedRevision,
    pending: view.pendingSaves,
    dirty: !!application?._hasChanges?.(),
    protocol: plugin.annotationHost?.store?.sourceProtocol || null,
  };
  const prepareOk = await view.prepareControlledClose("detach");
  const source = view.preparedClose;
  const prepared = source ? {
    id: source.id ?? null,
    documentId: source.documentId ?? null,
    openRequest: source.openRequest ?? null,
    revision: source.revision ?? null,
    recovered: source.recovered === true,
    unconfirmed: source.unconfirmed === true,
    unloaded: source.unloaded === true,
  } : null;
  const clean = prepareOk === true && prepared?.unconfirmed !== true &&
    prepared?.documentId === before.documentId && prepared?.openRequest === before.openRequest &&
    Number.isSafeInteger(prepared?.revision) && prepared.revision >= before.revision &&
    before.pending === 0 && before.revision === before.confirmed && before.dirty === false;
  if (!clean) return { ok: false, reason: "controlled-close-not-confirmed-clean", before, prepareOk, prepared };

  await view.leaf.detach();
  return { ok: true, before, prepared, maintenanceOffset };
}

export function nativeFixtureViewCount({ path, token = null }) {
  return [...app.plugins.plugins["pdf-web-reader"].views]
    .filter(view => view.requestedPath === path && (!token || view.token === token)).length;
}

export function nativeMaintenanceTerminal({ documentId, offset }) {
  const terminalEvents = ["annotation-snapshot-materialized", "annotation-snapshot-sync-pending",
    "annotation-snapshot-materialize-failed"];
  const rows = globalThis.__sidecarNative07.maintenance.slice(offset)
    .filter(row => row.documentId === documentId);
  return rows.find(row => terminalEvents.includes(row.event)) || null;
}

export function assertNativeCloseEvidence({ viewCount, maintenance, wal, isolatedRoot }) {
  if (viewCount !== 0) throw new Error(`Reader view remains after controlled close: ${viewCount}`);
  if (maintenance?.event !== "annotation-snapshot-materialized") {
    throw new Error(`Close maintenance did not materialize a snapshot: ${JSON.stringify(maintenance)}`);
  }
  if (wal?.protocol !== "wal-sidecar-v3.2-jsonl" || wal.durableWal?.status !== "replayed" ||
      wal.durableWal.referencesComplete !== true || wal.durableWal.jsonlComplete !== true ||
      wal.durableWal.missingArchives?.length !== 0 || wal.snapshot?.status !== "verified-consistent") {
    throw new Error("Close evidence does not prove a complete isolated WAL replay and matching derived snapshot");
  }
  const root = isolatedRoot.replace(/\/+$/, "") + "/";
  const paths = [wal.snapshot.path, ...(wal.operationFiles || []), ...(wal.verifiedEnvelopes || [])];
  if (!paths.length || paths.some(value => typeof value !== "string" || !value.startsWith(root))) {
    throw new Error(`Close evidence escaped the isolated sidecar namespace ${isolatedRoot}`);
  }
  return {
    viewCount,
    maintenanceEvent: maintenance.event,
    protocol: wal.protocol,
    snapshotStatus: wal.snapshot.status,
    walStatus: wal.durableWal.status,
    walWatermarkTotal: wal.walWatermarkTotal,
    isolatedRoot,
    evidencePaths: paths.length,
  };
}

export async function completeNativeControlledClose({
  runSerialized,
  waitFor,
  loadFiles,
  readWalEvidence,
  hash,
  filePath,
  targetToken = null,
  expectedRemaining = 0,
  label,
  maintenanceOffset,
  isolatedRoot,
  virtualRoot,
}) {
  const result = await runSerialized(prepareNativeFixtureClose,
    { path: filePath, token: targetToken, maintenanceOffset });
  if (result.alreadyAbsent) return { label, ...result };
  if (result.ok !== true) {
    throw new Error(`${label}: refusing to detach without a clean controlled-close ACK: ${JSON.stringify(result)}`);
  }
  await waitFor(`${label} exact Reader detached`,
    () => runSerialized(nativeFixtureViewCount, { path: filePath, token: targetToken }),
    count => count === 0, 8_000);
  const remaining = await runSerialized(nativeFixtureViewCount, { path: filePath });
  if (remaining !== expectedRemaining) throw new Error(`${label}: unexpected remaining fixture Reader count ${remaining}`);

  let maintenance = null, walAfterClose = null, closeEvidence = null;
  if (remaining === 0 && result.before.protocol?.startsWith("wal-sidecar-v3.")) {
    maintenance = await waitFor(`${label} annotation maintenance settled`,
      () => runSerialized(nativeMaintenanceTerminal,
        { documentId: result.before.documentId, offset: maintenanceOffset }),
      Boolean, 20_000);
    const files = await loadFiles(isolatedRoot);
    walAfterClose = await readWalEvidence({ files, isolatedRoot, virtualRoot,
      docKey: result.before.docKey, documentId: result.before.documentId,
      sourceHash: result.before.sourceHash, viewerRevision: result.before.revision,
      confirmedViewerRevision: result.before.confirmed, hash });
    closeEvidence = assertNativeCloseEvidence({ viewCount: remaining, maintenance, wal: walAfterClose, isolatedRoot });
  }
  return {
    label,
    ...result,
    remaining,
    maintenance,
    closeEvidence,
    walAfterClose: walAfterClose && {
      protocol: walAfterClose.protocol,
      snapshotStatus: walAfterClose.snapshot?.status,
      walStatus: walAfterClose.durableWal?.status,
      viewerRevision: walAfterClose.viewer?.revision,
      confirmedViewerRevision: walAfterClose.viewer?.confirmedRevision,
      walWatermarkTotal: walAfterClose.walWatermarkTotal,
    },
  };
}
