import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { constants, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import xxhash from "xxhash-wasm";
import { PDFDocument, PDFName } from "pdf-lib";
import { nativeConfig, nativeCdp, nativeEvalJson, assertNativeTestPreflight } from "./native-config.mjs";
import { installNativeSelectionProbe } from "./native-selection-probe.mjs";
import {
  mapNativeSidecarAdapterArgs,
  mapNativeSidecarListResult,
  readNativeSidecarTree,
  serializeNativeSidecarAdapterMapper,
} from "./native-sidecar-isolation.mjs";
import { readNativeWalEvidence } from "./native-wal-evidence.mjs";
import { assertNativeCloseEvidence, completeNativeControlledClose, nativeFixtureViewCount,
  nativeMaintenanceTerminal } from "./native-controlled-close.mjs";

// This is an opt-in Native Obsidian test, never part of npm test. Only a new
// fixture is editable. Existing sidecar files are guarded before any mutation.
const root = path.resolve(import.meta.dirname, "..");
const expectedVersion = process.env.PDF_READER_NATIVE_VERSION || "0.7.1";
const scenario = process.env.PDF_READER_NATIVE_SCENARIO || "five-tools";
assert.ok(["five-tools", "freetext", "underline", "benchmark-small", "benchmark-large"].includes(scenario));
const benchmarking = scenario.startsWith("benchmark-");
const diagnoseTextCapture = process.env.PDF_READER_NATIVE_DIAG_SKIP_TEXT_CAPTURE === "1";
assert.ok(!diagnoseTextCapture || ["five-tools", "underline"].includes(scenario), "Text-capture override is diagnostic-only");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const traceRunId = randomBytes(16).toString("hex");
const folder = `PDF迁移测试/sidecar-native-${expectedVersion}-${stamp}`;
const file = `${folder}/immutable-source.pdf`;
const storeRoot = "00_Archive/20_PDFData";
const artifacts = path.join(root, "tests/artifacts");
const resultPath = path.join(artifacts, `0.7-sidecar-native-acceptance-${stamp}.json`);
const traceArtifactVaultPath = `${nativeConfig.configDir}/plugins/pdf-web-reader/.native-test-output/${traceRunId}.json`;
const traceArtifactLocalPath = absolutePathForVault(traceArtifactVaultPath);
const isolatedStoreRoot = `${nativeConfig.configDir}/plugins/pdf-web-reader/.native-test-output/${traceRunId}/sidecar`;
const text = "SIDECAR NATIVE 0.7\nVISIBLE FREETEXT";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const { h64Raw } = await xxhash();
const hashes = bytes => ({ sha256: sha(bytes), xxh64: `xxh64-v1:${h64Raw(bytes).toString(16).padStart(16, "0")}`, bytes: bytes.byteLength });
const verifyHash = bytes => `xxh64-v1:${h64Raw(bytes).toString(16).padStart(16, "0")}`;
const absolute = p => path.join(nativeConfig.vault, ...p.split("/"));
function absolutePathForVault(p) {
  return path.join(nativeConfig.vault, ...p.split("/"));
}
async function installedTriplet() {
  return Object.fromEntries(await Promise.all(['main.js','manifest.json','styles.css'].map(async name=>{
    const bytes=await readFile(absolute(`${nativeConfig.configDir}/plugins/pdf-web-reader/${name}`));
    return [name,{sha256:sha(bytes),bytes:bytes.byteLength}];
  })));
}
const report = {
  version: expectedVersion,
  scenario,
  vault: nativeConfig.vault,
  fixture: file,
  isolatedStoreRoot,
  repository: {
    branch: execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(),
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()),
    acceptanceRunnerSha256: sha(await readFile(new URL(import.meta.url))),
    sidecarIsolationHelperSha256: sha(await readFile(path.join(root, "tests/native-sidecar-isolation.mjs"))),
    walEvidenceHelperSha256: sha(await readFile(path.join(root, "tests/native-wal-evidence.mjs"))),
  },
  startedAt: new Date().toISOString(),
  stages: [],
  snapshotReadRaces: [],
  status: "running",
};
report.driverSourceHashReads = [];
async function sourceHashes(label) {
  const startedAt = performance.now();
  const bytes = await readFile(absolute(file));
  const result = hashes(bytes);
  report.driverSourceHashReads.push({ label, bytes: bytes.byteLength, readAndHashMs: performance.now()-startedAt });
  return result;
}
if (diagnoseTextCapture) report.diagnosticOverrides = ["skip textLayer pointer capture; NOT candidate acceptance"];
let instrumented = false;
let callSequence = 0;

function run(fn, arg) {
  const expression = `(async()=>{if(app.vault.adapter.basePath!==${JSON.stringify(nativeConfig.vault)})throw Error('Wrong Vault');
    if(app.plugins.plugins['pdf-web-reader']?.manifest.version!==${JSON.stringify(expectedVersion)})throw Error('Wrong runtime version');
    ${serializeNativeSidecarAdapterMapper()}
    return JSON.stringify(await (${fn.toString()})(${JSON.stringify(arg ?? null)}));})()`;
  // Obsidian's Windows CLI socket cannot reliably receive a large JSON request
  // in one chunk. Keep the command short; preserve the exact evaluated script
  // as an audit artifact rather than relying on argument-size limits.
  const script = path.join(artifacts, `native-call-${stamp}-${++callSequence}.js`);
  writeFileSync(script, expression, "utf8");
  return nativeEvalJson(`(0,eval)(require('node:fs').readFileSync(${JSON.stringify(script)},'utf8'))`, 30_000);
}
function doc(fn, arg) {
  return run(async ({ source, arg, file }) => {
    const p = app.plugins.plugins["pdf-web-reader"];
    const v = [...p.views].find(v => v.requestedPath === file);
    if (!v?.iframe?.contentWindow) return null;
    const w = v.iframe.contentWindow, d = w.document, a = w.PDFViewerApplication;
    return await (0, eval)(`(${source})`)({ v, w, d, a, arg });
  }, { source: fn.toString(), arg, file });
}
async function wait(label, probe, ok = Boolean, timeout = 30_000) {
  const end = Date.now() + timeout; let latest;
  while (Date.now() < end) {
    latest = await probe(); if (ok(latest)) return latest;
    await new Promise(r => setTimeout(r, 120));
  }
  throw Error(`${label}: ${JSON.stringify(latest)}`);
}
async function tree(dir, { rejectPending = false } = {}) {
  return readNativeSidecarTree(dir, { resolvePath: absolute, rejectPending });
}
const protectedFiles = await tree(storeRoot);
await mkdir(artifacts, { recursive: true });

