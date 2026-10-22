import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import {
  assertNativeCloseEvidence,
  completeNativeControlledClose,
  nativeFixtureViewCount,
  nativeMaintenanceTerminal,
  prepareNativeFixtureClose,
} from "./native-controlled-close.mjs";

function harness({ dirty = false, unconfirmed = false, duplicate = false } = {}) {
  const plugin = { views: new Set(), annotationHost: { store: { sourceProtocol: "wal-sidecar-v3.2-jsonl" } } };
  const makeView = (path, token, id) => {
    const view = {
      requestedPath: path,
      token,
      documentId: `doc-${id}`,
      openRequest: id,
      annotationDocument: { docKey: `key-${id}`, source: { sourceHash: `hash-${id}` } },
      currentRevision: dirty ? 3 : 2,
      confirmedRevision: dirty ? 2 : 2,
      pendingSaves: dirty ? 1 : 0,
      iframe: { contentWindow: { PDFViewerApplication: { _hasChanges: () => dirty } } },
      preparedClose: null,
      prepareControlledClose: async reason => {
        assert.equal(reason, "detach");
        view.preparedClose = {
          id: `close-${id}`,
          documentId: view.documentId,
          openRequest: view.openRequest,
          revision: view.currentRevision,
          unconfirmed,
          recovered: false,
        };
        return true;
      },
      leaf: { detach: async () => plugin.views.delete(view) },
    };
    plugin.views.add(view);
    return view;
  };
  const target = makeView("fixture/source.pdf", "fixture-token", 1);
  if (duplicate) makeView("fixture/source.pdf", "second-token", 2);
  const other = makeView("unrelated/other.pdf", "other-token", 3);
  const context = vm.createContext({
    app: { plugins: { plugins: { "pdf-web-reader": plugin } } },
    __sidecarNative07: { maintenance: [
      { event: "annotation-snapshot-materialized", documentId: "unrelated-doc", receivedAt: 1 },
      { event: "annotation-snapshot-materialized", documentId: "doc-1", receivedAt: 2 },
    ] },
  });
  const runSerialized = async (fn, arg) => {
    const source = `(${fn.toString()})(${JSON.stringify(arg ?? null)})`;
    return await vm.runInContext(source, context);
  };
  return { plugin, target, other, context, runSerialized };
}

const validWal = root => ({
  protocol: "wal-sidecar-v3.2-jsonl",
  snapshot: { path: `${root}/sidecars/key-1.annotations.json`, status: "verified-consistent" },
  durableWal: { status: "replayed", referencesComplete: true, jsonlComplete: true, missingArchives: [] },
  operationFiles: [`${root}/wal/device/key-1.jsonl`],
  verifiedEnvelopes: [`${root}/sidecars/key-1.annotations.json`, `${root}/wal/device/key-1.jsonl.anchor.json`],
  walWatermarkTotal: 2,
});

test("serialized controlled close receives its maintenance offset and detaches only the exact clean fixture", async () => {
  const h = harness();
  const callback = vm.runInContext(`(${prepareNativeFixtureClose.toString()})`, h.context);
  const result = await callback({ path: "fixture/source.pdf", token: "fixture-token", maintenanceOffset: 17 });
  assert.equal(result.ok, true);
  assert.equal(result.maintenanceOffset, 17);
  assert.equal(result.before.documentId, "doc-1");
  assert.equal(h.plugin.views.has(h.target), false);
  assert.equal(h.plugin.views.has(h.other), true);
  assert.equal(await h.runSerialized(nativeFixtureViewCount, { path: "fixture/source.pdf" }), 0);
});

