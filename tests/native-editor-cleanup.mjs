import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { nativeConfig, invokeNativeCli, nativeCdp, assertNativeVaultIdentity } from "./native-config.mjs";

// Explicit, isolated macOS acceptance. Never uses a user's existing PDF.
const root = path.resolve(import.meta.dirname, "..");
const version = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")).version;
const file = `PDF迁移测试/editor-cleanup-${Date.now()}.pdf`;
const ownedView = `app.workspace.getLeavesOfType('pdf-web-reader-view').find(l=>l.view.requestedPath===${JSON.stringify(file)})?.view`;
const report = { version, file, platform: "macOS Obsidian", physicalIpadValidated: false, checks: [] };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function run(body) {
  const expression = `(async()=>{if(app.vault.adapter.basePath!==${JSON.stringify(nativeConfig.vault)})throw Error('Wrong Vault');return JSON.stringify(await(async()=>{${body}})())})()`;
  const output = invokeNativeCli(["eval", `code=${expression}`], 30000);
  assert.ok(output.startsWith("=> "), output);
  return JSON.parse(output.slice(3));
}
function doc(body) {
  return run(`const v=${ownedView};if(!v)throw Error('Owned Reader missing');const w=v.iframe.contentWindow,d=w.document,a=w.PDFViewerApplication,m=a.pdfViewer._layerProperties.annotationEditorUIManager;${body}`);
}
async function wait(label, probe, predicate = Boolean) {
  const deadline = Date.now() + 30000;
  let value;
  do {
    value = await probe();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw Error(`${label}: ${JSON.stringify(value)}`);
}
const preflight = run(`return {vault:app.vault.adapter.basePath,configDir:app.vault.configDir,
  version:app.plugins.plugins['pdf-web-reader']?.manifest.version,visibility:document.visibilityState,
  readers:app.workspace.getLeavesOfType('pdf-web-reader-view').length};`);
assertNativeVaultIdentity(preflight);
assert.equal(preflight.version, version);
assert.equal(preflight.readers, 0);
assert.equal(preflight.visibility, "visible");
const settings = run(`const s=app.plugins.plugins['pdf-web-reader'].settings;return {autoSave:s.autoSave,vocabularyEnabled:s.vocabularyEnabled,lastAnnotationToolMode:s.lastAnnotationToolMode};`);
const pdf = await PDFDocument.create();
pdf.addPage([600,780]).drawText(`Independent Ink and LingQ fixture ${Date.now()}`, { x: 30, y: 730, size: 14 });
const bytes = await pdf.save();
report.sourceSha256 = hash(bytes);
let failure;
try {
  run(`const p=app.plugins.plugins['pdf-web-reader'];await p.setVocabularyEnabled(false);p.settings.autoSave=false;await p.saveData(p.settings);
    if(!app.vault.getAbstractFileByPath('PDF迁移测试'))await app.vault.createFolder('PDF迁移测试');
    const f=await app.vault.createBinary(${JSON.stringify(file)},new Uint8Array(${JSON.stringify([...bytes])}).buffer);await p.openPdf(f);return true;`);
  await wait("editable source identity", () => doc(`return {ready:v.ready,pending:v.annotationSyncPending,unavailable:v.annotationStorageUnavailable,allowed:v.annotationHydrationAllowed,layer:!!m?.getLayer(0)};`), value => value.ready && !value.pending && !value.unavailable && value.allowed && value.layer);
  const choose = async mode => {
    await wait("editor initialization", () => doc(`return !!m?.getLayer(0)&&a.pdfViewer.annotationEditorMode>=0;`));
    doc(`a.eventBus.dispatch('switchannotationeditormode',{source:w,mode:${mode},isFromKeyboard:true,createNewEditor:false});return true;`);
    await wait(`tool ${mode}`, () => doc(`return [a.pdfViewer.annotationEditorMode,m.getMode()];`), value => value.every(item => item === mode));
  };
  for (const mode of [10, 5, 9, 3, 15, 0]) await choose(mode);
  report.checks.push("all annotation modes switch with confirmed source identity");
  await choose(15);
  for (let n = 0; n < 2; n++) {
    const point = doc(`const r=m.getLayer(0).div.getBoundingClientRect(),c=d.getElementById('viewerContainer').getBoundingClientRect(),f=v.iframe.getBoundingClientRect();return {x:f.x+Math.max(r.left,c.left)+100,y:f.y+Math.max(r.top,c.top)+160+${n*90}};`);
    const pen = (type, offset, buttons) => nativeCdp("Input.dispatchMouseEvent", {
      type, x: point.x + offset, y: point.y + offset / 2,
      pointerType: "pen", button: "left", buttons, clickCount: type === "mousePressed" ? 1 : 0,
    });
    pen("mousePressed", 0, 1);
    for (let offset = 8; offset <= 48; offset += 8) pen("mouseMoved", offset, 1);
    pen("mouseReleased", 48, 0);
    doc(`m.getLayer(0).endDrawingSession(false);return true;`);
  }
  const count = () => doc(`return [...m.getEditors(0)].filter(e=>e.editorType==='ink'&&!e.deleted).length;`);
  assert.equal(await wait("two live Ink editors", count, value => value === 2), 2);
  assert.equal(doc(`return await a.save();`), true);
  report.saved = await wait("durable operation ACK", () => doc(`return {current:v.currentRevision,confirmed:v.confirmedRevision,pending:v.pendingSaves};`), value => value.current > 0 && value.current === value.confirmed && !value.pending);
  await choose(15);
  run(`await app.plugins.plugins['pdf-web-reader'].setVocabularyEnabled(true);return true;`);
  await wait("LingQ READ mode", () => doc(`return [a.pdfViewer.annotationEditorMode,m.getMode()];`), value => value.every(item => item === 0));
  assert.equal(count(), 2);
  report.checks.push("two real CDP pen strokes persist; enabling LingQ ends Ink at a safe boundary");
  await choose(0);
  assert.equal(doc(`return await a.save();`), true);
  run(`await ${ownedView}.leaf.detach();return true;`);
  await wait("closed Reader", () => run(`return !!${ownedView};`), value => !value);
  run(`await app.plugins.plugins['pdf-web-reader'].openPdf(app.vault.getAbstractFileByPath(${JSON.stringify(file)}));return true;`);
  await wait("reopened source identity", () => doc(`return v.ready&&!v.annotationSyncPending&&v.annotationHydrationAllowed;`));
  await choose(15);
  await wait("reopened Ink hydration", count, value => value === 2);
  report.checks.push("save, close and reopen retain both external Ink annotations");
  assert.equal(hash(await readFile(path.join(nativeConfig.vault, file))), report.sourceSha256);
  report.sourceUnchanged = true;
  report.status = "passed";
} catch (error) {
  failure = error;
  report.status = "failed";
  report.error = error.stack;
} finally {
  try {
    run(`const v=${ownedView};if(v&&v.currentRevision!==v.confirmedRevision)throw Error('Owned Reader remains dirty');if(v)await v.leaf.detach();
      const p=app.plugins.plugins['pdf-web-reader'];Object.assign(p.settings,${JSON.stringify(settings)});await p.saveData(p.settings);for(const view of p.views)view.setVocabularyEnabled(p.settings.vocabularyEnabled);return true;`);
  } catch (error) { report.cleanupError = error.stack; failure ||= error; }
  await mkdir(path.join(root, "tests/artifacts"), { recursive: true });
  await writeFile(path.join(root, "tests/artifacts/native-editor-cleanup.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
if (failure) throw failure;