async function mouse(type, x, y, extra = {}) {
  nativeCdp("Input.dispatchMouseEvent", { type, x, y, ...extra });
}
async function click(point) {
  await mouse("mouseMoved", point.x, point.y);
  await mouse("mousePressed", point.x, point.y, { button: "left", buttons: 1, clickCount: 1 });
  await mouse("mouseReleased", point.x, point.y, { button: "left", buttons: 0, clickCount: 1 });
}
async function drag(from, to) {
  await mouse("mouseMoved", from.x, from.y);
  await mouse("mousePressed", from.x, from.y, { button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++) await mouse("mouseMoved", from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8, { buttons: 1, button: "left" });
  await mouse("mouseReleased", to.x, to.y, { button: "left", buttons: 0, clickCount: 1 });
}
async function key(key, code, vk, modifiers = 0) {
  const p = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  nativeCdp("Input.dispatchKeyEvent", { type: "keyDown", ...p });
  nativeCdp("Input.dispatchKeyEvent", { type: "keyUp", ...p });
}
async function button(selector) {
  const p = await wait(`button ${selector}`, () => doc(({ v, d, arg }) => {
    const e = d.querySelector(arg); if (!e || e.disabled) return null;
    const r = e.getBoundingClientRect(), f = v.iframe.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: f.x + r.x + r.width / 2, y: f.y + r.y + r.height / 2 };
  }, selector));
  await click(p);
}
async function state() {
  return doc(({ v, w, d, a }) => {
    const m = a?.pdfViewer?._layerProperties?.annotationEditorUIManager;
    const editors = [...d.querySelectorAll(".annotationEditorLayer > div[id]")]
      .map(e => ({ e, editor: m?.getEditor(e.id) })).filter(x => x.editor)
      .map(({ e, editor }) => {
        const r = e.getBoundingClientRect(), s = w.getComputedStyle(e);
        return { id: editor.id, type: editor.constructor._editorType, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, display: s.display, visibility: s.visibility, opacity: s.opacity, text: e.querySelector(".internal")?.innerText?.replaceAll("\u00a0", " ") || null, serialized: editor.serialize?.(true) };
      });
    return { ready: v.ready, revision: v.currentRevision, confirmed: v.confirmedRevision, pending: v.pendingSaves,
      dirty: !!a?._hasChanges?.(), mode: a?.pdfViewer?.annotationEditorMode, docKey: v.annotationDocument?.docKey,
      protocol: app.plugins.plugins['pdf-web-reader'].annotationHost?.store?.sourceProtocol || null,
      documentId: v.annotationDocument?.documentId, sourceHash: v.annotationDocument?.source?.sourceHash,
      snapshot: v.annotationSnapshot, editors, buttonsReady: !d.getElementById("editorUnderlineButton")?.disabled,
      visibility: d.visibilityState, pageRendered: a?.pdfViewer?.getPageView(0)?.renderingState };
  });
}
async function open() {
  await wait("fixture indexed", () => run(p => !!app.vault.getAbstractFileByPath(p), file));
  await run(async p => {
    const plugin=app.plugins.plugins["pdf-web-reader"];
    const opening=plugin.openPdf(app.vault.getAbstractFileByPath(p));
    let view;
    for(let attempt=0;attempt<40&&!view;attempt++){
      view=[...plugin.views].find(v=>v.requestedPath===p);
      if(!view)await new Promise(resolve=>setTimeout(resolve,25));
    }
    if(view?.leaf)await app.workspace.revealLeaf(view.leaf);
    await opening;
    return true;
  }, file);
  await wait("Viewer source confirmed and rendered", state, s => s?.ready && s.buttonsReady && s.pageRendered === 3, 60_000);
  assert.equal((await state()).protocol, 'wal-sidecar-v3.2-jsonl',
    'This acceptance requires the current JSONL store, not a legacy compatibility fallback');
  await doc(({ v, w, a, d, arg }) => {
    a.pdfViewer.currentScaleValue = arg;
    d.getElementById("viewerContainer").scrollTop = 0;
    const t = globalThis.__sidecarNative07;
    t.viewerWindows.set(w,v.token);
    t.docKey=v.annotationDocument?.docKey;
    t.documentId=v.annotationDocument?.documentId;
    t.sourceHash=v.annotationDocument?.source?.sourceHash;
    t.protocol=app.plugins.plugins['pdf-web-reader'].annotationHost?.store?.sourceProtocol||null;
    const post = v.postToViewer;
    t.originals.push({object:v,name:'postToViewer',original:post});
    v.postToViewer = function(message, ...args) {
      if (["saved", "recovered", "error"].includes(message.type)) t.acks.push({ at: performance.now(), ...message });
      return post.call(this, message, ...args);
    };
    const save = a.pdfDocument.saveDocument;
    t.originals.push({object:a.pdfDocument,name:'saveDocument',original:save});
    a.pdfDocument.saveDocument = function(...args) {
      t.pdfSerializations.push({ at: performance.now(), exportAllowed: t.exportAllowed });
      if (!t.exportAllowed) throw Error("Daily PDF serialization is forbidden");
      return save.apply(this, args);
    };
    const pointerListener=e=>t.pointers.push({at:performance.now(),trusted:e.isTrusted,type:e.pointerType,x:e.clientX,y:e.clientY});
    d.addEventListener("pointerup",pointerListener,true);
    t.listeners.push({target:d,type:'pointerup',listener:pointerListener});
    return true;
  }, scenario === "underline" ? "1" : "page-fit");
  if (!benchmarking) {
    await doc(({ d, w, a, arg }) => {
      const t = globalThis.__sidecarNative07;
      t.probeCleanup?.();
      t.probeCleanup = (0, eval)(`(${arg})`)({ d, w, a, trace: t, captureFixtureText:true });
      (t.selectionProbes ||= []).push(t.nativeSelectionProbe);
      return true;
    }, installNativeSelectionProbe.toString());
  }
  if (diagnoseTextCapture) {
    await doc(({ w }) => {
      const t = globalThis.__sidecarNative07;
      const object = w.Element.prototype, original = object.setPointerCapture;
      t.originals.push({ object, name: "setPointerCapture", original });
      object.setPointerCapture = function (...args) {
        if (this.matches(".textLayer")) return;
        return original.apply(this, args);
      };
      return true;
    });
  }
  await wait("requested scale layout", state, s => s.pageRendered === 3);
}
async function mode(n, type) {
  if ((await state())?.mode === type) return;
  await button([null, "#editorUnderlineButton", "#editorSquareButton", "#editorHighlightButton", "#editorInkButton", "#editorFreeTextButton"][n]);
  await wait(`mode ${type}`, state, s => s.mode === type);
}
async function point(rx, ry) {
  return doc(({ v, d, arg }) => {
    const p = d.querySelector('.page[data-page-number="1"]').getBoundingClientRect(), f = v.iframe.getBoundingClientRect();
    return { x: f.x + p.x + p.width * arg[0], y: f.y + p.y + p.height * arg[1] };
  }, [rx, ry]);
}
async function checkpoint() {
  const s = await state();
  let all;
  try {
    all = await tree(isolatedStoreRoot, { rejectPending: true });
  } catch (error) {
    if (error?.code !== "NATIVE_SIDECAR_SNAPSHOT_TRANSIENT") throw error;
    report.snapshotReadRaces.push({ at: new Date().toISOString(), path: error.path });
    return null;
  }
  return readNativeWalEvidence({
    files: all,
    isolatedRoot: isolatedStoreRoot,
    virtualRoot: storeRoot,
    docKey: s.docKey,
    documentId: s.documentId,
    sourceHash: s.sourceHash,
    viewerRevision: s.revision,
    confirmedViewerRevision: s.confirmed,
    hash: verifyHash,
  });
}
async function stableCheckpoint(label = "stable Native sidecar evidence") {
  return wait(label, checkpoint, evidence => evidence !== null);
}
async function saved(label, expectedTypes) {
  await doc(({ w, d }) => { w.focus(); d.getElementById("viewerContainer").focus(); return true; });
  await key("s", "KeyS", 83, 2);
  const savedState = await wait(`saved ${label}`, state, s => !s.dirty && !s.pending && s.revision === s.confirmed, 30_000);
  const acks = await run(({ docKey, documentId }) => {
    const trace = globalThis.__sidecarNative07;
    return trace.docKey === docKey
      ? trace.acks.filter(ack => ack.type === "saved" && ack.documentId === documentId)
      : [];
  }, { docKey: savedState.docKey, documentId: savedState.documentId });
  const matchingAck = acks.filter(ack => ack.revision === savedState.revision && ack.external === true).at(-1);
  assert.ok(matchingAck, `A durable external save acknowledgement must match Viewer revision ${savedState.revision}`);
  const ck = await wait(`WAL replay ${label}`, checkpoint, evidence => {
    const rows = evidence?.annotations || [];
    const typesMatch = JSON.stringify(rows.map(row => row.kind).sort()) === JSON.stringify([...expectedTypes].sort());
    return typesMatch && evidence.protocol === 'wal-sidecar-v3.2-jsonl' && evidence.durableWal?.status === "replayed";
  });
  assert.deepEqual(ck.annotations.map(row => row.kind).sort(), [...expectedTypes].sort(),
    "Independently replayed durable annotation kinds must match the expected state");
  assert.equal(new Set(ck.annotations.map(row => row.uuid)).size, ck.annotations.length,
    "Independent WAL replay must retain unique annotation UUIDs");
  for (const row of ck.annotations) {
    assert.ok(row.uuid && row.kind && Number.isSafeInteger(row.pageIndex), "Persisted annotation identity, kind, and page must be present");
    assert.ok(row.payload && typeof row.payload === "object", "Persisted annotation payload must be retained for readback");
  }
  for (const row of ck.annotations.filter(annotation => annotation.kind === "FreeText")) {
    assert.equal(row.payload.editor?.value, text, "FreeText text must survive an independent WAL readback");
    assert.ok(Array.isArray(row.payload.editor?.rect) && row.payload.editor.rect.length === 4 &&
      row.payload.editor.rect.every(Number.isFinite), "FreeText PDF geometry must survive an independent WAL readback");
  }
  assert.equal(savedState.revision, savedState.confirmed, "Viewer revision must be confirmed before persistence evidence is accepted");
  report.stages.push({ label, state: savedState, matchingSaveAck: matchingAck, checkpoint: ck, hashes: await sourceHashes(label) });
  console.log(`Native sidecar stage: ${label}`);
  assert.deepEqual(report.stages.at(-1).hashes, report.sourceBefore);
  return ck;
}
async function controlledDetach(label, targetToken = null, expectedRemaining = 0) {
  const maintenanceOffset = await run(() => globalThis.__sidecarNative07.maintenance.length);
  const evidence = await completeNativeControlledClose({ runSerialized: run, waitFor: wait,
    loadFiles: dir => tree(dir, { rejectPending: true }), readWalEvidence: readNativeWalEvidence, hash: verifyHash,
    filePath: file, targetToken, expectedRemaining, label, maintenanceOffset,
    isolatedRoot: isolatedStoreRoot, virtualRoot: storeRoot });
  (report.controlledCloses ||= []).push(evidence);
  return evidence;
}
async function close() {
  const result = await controlledDetach("Reader controlled close");
  assert.equal(result.alreadyAbsent, undefined, "Reader controlled close requires the exact fixture Reader to be open");
  assert.equal(result.before.protocol, 'wal-sidecar-v3.2-jsonl');
  assert.equal(result.walAfterClose.walStatus, 'replayed');
  return result;
}
async function closeFailedFixtureSafely() {
  const active = await run(p => [...app.plugins.plugins["pdf-web-reader"].views].filter(view => view.requestedPath === p).length, file);
  if (active > 0) return controlledDetach("Failure-path controlled close", null, 0);
  const priorClose = [...(report.controlledCloses || [])].reverse().find(item =>
    item.ok && item.remaining === 0 && item.maintenance?.event === "annotation-snapshot-materialized");
  if (priorClose) return { alreadyAbsent: true, quiescedBy: priorClose.label, maintenance: priorClose.maintenance };
  const session = await run(() => {
    const trace = globalThis.__sidecarNative07, plugin = app.plugins.plugins["pdf-web-reader"];
    return { docKey: trace?.docKey, documentId: trace?.documentId, sourceHash: trace?.sourceHash,
      protocol: trace?.protocol || plugin.annotationHost?.store?.sourceProtocol || null,
      latestAckAt: trace?.acks.at(-1)?.at || 0 };
  });
  if (!session.docKey || !session.documentId) return { alreadyAbsent: true, noOpenedDocument: true };
  if (!session.protocol?.startsWith("wal-sidecar-v3.")) return { alreadyAbsent: true, noWalMaintenanceExpected: true, session };
  const maintenance = await wait("failure-path background annotation maintenance settled", () => run(nativeMaintenanceTerminal,
    { documentId: session.documentId, offset: 0 }), row => Boolean(row && row.receivedAt > session.latestAckAt), 20_000);
  const wal = await readNativeWalEvidence({ files: await tree(isolatedStoreRoot, { rejectPending: true }), isolatedRoot: isolatedStoreRoot,
    virtualRoot: storeRoot, docKey: session.docKey, documentId: session.documentId,
    sourceHash: session.sourceHash, viewerRevision: report.failureState?.revision ?? 0,
    confirmedViewerRevision: report.failureState?.confirmed ?? 0, hash: verifyHash });
  assertNativeCloseEvidence({ viewCount: 0, maintenance, wal, isolatedRoot: isolatedStoreRoot });
  return { alreadyAbsent: true, maintenance, walAfterClose: { snapshotStatus: wal.snapshot?.status, walStatus: wal.durableWal?.status } };
}
async function exportCopy(expectedTypes) {
  const expectedRows = (await stableCheckpoint("checkpoint before controlled close")).annotations;
  const expectedPath = `${folder}/immutable-source (PDF Reader Export).pdf`;
  const targetState = await run(async p => ({
    exists: await app.vault.adapter.exists(p),
    indexed: Boolean(app.vault.getAbstractFileByPath(p)),
  }), expectedPath);
  assert.deepEqual(targetState, { exists: false, indexed: false },
    "The exact fixture export target must not exist before the test-only write permit is granted");
  report.exportAuthorization = { path: expectedPath, initiallyAbsent: true };
  run(p=>{const t=globalThis.__sidecarNative07;t.exportAllowed=true;t.exportAllowedPath=p;t.exportTargetWasAbsent=true;return true;},expectedPath);
  let exported;
  try {
    exported=await run(async p=>{const v=[...app.plugins.plugins['pdf-web-reader'].views].find(v=>v.requestedPath===p);return await v.exportAnnotatedCopy();},file);
  } finally {
    run(()=>{const t=globalThis.__sidecarNative07;t.exportAllowed=false;t.exportTargetWasAbsent=false;return true;});
  }
  assert.equal(exported,expectedPath,'Only the predeclared, initially absent export path is permitted');
  const exportBytes=await readFile(absolute(exported)), pdf=await PDFDocument.load(exportBytes), annotations=[];
  const supported=['Underline','Square','Highlight','Ink','FreeText'];
  for(const [pageIndex,page] of pdf.getPages().entries()){const list=page.node.Annots();if(!list)continue;for(let i=0;i<list.size();i++){const dict=list.lookup(i), subtype=dict.get(PDFName.of('Subtype'))?.toString().slice(1);if(supported.includes(subtype))annotations.push({pageIndex,subtype,rect:dict.get(PDFName.of('Rect'))?.toString(),contents:dict.get(PDFName.of('Contents'))?.decodeText?.()});}}
  assert.deepEqual(annotations.map(x=>x.subtype).sort(),[...expectedTypes].sort());
  for (const annotation of annotations) {
    const row = expectedRows.find(row => row.kind === annotation.subtype && row.pageIndex === annotation.pageIndex);
    assert.ok(row, 'Each exported annotation must retain its acknowledged kind and page');
    const rect = annotation.rect?.replace(/[\[\]]/g, '').trim().split(/\s+/).map(Number);
    assert.ok(rect?.length === 4 && rect.every(Number.isFinite));
    assert.ok(rect.every((value, index) => Math.abs(value-row.payload.editor.rect[index]) < 0.01),
      'Explicit PDF export must preserve the acknowledged PDF rectangle');
    if (row.kind === 'FreeText') assert.equal(annotation.contents, row.payload.editor.value);
  }
  report.export={path:exported,hashes:hashes(exportBytes),annotations,authorization:report.exportAuthorization};
  report.sourceAfter=await sourceHashes('after-explicit-export');assert.deepEqual(report.sourceAfter,report.sourceBefore);
}
function decodePng(buffer) {
  const chunks = []; let width, height, channels;
  for (let p = 8; p < buffer.length;) {
    const size = buffer.readUInt32BE(p), type = buffer.toString("ascii", p + 4, p + 8), data = buffer.subarray(p + 8, p + 8 + size);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[8], 8); channels = ({ 2: 3, 6: 4 })[data[9]]; assert.ok(channels); }
    if (type === "IDAT") chunks.push(data);
    p += 12 + size;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, pixels = Buffer.alloc(stride * height);
  const paeth = (a,b,c) => { const p=a+b-c, aa=Math.abs(p-a), bb=Math.abs(p-b), cc=Math.abs(p-c); return aa<=bb&&aa<=cc?a:bb<=cc?b:c; };
  for(let y=0;y<height;y++) { const filter=raw[y*(stride+1)]; for(let x=0;x<stride;x++) { const a=x>=channels?pixels[y*stride+x-channels]:0,b=y?pixels[(y-1)*stride+x]:0,c=y&&x>=channels?pixels[(y-1)*stride+x-channels]:0; const v=raw[y*(stride+1)+1+x]; pixels[y*stride+x]=(v+([0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter]))&255; } }
  return { width, height, channels, pixels };
}
async function screenshot(name) {
  const image = nativeCdp("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  const bytes = Buffer.from(image.data, "base64"), output = path.join(artifacts, `sidecar-native-${stamp}-${name}.png`);
  await writeFile(output, bytes); return { output, bytes };
}
async function freeTextVisual(label) {
  const before = await state();
  const ft = before.editors.find(e => e.type === 3);
  assert.ok(ft?.rect.width > 0 && ft.rect.height > 0 && ft.text?.includes("SIDECAR NATIVE"));
  assert.equal(ft.text, text, 'The composed FreeText DOM must contain the complete acknowledged text');
  assert.notEqual(ft.display, "none"); assert.notEqual(ft.visibility, "hidden"); assert.ok(Number(ft.opacity) > 0);
  await doc(({ d, arg }) => { const e=d.getElementById(arg); e.dataset.nativePriorVisibility=e.style.visibility; e.style.visibility="hidden"; return true; }, ft.id);
  let hidden;
  try { hidden = await screenshot(`${label}-hidden-reference`); }
  finally { await doc(({d,arg})=>{const e=d.getElementById(arg);e.style.visibility=e.dataset.nativePriorVisibility;delete e.dataset.nativePriorVisibility;return true;},ft.id); }
  const visible = await screenshot(`${label}-visible`);
  const roi = await doc(({v,d,arg})=>{const r=d.getElementById(arg).getBoundingClientRect(),f=v.iframe.getBoundingClientRect();return {x:r.x+f.x,y:r.y+f.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight};},ft.id);
  const a=decodePng(hidden.bytes), b=decodePng(visible.bytes); assert.equal(a.width,b.width); assert.equal(a.height,b.height);
  const sx=a.width/roi.viewportWidth, sy=a.height/roi.viewportHeight; let changed=0;
  for(let y=Math.max(0,Math.floor(roi.y*sy));y<Math.min(a.height,Math.ceil((roi.y+roi.height)*sy));y++) for(let x=Math.max(0,Math.floor(roi.x*sx));x<Math.min(a.width,Math.ceil((roi.x+roi.width)*sx));x++){const p=(y*a.width+x)*a.channels;if([0,1,2].some(c=>Math.abs(a.pixels[p+c]-b.pixels[p+c])>24))changed++;}
  assert.ok(changed>20, `FreeText composite ROI has only ${changed} differing pixels`);
  report.stages.push({label,freeText:ft,roi,changedPixels:changed,visibleScreenshot:visible.output,hiddenReference:hidden.output});
}

async function underlineVisual(label) {
  const info = await doc(({ v, d, w, a }) => {
    const m=a.pdfViewer._layerProperties.annotationEditorUIManager;
    const editors=[...d.querySelectorAll('.annotationEditorLayer > div[id]')].filter(e=>m.getEditor(e.id)?.constructor._editorType===10);
    const f=v.iframe.getBoundingClientRect();
    return editors.map(e=>{const r=e.getBoundingClientRect(),s=w.getComputedStyle(e);return{id:e.id,x:r.x+f.x,y:r.y+f.y,width:r.width,height:r.height,display:s.display,visibility:s.visibility,opacity:s.opacity};});
  });
  assert.ok(info.length>0 && info.every(e=>e.width>0&&e.height>0&&e.display!=='none'&&e.visibility!=='hidden'&&Number(e.opacity)>0));
  const visible=await screenshot(`${label}-visible`);
  // Underline appearance lives in the draw layer, not necessarily the editor div.
  const hiddenCount=await doc(({d})=>{const rows=[...d.querySelectorAll('.canvasWrapper svg')];for(const e of rows){e.dataset.nativeVisibility=e.style.visibility;e.style.visibility='hidden';}return rows.length;});
  assert.ok(hiddenCount>0,'The fixture must contain an actual drawing SVG');
  let hidden;
  try {hidden=await screenshot(`${label}-hidden-reference`);}
  finally {await doc(({d})=>{for(const e of d.querySelectorAll('.canvasWrapper svg')){e.style.visibility=e.dataset.nativeVisibility;delete e.dataset.nativeVisibility;}return true;});}
  const a=decodePng(visible.bytes),b=decodePng(hidden.bytes);
  const viewport=run(()=>({width:innerWidth,height:innerHeight}));
  const sx=a.width/viewport.width,sy=a.height/viewport.height;let changed=0;
  for(const r of info)for(let y=Math.max(0,Math.floor((r.y-3)*sy));y<Math.min(a.height,Math.ceil((r.y+r.height+3)*sy));y++)for(let x=Math.max(0,Math.floor((r.x-3)*sx));x<Math.min(a.width,Math.ceil((r.x+r.width+3)*sx));x++){const i=(y*a.width+x)*a.channels;if([0,1,2].some(c=>Math.abs(a.pixels[i+c]-b.pixels[i+c])>24))changed++;}
  assert.ok(changed>10,`Underline composite appearance has only ${changed} differing pixels`);
  report.stages.push({label,editors:info,changedPixels:changed,visibleScreenshot:visible.output,hiddenReference:hidden.output});
}

async function createNativeUnderline(label, index, multiline=false) {
  await mode(1,10);
  const expected=(await state()).editors.filter(e=>e.type===10).length+1;
  const consumerCount=await doc(()=>globalThis.__sidecarNative07.nativeSelectionProbe.consumers.length);
  await doc(async ({d,w,arg})=>{
    const c=d.getElementById('viewerContainer');c.scrollLeft=0;
    const spans=[...d.querySelectorAll('.page[data-page-number="1"] .textLayer span')].filter(e=>e.textContent.trim().length>35&&e.getBoundingClientRect().width>100);
    const e=spans[arg];if(!e)throw Error('Visible fixture line missing');
    c.scrollTop+=e.getBoundingClientRect().y-c.getBoundingClientRect().y-c.clientHeight/2;
    await new Promise(resolve=>w.requestAnimationFrame(()=>w.requestAnimationFrame(resolve)));
    return true;
  },index);
  const line=await doc(({v,d,w,arg})=>{
    const f=v.iframe.getBoundingClientRect();
    const spans=[...d.querySelectorAll('.page[data-page-number="1"] .textLayer span')].filter(e=>e.textContent.trim().length>35&&e.getBoundingClientRect().width>100);
    const first=spans[arg.index],r=first?.getBoundingClientRect();if(!r)throw Error('Fixture line missing');
    const next=arg.multiline?spans.slice(arg.index+1).find(e=>{const t=e.getBoundingClientRect();return t.y>r.y&&t.y-r.y<35&&Math.abs(t.x-r.x)<20;}):first;
    if(!next)throw Error('Adjacent fixture line missing');const s=next.getBoundingClientRect();
    const glyph=(e,offset)=>{const range=d.createRange();range.setStart(e.firstChild,offset);range.setEnd(e.firstChild,offset+1);return range.getBoundingClientRect();};
    const firstGlyph=glyph(first,5);let endOffset=Math.min(40,next.textContent.length-2),lastGlyph=glyph(next,endOffset);
    while(lastGlyph.right>f.width-60&&endOffset>12)lastGlyph=glyph(next,--endOffset);
    if(firstGlyph.left<35||lastGlyph.right>f.width-50||r.y<50||s.bottom>f.height-50)throw Error('Selection fixture must be fully visible away from auto-scroll edges');
    if(!first.id)first.id=`native-selection-line-${arg.index}`;
    if(!next.id)next.id=`native-selection-line-${arg.index}-end`;
    return {from:{x:f.x+firstGlyph.left+.5,y:f.y+firstGlyph.y+firstGlyph.height/2},to:{x:f.x+lastGlyph.right-.5,y:f.y+lastGlyph.y+lastGlyph.height/2},
      fromId:first.id,toId:next.id,
      firstText:first.textContent,lastText:next.textContent,iframe:{x:f.x,y:f.y,width:f.width,height:f.height},
      fontSize:w.getComputedStyle(first).fontSize,dpr:w.devicePixelRatio};
  },{index,multiline});
  report.stages.push({label:`${label}-drag`,line});
  await drag(line.from,line.to);
  await wait(`Native Underline ${label}`,state,s=>s.editors.filter(e=>e.type===10).length===expected);
  const consumed=await doc(({arg})=>{const p=globalThis.__sidecarNative07.nativeSelectionProbe;return p.consumers.slice(arg).filter(x=>x.mode===10&&x.before.collapsed===false&&x.before.textLength>0);},consumerCount);
  assert.ok(consumed.length>0,'A real noncollapsed selection must reach the Underline consumer');
  assert.ok(consumed.some(c=>c.before.ranges[0]?.start?.id===line.fromId&&c.before.ranges[0]?.end?.id===line.toId),'The range must stay on the intended one/two fixture lines, not auto-scroll across paragraphs');
  assert.ok(consumed.every(c=>c.before.textLength<=(multiline?line.firstText.length+line.lastText.length+4:line.firstText.length)),'A one/two-line gesture must not select entire paragraphs');
  const ck=await saved(label,Array(expected).fill('Underline'));
  report.stages.push({label:`${label}-selection`,consumed});
  return ck;
}

async function independentReaderLifecycle() {
  report.readerLifecycle=await run(async p=>{
    const plugin=app.plugins.plugins['pdf-web-reader'];
    const first=[...plugin.views].find(v=>v.requestedPath===p);
    const leaf=app.workspace.getLeaf(true);
    await leaf.setViewState({type:'pdf-web-reader-view',active:true,state:{path:p}});
    const second=[...plugin.views].find(v=>v!==first&&v.requestedPath===p);
    if(!second)throw Error('Second independent Reader was not created');
    globalThis.__sidecarNative07.lifecycleFirst=first;
    globalThis.__sidecarNative07.lifecycleSecond=second;
    return {firstToken:first.token,secondToken:second.token};
  },file);
  await wait('Reader B text layer alive before A closes',()=>run(()=>{
    const v=globalThis.__sidecarNative07.lifecycleSecond,a=v.iframe?.contentWindow?.PDFViewerApplication;
    return v.ready&&a?.pdfViewer?.getPageView(0)?.renderingState===3&&!!v.iframe.contentDocument.querySelector('.textLayer span');
  }));
  Object.assign(report.readerLifecycle,run(()=>{
    const {lifecycleFirst:a,lifecycleSecond:b}=globalThis.__sidecarNative07;
    return {distinctIframe:a.iframe!==b.iframe,distinctDocument:a.iframe.contentDocument!==b.iframe.contentDocument,
      firstClean:!a.pendingSaves&&a.currentRevision===a.confirmedRevision};
  }));
  assert.ok(report.readerLifecycle.distinctDocument&&report.readerLifecycle.firstClean);
  await controlledDetach("Reader A lifecycle detach", report.readerLifecycle.firstToken, 1);
  await wait('A fully detached while B remains',()=>run(p=>[...app.plugins.plugins['pdf-web-reader'].views].filter(v=>v.requestedPath===p).length,file),n=>n===1);
  await open();
  assert.equal(await doc(({v})=>v.token),report.readerLifecycle.secondToken);
  report.readerLifecycle.firstClosedBeforeSecondDrag=true;
}

try {
  report.installedTripletBefore=await installedTriplet();
  const preflight = run(() => ({ vault: app.vault.adapter.basePath, vaultName: app.vault.getName?.() || null,
    configDir: app.vault.configDir, pluginEnabled: app.plugins.enabledPlugins.has("pdf-web-reader"),
    pluginVersion: app.plugins.plugins["pdf-web-reader"].manifest.version,
    readerViews: [...app.plugins.plugins["pdf-web-reader"].views].map(v=>({path:v.requestedPath,
      revision:v.currentRevision,confirmed:v.confirmedRevision,pending:v.pendingSaves,
      dirty:!!v.iframe?.contentWindow?.PDFViewerApplication?._hasChanges?.()})),
    visibility: document.visibilityState }));
  assertNativeTestPreflight(preflight, expectedVersion); report.preflight=preflight;
  report.vaultIdentity = { path: preflight.vault, name: preflight.vaultName, configDir: preflight.configDir };
  report.runtimeVersion = preflight.pluginVersion;
  report.bundleSha256 = report.installedTripletBefore["main.js"].sha256;
  report.installedBundle = report.installedTripletBefore;
  nativeCdp("Emulation.setFocusEmulationEnabled", {enabled:true});
  await mkdir(absolute(folder), {recursive:true});
  if(scenario==='benchmark-large'){
    const generated=path.join(artifacts,'sidecar-120-page-16mib-fixture.pdf');
    let bytes=await readFile(generated).catch(()=>null);
    if(!bytes){const pdf=await PDFDocument.create();for(let i=0;i<120;i++){const p=pdf.addPage([420,540]);p.drawText(`Large benchmark page ${i+1}`,{x:25,y:470,size:15});}await pdf.attach(randomBytes(16*1024*1024),'synthetic-random-data.bin');bytes=await pdf.save({useObjectStreams:false});await writeFile(generated,bytes,{flag:'wx'});}
    await copyFile(generated,absolute(file),constants.COPYFILE_EXCL);
    report.fixtureProvenance='New 120-page synthetic fixture, 16 MiB incompressible attachment; same historical recipe, NOT identical historical bytes and NOT historical A/B';
  }else await copyFile(path.join(root,"tests/fixtures/tracemonkey.pdf"),absolute(file),constants.COPYFILE_EXCL);
  report.sourceBefore=await sourceHashes('initial');
  report.fixtureHash = report.sourceBefore;
  instrumented=true;
  run(async ({file,prefix,protectedPaths,isolatedRoot,fixtureFolder})=>{
    assertNativeFixtureScope({file,fixtureFolder});
    if(globalThis.__sidecarNative07)throw Error("Previous Native instrumentation still present");
    const a=app.vault.adapter, p=app.plugins.plugins["pdf-web-reader"], protectedSet=new Set(protectedPaths), originals=[];
    const originalAdapterExists=a.exists;
    const trace=globalThis.__sidecarNative07={file,prefix,isolatedRoot,fixtureFolder,clockOrigin:performance.timeOrigin,viewerWindows:new Map(),viewerTimings:[],viewerLogLosses:[],storeTimings:[],maintenance:[],io:[],listMappings:[],acks:[],pointers:[],messages:[],listeners:[],pdfSerializations:[],sourceWriteAttempts:[],pdfWriteAttempts:[],blockedExistingWrites:[],exportAllowed:false,exportAllowedPath:null,exportTargetWasAbsent:false,originals};
    const pathString=value=>typeof value==='string'?value:String(value?.path||'');
    const isPdfPath=value=>/\.pdf$/i.test(pathString(value));
    const isApprovedExport=async target=>trace.exportAllowed===true&&trace.exportTargetWasAbsent===true&&target===trace.exportAllowedPath&&typeof target==='string'&&target.startsWith(`${fixtureFolder}/`)&&isPdfPath(target)&&!(await originalAdapterExists.call(a,target));
    const assertPdfWrite=async(layer,name,target,allowedMethod)=>{if(!isPdfPath(target))return;const path=pathString(target);if(path===file){trace.sourceWriteAttempts.push({layer,name,path});throw Error('Source PDF mutation forbidden');}if(allowedMethod&&await isApprovedExport(path))return;trace.pdfWriteAttempts.push({layer,name,path,allowedPath:trace.exportAllowedPath});throw Error('PDF mutation outside the explicitly approved new-fixture export is forbidden');};
    const rawList=a.list;
    if(typeof rawList==='function'){originals.push({object:a,name:'list',original:rawList});a.list=async function(path,...args){const storageResult=await rawList.call(this,path,...args);const storeResult=mapNativeSidecarListResult(storageResult,isolatedRoot,prefix);if(path===isolatedRoot||String(path).startsWith(`${isolatedRoot}/`))trace.listMappings.push({storagePath:path,storageFiles:storageResult?.files||[],storageFolders:storageResult?.folders||[],storeFiles:storeResult?.files||[],storeFolders:storeResult?.folders||[]});return storeResult;};}
    const adapterPdfWriteMethods=['write','writeBinary','append','appendBinary','remove','rename','process','removeFile','update','copy','copyRecursive'];
    for(const name of adapterPdfWriteMethods){if(typeof a[name]!=='function')continue;const original=a[name];originals.push({object:a,name,original});a[name]=async function(...args){const paths=name==='rename'?[pathString(args[0]),pathString(args[1])]:['copy','copyRecursive'].includes(name)?[pathString(args[1])]:[pathString(args[0])];for(const target of paths)if(isPdfPath(target)){await assertPdfWrite('adapter',name,target,name==='writeBinary');break;}return original.apply(this,args);};}
    const vaultPdfWriteMethods=['modifyBinary','appendBinary','modify','append','createBinary','create','delete','rename','copy'];
    for(const name of vaultPdfWriteMethods){if(typeof app.vault[name]!=='function')continue;const original=app.vault[name];originals.push({object:app.vault,name,original});app.vault[name]=async function(target,...args){const paths=name==='rename'?[pathString(target),pathString(args[0])]:name==='copy'?[pathString(args[0])]:[pathString(target)];for(const path of paths)if(isPdfPath(path)){await assertPdfWrite('vault',name,path,name==='createBinary');break;}return original.call(this,target,...args);};}
    trace.messageListener=e=>{const v=[...p.views].find(v=>v.requestedPath===file);const expected=trace.viewerWindows.get(e.source)||(e.source===v?.iframe?.contentWindow?v.token:null);if(!expected||e.data?.channel!=='pdf-web-reader'||e.data.token!==expected)return;if(['save','recover'].includes(e.data.type))trace.messages.push({at:performance.now(),type:e.data.type,revision:e.data.revision,requestId:e.data.requestId,operations:e.data.operations?.length??e.data.annotationOperations?.length,encodedBytes:new TextEncoder().encode(JSON.stringify(e.data)).length});if(e.data.type==='runtime-log'&&Array.isArray(e.data.rows))for(const raw of e.data.rows){try{const row=JSON.parse(raw);if(row.kind==='sidecar-performance')trace.viewerTimings.push({...row,receivedAt:performance.now()});else if(row.kind==='log-loss')trace.viewerLogLosses.push({...row,receivedAt:performance.now()});}catch{}}};window.addEventListener('message',trace.messageListener);
    const record=p.sessionLog.record;originals.push({object:p.sessionLog,name:'record',original:record});p.sessionLog.record=function(kind,fields){if(kind==='annotationStore'&&fields?.event==='annotation-performance')trace.storeTimings.push({...fields,receivedAt:performance.now()});if(kind==='annotationStore'&&['annotation-snapshot-materialized','annotation-snapshot-sync-pending','annotation-snapshot-materialize-failed'].includes(fields?.event))trace.maintenance.push({...fields,receivedAt:performance.now()});return record.call(this,kind,fields);};
    const adapterMethods=["read","write","readBinary","writeBinary","append","appendBinary","remove","rename","exists","mkdir","list","process","removeFile","update","copy","copyRecursive"];
    for(const name of adapterMethods){if(typeof a[name]!=="function")continue;const original=a[name];originals.push({object:a,name,original});a[name]=async function(...args){const target=String(args[0]||'');const mappedArgs=mapNativeSidecarAdapterArgs(name,args,prefix,isolatedRoot);const mappedTarget=String(mappedArgs[0]||'');const writing=!["read","readBinary","exists","list"].includes(name);if(writing&&(target===file||String(args[1]||'')===file)){trace.sourceWriteAttempts.push({name,target});throw Error("Source PDF mutation forbidden");}if(writing&&!mappedTarget.startsWith(isolatedRoot)&&protectedSet.has(target)){trace.blockedExistingWrites.push(target);throw Error("Existing annotation data is protected");}if(name==='rename'&&protectedSet.has(String(args[1]))&&!String(mappedArgs[1]||'').startsWith(isolatedRoot)){trace.blockedExistingWrites.push(String(args[1]));throw Error('Existing target protected');}const t=performance.now();try{const result=await original.apply(this,mappedArgs);if(target===file||target===prefix||target.startsWith(prefix+'/'))trace.io.push({name,path:target,storagePath:mappedTarget,at:t,ms:performance.now()-t,bytes:typeof args[1]==='string'?new TextEncoder().encode(args[1]).length:args[1]?.byteLength??(typeof result==='string'?new TextEncoder().encode(result).length:result?.byteLength??0)});return result;}catch(e){trace.io.push({name,path:target,storagePath:mappedTarget,at:t,error:String(e)});throw e;}};}
    for(const name of ['modifyBinary','appendBinary','modify','append','createBinary','create','delete','rename']){if(typeof app.vault[name]!=='function')continue;const original=app.vault[name];originals.push({object:app.vault,name,original});app.vault[name]=function(target,...args){if(String(target?.path||target)===file){trace.sourceWriteAttempts.push({name,path:file});throw Error('Source PDF mutation forbidden');}return original.call(this,target,...args);};}
    return true;
  },{file,fixtureFolder:folder,prefix:storeRoot,isolatedRoot:isolatedStoreRoot,protectedPaths:[...protectedFiles.keys()]});
  await open();
  if(benchmarking){
    report.benchmark=[];
    await mode(2,5);
    for(let i=0;i<10;i++){
      await drag(await point(.14+i*.025,.28+i*.012),await point(.25+i*.025,.34+i*.012));
      await wait('benchmark Square created',state,s=>s.editors.filter(e=>e.type===5).length===i+1);
      const ck=await saved(`benchmark-${i+1}`,Array(i+1).fill('Square'));
      report.benchmark.push({edit:i+1,viewerRevision:ck.viewer.revision,walWatermarkTotal:ck.walWatermarkTotal,
        checkpointBytes:ck.checkpointBytes,heap:nativeCdp('Runtime.getHeapUsage')});
    }
    if(process.env.PDF_READER_REQUIRE_PHASE_TIMINGS==='1'){
      await wait('independent phase telemetry delivered',()=>run(()=>{const t=globalThis.__sidecarNative07;return{capture:t.viewerTimings.filter(x=>x.phase==='capture'&&x.status==='ok').length,encode:t.viewerTimings.filter(x=>x.phase==='encode'&&x.status==='ok').length,gc:t.storeTimings.filter(x=>x.phase==='gc'&&x.docKey===t.docKey).length};}),s=>s.capture>=10&&s.encode>=10&&s.gc>0,8_000);
    }
    await close(); report.status='passed';
  }else if(scenario==='underline'){
    await independentReaderLifecycle();
    await createNativeUnderline('underline-single',5);
    const initial=(await stableCheckpoint("initial Underline checkpoint")).annotations.map(r=>r.uuid);
    await close();await open();
    await wait('Underline hydrated after reopen',state,s=>s.editors.filter(e=>e.type===10).length===1);
    assert.deepEqual((await stableCheckpoint("reopened Underline checkpoint")).annotations.map(r=>r.uuid),initial);
    await underlineVisual('underline-after-reopen');
    await createNativeUnderline('underline-adjacent',6);
    await createNativeUnderline('underline-multiline',9,true);
    const all=(await stableCheckpoint("three Underline checkpoint")).annotations.map(r=>r.uuid);assert.equal(new Set(all).size,3);
    await close();await open();
    await wait('Three Underlines hydrate without duplication',state,s=>s.editors.filter(e=>e.type===10).length===3);
    assert.deepEqual((await stableCheckpoint("reopened three Underline checkpoint")).annotations.map(r=>r.uuid).sort(),all.sort());
    await underlineVisual('underline-three-after-reopen');
    await close();report.status='passed';
  }else{
  // Validate a non-zero real FreeText before any other tool can fail.
  await mode(5,3); await click(await point(.56,.22));
  await wait('FreeText focused',()=>doc(({d})=>d.activeElement?.matches('.freeTextEditor .internal[contenteditable="true"]')));
  nativeCdp('Input.insertText',{text});
  await button('#editorFreeTextButton');
  await saved('freetext-created',['FreeText']);
  await freeTextVisual('freetext-created');
  if(scenario==='freetext'){
    const uuid=(await stableCheckpoint("created FreeText checkpoint")).annotations[0].uuid;
    const createdRect=(await state()).editors.find(e=>e.type===3).serialized.rect;
    await close(); await open();
    await wait('FreeText hydrated',state,s=>s.editors.some(e=>e.type===3));
    assert.equal((await stableCheckpoint("reopened FreeText checkpoint")).annotations[0].uuid,uuid);
    await freeTextVisual('freetext-after-reopen');
    report.freeTextUuid=uuid;
    const reopenedRect=(await state()).editors.find(e=>e.type===3).serialized.rect;
    report.freeTextGeometry={createdRect,reopenedRect,maxDelta:Math.max(...createdRect.map((x,i)=>Math.abs(x-reopenedRect[i])))};
    assert.ok(report.freeTextGeometry.maxDelta<0.1,'FreeText must not move when hydrated from its persisted PDF rectangle');
    await exportCopy(['FreeText']);
    await close(); report.status='passed';
  }else{
  // Real trusted pointer drags select text, rather than injecting a Range.
  for(const [number,type,row] of [[1,10,5],[3,9,10]]){
    await mode(number,type);
    const line=await doc(({v,d,arg})=>{const f=v.iframe.getBoundingClientRect();const spans=[...d.querySelectorAll('.page[data-page-number="1"] .textLayer span')].filter(e=>e.textContent.trim().length>35&&e.getBoundingClientRect().width>100);const e=spans[arg];if(!e)throw Error('Fixture text line missing');const r=e.getBoundingClientRect();return {from:{x:f.x+r.x+2,y:f.y+r.y+r.height/2},to:{x:f.x+r.right-2,y:f.y+r.y+r.height/2},text:e.textContent};},row);
    await drag(line.from,line.to); await wait(`created ${type}`,state,s=>s.editors.some(e=>e.type===type));
  }
  await mode(2,5); await drag(await point(.18,.33),await point(.35,.41)); await wait('Square created',state,s=>s.editors.some(e=>e.type===5));
  await mode(4,15); await drag(await point(.65,.33),await point(.8,.39));
  await wait('five real editors',state,s=>JSON.stringify(s.editors.map(e=>e.type).sort((a,b)=>a-b))===JSON.stringify([3,5,9,10,15]));
  const five=['Underline','Square','Highlight','Ink','FreeText'];
  const first=await saved('five-tools',five); report.initialUuids=Object.fromEntries(first.annotations.map(r=>[r.kind,r.uuid]));
  await freeTextVisual('freetext-before-close');
  await close(); await open();
  await wait('five hydrated editors',state,s=>s.editors.length===5);
  assert.deepEqual(Object.fromEntries((await state()).snapshot.annotations.map(r=>[r.kind,r.uuid])),report.initialUuids);
  await freeTextVisual('freetext-after-reopen');
  // Move a saved Square through actual pointer input.
  const squareRows=(await stableCheckpoint("reopened Square checkpoint")).annotations.filter(row=>row.kind==='Square');
  const squareEditors=(await state()).editors.filter(editor=>editor.type===5);
  assert.equal(squareRows.length,1,'The persisted five-tool state must contain exactly one Square before moving it');
  assert.equal(squareEditors.length,1,'The reopened Viewer must contain exactly one Square before moving it');
  const squareUuid=report.initialUuids.Square;
  const squareRow=squareRows.find(row=>row.uuid===squareUuid);
  assert.ok(squareRow,'The reopened Square must retain its acknowledged UUID');
  const squareEditor=squareEditors[0],squareBefore=squareEditor.serialized.rect;
  const identityRectDelta=Math.max(...squareBefore.map((value,index)=>Math.abs(value-squareRow.payload.editor.rect[index])));
  assert.ok(identityRectDelta<0.1,'The original Square editor must map to the persisted UUID by its unchanged PDF geometry');
  report.squareMove={uuid:squareUuid,editorId:squareEditor.id,rectBefore:squareBefore,identityRectDelta};
  await doc(({a})=>{a.eventBus.dispatch('switchannotationeditormode',{mode:0});return true;});
  const modeZero=await wait('saved Square is hit-testable in mode NONE',async()=>{
    const sample=await doc(({a,d,arg})=>{
      const e=d.getElementById(arg.editorId),layer=e?.closest('.annotationEditorLayer'),r=e?.getBoundingClientRect();
      if(!e||!layer||!r)return null;
      const x=r.x+r.width/2,y=r.y+r.height/2,hit=d.elementFromPoint(x,y),style=getComputedStyle(e);
      return {mode:a.pdfViewer.annotationEditorMode,editorId:e.id,layerClass:layer.className,
        creationPriority:layer.classList.contains('creationPriority'),pointerEvents:style.pointerEvents,
        center:{x,y},hitTag:hit?.tagName||null,hitClass:typeof hit?.className==='string'?hit.className:null,
        hitEditor:hit===e||e.contains(hit),selected:e.classList.contains('selectedEditor'),explicitlyEditing:e.classList.contains('explicitlyEditing')};
    },{editorId:squareEditor.id});
    report.squareMove.modePreconditionLast=sample;
    return sample;
  },sample=>sample?.mode===0&&!sample.creationPriority&&sample.hitEditor);
  report.squareMove.modePrecondition=modeZero;
  const squarePoint=await doc(({v,arg})=>{const r=arg.center,f=v.iframe.getBoundingClientRect();return{x:f.x+r.x,y:f.y+r.y};},modeZero);
  await click(squarePoint);
  const selectedSquare=await wait('existing Square selected for native drag',async()=>{
    const sample=await doc(({a,d,arg})=>{
      const manager=a.pdfViewer._layerProperties.annotationEditorUIManager;
      const e=d.getElementById(arg.editorId),editor=e&&manager.getEditor(e.id),r=e?.getBoundingClientRect();
      if(!e||!editor||!r)return null;
      const x=r.x+r.width/2,y=r.y+r.height/2,hit=d.elementFromPoint(x,y);
      return {editorId:e.id,managerSelected:manager.isSelected(editor),selected:e.classList.contains('selectedEditor'),
        explicitlyEditing:e.classList.contains('explicitlyEditing'),mode:a.pdfViewer.annotationEditorMode,
        center:{x,y},hitTag:hit?.tagName||null,hitClass:typeof hit?.className==='string'?hit.className:null,
        hitEditor:hit===e||e.contains(hit),layerClass:e.closest('.annotationEditorLayer')?.className||null};
    },{editorId:squareEditor.id});
    report.squareMove.selectionPreconditionLast=sample;
    return sample;
  },sample=>sample?.managerSelected&&sample.selected&&sample.explicitlyEditing&&sample.hitEditor);
  report.squareMove.selectionPrecondition=selectedSquare;
  const moveTarget={x:squarePoint.x+20,y:squarePoint.y+14};
  await drag(squarePoint,moveTarget);
  await wait('original saved Square moved through trusted pointer input',state,s=>{
    const editor=s.editors.find(item=>item.id===squareEditor.id&&item.type===5);
    return !!editor&&JSON.stringify(editor.serialized.rect)!==JSON.stringify(squareBefore);
  });
  const movedState=await state();
  assert.equal(movedState.editors.filter(editor=>editor.type===5).length,1,'Moving the saved Square must not create a second Square');
  assert.equal(movedState.editors.find(editor=>editor.type===5)?.id,squareEditor.id,'The moved editor must be the original Square');
  const moveCheckpoint=await saved('square-moved',five);
  const persistedMovedSquare=moveCheckpoint.annotations.filter(row=>row.kind==='Square');
  assert.equal(persistedMovedSquare.length,1,'The moved WAL state must still contain one Square');
  assert.equal(persistedMovedSquare[0].uuid,squareUuid,'Moving the Square must preserve its original UUID');
  report.squareMove.rectAfter=movedState.editors.find(editor=>editor.id===squareEditor.id).serialized.rect;
  report.squareMove.persistedUuid=persistedMovedSquare[0].uuid;
  // The active Square tool intentionally draws over existing markup. Return
  // to NONE and prove the exact old Underline is selected before Delete.
  const underlineEditors=(await state()).editors.filter(editor=>editor.type===10);
  const underlineRows=(await stableCheckpoint("Underline before delete checkpoint")).annotations.filter(row=>row.kind==='Underline');
  assert.equal(underlineEditors.length,1); assert.equal(underlineRows.length,1);
  assert.equal(underlineRows[0].uuid,report.initialUuids.Underline);
  const underlineEditor=underlineEditors[0];
  assert.ok(underlineRows[0].payload.editor.rect.length===4&&
    underlineRows[0].payload.editor.rect.every(Number.isFinite),
    'The acknowledged Underline must retain its complete persisted PDF geometry');
  await doc(({a})=>{a.eventBus.dispatch('switchannotationeditormode',{mode:0});return true;});
  const underlinePoint=await wait('saved Underline is hit-testable in mode NONE',()=>doc(({v,d,a,arg})=>{
    const e=d.getElementById(arg),r=e?.getBoundingClientRect(),layer=e?.closest('.annotationEditorLayer');
    if(!e||!r||a.pdfViewer.annotationEditorMode!==0||layer?.classList.contains('creationPriority'))return null;
    const x=r.x+r.width/2,y=r.y+r.height/2,hit=d.elementFromPoint(x,y),f=v.iframe.getBoundingClientRect();
    return hit===e||e.contains(hit)?{x:f.x+x,y:f.y+y,editorId:e.id}:null;
  },underlineEditor.id));
  await click(underlinePoint);
  await wait('exact Underline selected before Delete',()=>doc(({a,d,arg})=>{
    const manager=a.pdfViewer._layerProperties.annotationEditorUIManager,e=d.getElementById(arg),editor=e&&manager.getEditor(e.id);
    return !!editor&&editor.constructor._editorType===10&&manager.isSelected(editor)&&e.classList.contains('selectedEditor');
  },underlineEditor.id));
  // PDF.js may return null when serializing an unchanged hydrated markup
  // editor. Read its stable UUID through the existing capture protocol instead
  // of treating that changed-row optimization as missing annotation state.
  const captureRequestId=`native-delete-${traceRunId}`;
  const captureSession=await doc(({v,arg})=>{
    const t=globalThis.__sidecarNative07;
    const identity={documentId:v.documentId,openRequest:v.openRequest,rendererGeneration:v.rendererGeneration};
    const listener=e=>{
      const m=e.data;
      if(e.source!==v.iframe?.contentWindow||m?.channel!=='pdf-web-reader'||m.token!==v.token||
        m.type!=='reader-anchor-capture'||m.requestId!==arg||m.documentId!==identity.documentId||
        m.openRequest!==identity.openRequest||m.rendererGeneration!==identity.rendererGeneration)return;
      t.deleteCapture={...identity,requestId:arg,capture:m.capture||null,error:m.error||null};
      window.removeEventListener('message',listener,true);
    };
    window.addEventListener('message',listener,true);
    t.listeners.push({target:window,type:'message',listener});
    if(!v.postToViewer({channel:'pdf-web-reader',token:v.token,type:'reader-anchor-capture-request',
      mode:'annotation',requestId:arg,...identity}))throw Error('Native capture request was not sent');
    return identity;
  },captureRequestId);
  const capture=await wait('selected Underline stable UUID capture',()=>run(({requestId})=>{
    const value=globalThis.__sidecarNative07.deleteCapture;
    return value?.requestId===requestId?value:null;
  },{requestId:captureRequestId}));
  assert.equal(capture.error,null);
  assert.equal(capture.capture?.annotationUuid,report.initialUuids.Underline);
  assert.equal(capture.capture?.pageIndex,underlineRows[0].pageIndex);
  assert.equal(capture.capture?.sourceHash,(await state()).sourceHash);
  assert.equal(capture.documentId,captureSession.documentId);
  assert.ok(capture.capture.pageIdentity);
  report.deletePrecondition={uuid:report.initialUuids.Underline,editorId:underlineEditor.id,
    mode:'NONE-then-native-selection',capture};
  await key('Delete','Delete',46);
  const four=five.filter(t=>t!=='Underline'); await saved('delete',four);
  await button('#pdfReaderBridgeUndoButton'); await saved('undo',five);
  assert.equal((await stableCheckpoint("saved Underline checkpoint")).annotations.find(r=>r.kind==='Underline').uuid,report.initialUuids.Underline);
  await button('#pdfReaderBridgeRedoButton'); await saved('redo',four);
  await close(); await open(); await wait('final four hydrated',state,s=>s.editors.length===4);
  const final=await stableCheckpoint("final delete/undo/redo checkpoint"); assert.equal(final.tombstones.find(r=>r.kind==='Underline').uuid,report.initialUuids.Underline);
  report.finalUuids=Object.fromEntries(final.annotations.map(r=>[r.kind,r.uuid]));
  await exportCopy(four);
  await close(); report.status='passed';
  }
  }
} catch(error) {
  report.status='failed';report.error=error.stack||String(error);
  try{report.failureState=await state();}catch(e){report.failureStateError=String(e);}
  try{report.failureDom=await doc(({a,d,w})=>{
    const manager=a?.pdfViewer?._layerProperties?.annotationEditorUIManager;
    const squares=[...d.querySelectorAll('.annotationEditorLayer > div[id]')].filter(e=>manager?.getEditor(e.id)?.constructor._editorType===5);
    return {mode:a?.pdfViewer?.annotationEditorMode,currentPageNumber:a?.pdfViewer?.currentPageNumber,
      initialBookmark:a?.initialBookmark||null,pdfHistoryBookmark:a?.pdfHistory?.currentBookmark||null,
      loadingInProgress:a?.loadingInProgress??null,hasPdfDocument:!!a?.pdfDocument,
      squares:squares.map(e=>{const r=e.getBoundingClientRect(),hit=d.elementFromPoint(r.x+r.width/2,r.y+r.height/2),style=w.getComputedStyle(e),editor=manager.getEditor(e.id);return{
        id:e.id,rect:editor?.serialize?.(true)?.rect||null,className:e.className,pointerEvents:style.pointerEvents,
        selected:manager.isSelected(editor),explicitlyEditing:e.classList.contains('explicitlyEditing'),
        center:{x:r.x+r.width/2,y:r.y+r.height/2},hitTag:hit?.tagName||null,
        hitClass:typeof hit?.className==='string'?hit.className:null,hitEditor:hit===e||e.contains(hit),
        layerClass:e.closest('.annotationEditorLayer')?.className||null};})};
  });}catch(e){report.failureDomError=String(e);}
  try{report.failureScreenshot=(await screenshot('failure')).output;}catch(e){report.failureScreenshotError=String(e);}
  process.exitCode=1;
} finally {
  if (diagnoseTextCapture && report.status === "passed") report.status = "diagnostic-passed";
  let restoreInstrumentation = true;
  if (instrumented && report.status === "failed") {
    try { report.failureCleanup = await closeFailedFixtureSafely(); }
    catch (error) {
      report.failureCleanupError = String(error.stack || error);
      report.safetyGuardsRetained = true;
      restoreInstrumentation = false;
      process.exitCode = 1;
    }
  }
  if (instrumented) {
    try {
      const artifactMeta = run(async ({ tracePath, restoreWrappers }) => {
        const t = globalThis.__sidecarNative07;
        t.probeCleanup?.();
        const summarizeSelectionProbe = probe => ({
          active: probe.active,
          pointerEventCount: probe.pointerEvents.length,
          selectionChangeCount: probe.selectionChanges.length,
          capturePhaseEvents: probe.eventPhases.filter(event => event.capture).length,
          bubblePhaseEvents: probe.eventPhases.filter(event => !event.capture).length,
          consumers: probe.consumers.map(consumer => ({
            mode: consumer.mode,
            editorCount: consumer.editorCount,
            before: {
              collapsed: consumer.before.collapsed,
              rangeCount: consumer.before.rangeCount,
              textLength: consumer.before.textLength,
              ranges: consumer.before.ranges.map(range => ({
                startOffset: range.startOffset,
                endOffset: range.endOffset,
                collapsed: range.collapsed,
              })),
            },
            after: {
              collapsed: consumer.after.collapsed,
              rangeCount: consumer.after.rangeCount,
              textLength: consumer.after.textLength,
            },
          })),
          lastPointerEvent: probe.pointerEvents.at(-1)
            ? {
                type: probe.pointerEvents.at(-1).type,
                trusted: probe.pointerEvents.at(-1).trusted,
                pointerType: probe.pointerEvents.at(-1).pointerType,
                targetTextLayer: probe.pointerEvents.at(-1).targetTextLayer,
                selection: {
                  collapsed: probe.pointerEvents.at(-1).selection.collapsed,
                  rangeCount: probe.pointerEvents.at(-1).selection.rangeCount,
                  textLength: probe.pointerEvents.at(-1).selection.textLength,
                },
              }
            : null,
        });
        const out = {
          clockOrigin: t.clockOrigin,
          viewerTimings: t.viewerTimings,
          viewerLogLosses: t.viewerLogLosses,
          storeTimings: t.storeTimings.filter(x => x.docKey === t.docKey),
          maintenance: t.maintenance,
          selectionProbes: (t.selectionProbes || []).map(summarizeSelectionProbe),
          io: t.io.map(({ name, path, storagePath, ms, bytes, error }) => ({ name, path, storagePath, ms, bytes, error })),
          listMappings: t.listMappings,
          acks: t.acks.map(({ at, type, documentId, openRequest, revision, external,
            operationCount, batchId, requestId, code }) => ({ at, type, documentId,
            openRequest, revision, external, operationCount, batchId, requestId, code })),
          pointers: t.pointers.map(({ at, trusted, type, x, y }) => ({ at, trusted, type, x, y })),
          messages: t.messages,
          pdfSerializations: t.pdfSerializations,
          sourceWriteAttempts: t.sourceWriteAttempts,
          pdfWriteAttempts: t.pdfWriteAttempts,
          blockedExistingWrites: t.blockedExistingWrites,
        };
        window.removeEventListener('message', t.messageListener);
        for (const { target, type, listener } of t.listeners) target.removeEventListener(type, listener, true);
        if (restoreWrappers) {
          for (const { object, name, original } of t.originals.reverse()) object[name] = original;
          delete globalThis.__sidecarNative07;
        }
        const serialized = JSON.stringify(out);
        const adapter = app.vault.adapter;
        const folder = tracePath.slice(0, tracePath.lastIndexOf("/"));
        if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
        if (await adapter.exists(tracePath)) throw Error(`Refusing to overwrite Native trace artifact ${tracePath}`);
        await adapter.write(tracePath, serialized);
        const bytes = Buffer.byteLength(serialized, "utf8");
        const sha256 = require("node:crypto").createHash("sha256").update(serialized, "utf8").digest("hex");
        return { ok: true, artifactPath: tracePath, bytes, sha256, guardsRetained: !restoreWrappers };
      }, { tracePath: traceArtifactVaultPath, restoreWrappers: restoreInstrumentation });
      assert.equal(artifactMeta?.ok, true, "Native trace artifact write did not return an OK receipt");
      assert.equal(artifactMeta.artifactPath, traceArtifactVaultPath, "Native trace escaped its unique plugin test-output path");
      assert.ok(artifactMeta.artifactPath.startsWith(`${nativeConfig.configDir}/plugins/pdf-web-reader/.native-test-output/`));
      const traceBytes = await readFile(absolute(artifactMeta.artifactPath));
      assert.equal(traceBytes.byteLength, artifactMeta.bytes, "Native trace artifact byte count mismatch");
      assert.equal(sha(traceBytes), artifactMeta.sha256, "Native trace artifact SHA-256 mismatch");
      report.trace = JSON.parse(traceBytes.toString("utf8"));
      report.nativeTraceArtifact = {
        path: artifactMeta.artifactPath,
        bytes: artifactMeta.bytes,
        sha256: artifactMeta.sha256,
        verified: true,
        guardsRetained: artifactMeta.guardsRetained,
      };
    } catch (error) {
      report.instrumentationCleanupError = String(error);
    }
  }
  if (report.instrumentationCleanupError || report.failureCleanupError || report.trace?.sourceWriteAttempts.length ||
      report.trace?.pdfWriteAttempts.length ||
      report.trace?.blockedExistingWrites.length || report.trace?.pdfSerializations.some(x=>!x.exportAllowed)) {
    report.safetyGuardFailure='Native instrumentation cleanup, source-write, pre-existing-sidecar, or daily-serialization guard failed';
    report.status='failed';process.exitCode=1;
  }
  try{nativeCdp('Emulation.setFocusEmulationEnabled',{enabled:false});}catch{}
  if(report.sourceBefore){try{report.sourceAfter=await sourceHashes('final');if(JSON.stringify(report.sourceAfter)!==JSON.stringify(report.sourceBefore)){report.status='failed';process.exitCode=1;}}catch(e){report.sourceHashError=String(e);report.status='failed';process.exitCode=1;}}
  try {
    report.installedTripletAfter=await installedTriplet();
    assert.deepEqual(report.installedTripletAfter,report.installedTripletBefore,'Installed candidate changed during Native test');
  } catch(e) {report.installedTripletError=String(e);report.status='failed';process.exitCode=1;}
  report.protectedFiles=await Promise.all([...protectedFiles].map(async([p,b])=>({path:p,before:sha(b),after:sha(await readFile(absolute(p))),unchanged:sha(b)===sha(await readFile(absolute(p)))})));
  if(report.protectedFiles.some(x=>!x.unchanged)){report.status='failed';process.exitCode=1;}
  if (report.nativeTraceArtifact) {
    if (report.status === "passed") {
      try {
        await unlink(traceArtifactLocalPath);
        report.nativeTraceArtifact.cleaned = true;
      } catch (error) {
        report.nativeTraceArtifact.cleanupError = String(error);
        report.status = "failed";
        process.exitCode = 1;
      }
    } else {
      report.nativeTraceArtifact.retainedAsFailureEvidence = true;
    }
  }
  report.finishedAt=new Date().toISOString();await writeFile(resultPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:report.status,resultPath,error:report.error,sourceBefore:report.sourceBefore,sourceAfter:report.sourceAfter,sourceWriteAttempts:report.trace?.sourceWriteAttempts,pdfWriteAttempts:report.trace?.pdfWriteAttempts,pdfSerializations:report.trace?.pdfSerializations}));
}