test("serialized controlled close refuses dirty, unconfirmed, or ambiguous fixture sessions", async () => {
  const dirty = harness({ dirty: true, unconfirmed: true });
  const dirtyResult = await dirty.runSerialized(prepareNativeFixtureClose,
    { path: "fixture/source.pdf", token: "fixture-token", maintenanceOffset: 0 });
  assert.equal(dirtyResult.ok, false);
  assert.equal(dirty.plugin.views.has(dirty.target), true);

  const ambiguous = harness({ duplicate: true });
  const ambiguousResult = await ambiguous.runSerialized(prepareNativeFixtureClose,
    { path: "fixture/source.pdf", token: null, maintenanceOffset: 0 });
  assert.equal(ambiguousResult.ok, false);
  assert.equal(ambiguousResult.reason, "fixture-view-identity-not-unique");
  assert.equal(ambiguous.plugin.views.size, 3);
});

test("serialized maintenance probe filters by document and supplied offset", async () => {
  const h = harness();
  const result = await h.runSerialized(nativeMaintenanceTerminal, { documentId: "doc-1", offset: 1 });
  assert.equal(result.event, "annotation-snapshot-materialized");
  assert.equal(result.documentId, "doc-1");
  const noMatch = await h.runSerialized(nativeMaintenanceTerminal, { documentId: "doc-1", offset: 2 });
  assert.equal(noMatch, null);
});

test("controlled-close orchestration awaits zero-view, terminal maintenance, and independent WAL evidence", async () => {
  const h = harness();
  const root = ".obsidian/plugins/pdf-web-reader/.native-test-output/run-1/sidecar";
  let filesLoaded = false, walResolved = false;
  const result = await completeNativeControlledClose({
    runSerialized: h.runSerialized,
    waitFor: async (label, probe, accepts) => {
      const value = await probe();
      assert.ok(accepts(value), `${label}: unexpected probe value ${JSON.stringify(value)}`);
      return value;
    },
    loadFiles: async requestedRoot => {
      assert.equal(requestedRoot, root);
      filesLoaded = true;
      return new Map();
    },
    readWalEvidence: async ({ files, isolatedRoot }) => {
      assert.equal(filesLoaded, true);
      assert.equal(isolatedRoot, root);
      await Promise.resolve();
      walResolved = true;
      return validWal(root);
    },
    hash: () => "unused-in-vm-fixture",
    filePath: "fixture/source.pdf",
    targetToken: "fixture-token",
    expectedRemaining: 0,
    label: "VM close contract",
    maintenanceOffset: 1,
    isolatedRoot: root,
    virtualRoot: "00_Archive/20_PDFData",
  });
  assert.equal(walResolved, true, "the async WAL evidence reader must settle before close is accepted");
  assert.equal(result.remaining, 0);
  assert.equal(result.closeEvidence.maintenanceEvent, "annotation-snapshot-materialized");
  assert.equal(result.closeEvidence.snapshotStatus, "verified-consistent");
  assert.equal(result.closeEvidence.walStatus, "replayed");
  assert.equal(h.plugin.views.has(h.target), false);
  assert.equal(h.plugin.views.has(h.other), true);
});

test("close evidence rejects live views, nonterminal maintenance, and paths outside the isolated namespace", () => {
  const root = ".obsidian/plugins/pdf-web-reader/.native-test-output/run-1/sidecar";
  const maintenance = { event: "annotation-snapshot-materialized" };
  const wal = validWal(root);
  assert.equal(assertNativeCloseEvidence({ viewCount: 0, maintenance, wal, isolatedRoot: root }).walStatus, "replayed");
  assert.throws(() => assertNativeCloseEvidence({ viewCount: 1, maintenance, wal, isolatedRoot: root }), /view remains/);
  assert.throws(() => assertNativeCloseEvidence({ viewCount: 0, maintenance: { event: "annotation-snapshot-sync-pending" }, wal, isolatedRoot: root }), /did not materialize/);
  const escaped = { ...wal, operationFiles: ["00_Archive/20_PDFData/wal/device/key-1.jsonl"] };
  assert.throws(() => assertNativeCloseEvidence({ viewCount: 0, maintenance, wal: escaped, isolatedRoot: root }), /escaped the isolated sidecar namespace/);
});
