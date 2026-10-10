import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vault = "D:\\Documents\\Obsidian\\测试插件";
const cli = "D:\\Applications\\Obsidian\\Obsidian.com";
const relativePath = `PDF迁移测试/native-autosave-${Date.now()}.pdf`;
let diskPath = relativePath;
let absolutePath = path.join(vault, diskPath);
const quote = JSON.stringify;
const report = {
  version: "0.1.7",
  path: relativePath,
  focusEmulated: true,
  checks: {},
};
const lookup = `app.workspace.getLeavesOfType('pdf-web-reader-view').find(l=>l.view.requestedPath===${quote(relativePath)})`;
const view = `(${lookup}).view`;
const pdf = `${view}.iframe.contentWindow.PDFViewerApplication`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function cdp(method, params) {
  const result = spawnSync(
    cli,
    [
      "vault=d9f81db5f3fef6ee",
      "dev:cdp",
      `method=${method}`,
      `params=${JSON.stringify(params)}`,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const text = result.stdout;
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}
function evaluate(expression) {
  const result = cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text,
    );
  return result.result?.value;
}
const json = (expression) =>
  JSON.parse(evaluate(`JSON.stringify(${expression})`));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(description, probe) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await pause(250);
  }
  throw new Error(`Timed out: ${description}`);
}
async function open() {
  evaluate(`(()=>{if(app.setting?.isOpen)app.setting.close();})()`);
  evaluate(`app.workspace.openLinkText(${quote(relativePath)},'',true)`);
  await until("native PDF ready", () =>
    json(
      `(()=>{const l=${lookup};return !!l?.view?.iframe?.contentDocument?.querySelector('.page .textLayer span') && !!l.view.iframe.contentWindow.PDFViewerApplication.pdfDocument;})()`,
    ),
  );
  evaluate(
    `${view}.iframe.contentDocument.getElementById('viewerContainer').scrollTop=0`,
  );
}
function setColor(color) {
  evaluate(`(()=>{const v=${view}, w=v.iframe.contentWindow, p=w.PDFViewerApplication;
    const manager=p.pdfViewer._layerProperties.annotationEditorUIManager;
    const editor=[...w.document.querySelectorAll('.inkEditor')].map(el=>p.pdfDocument.annotationStorage.getRawValue(el.id)).find(e=>e?.constructor?._editorType===5);
    if(!editor)throw new Error('No editable square'); manager.setSelected(editor);
    const input=w.document.getElementById('editorSquareColor');input.value=${quote(color)};input.dispatchEvent(new w.Event('input',{bubbles:true}));
  })()`);
}
let focusEnabled = false;
try {
  const identity = json(
    `({vault:app.vault.adapter.basePath,version:app.plugins.plugins['pdf-web-reader']?.manifest.version})`,
  );
  assert.equal(path.resolve(identity.vault), path.resolve(vault));
  assert.equal(identity.version, "0.1.7");
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await copyFile(
    path.join(root, "tests/fixtures/tracemonkey.pdf"),
    absolutePath,
  );
  const baseline = sha(await readFile(absolutePath));
  cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  focusEnabled = true;
  await open();
  await pause(1500);
  assert.equal(sha(await readFile(absolutePath)), baseline);
  report.checks.openDoesNotWrite = true;
  evaluate(`${pdf}.eventBus.dispatch('switchannotationeditormode',{mode:5})`);
  await until(
    "Square mode",
    () => json(`${pdf}.pdfViewer.annotationEditorMode`) === 5,
  );
  const geometry = json(
    `(()=>{const v=${view},f=v.iframe.getBoundingClientRect(),s=v.iframe.contentDocument.querySelector('.page .textLayer span').getBoundingClientRect();return {x:f.x+s.x+5,y:f.y+s.y+5};})()`,
  );
  cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...geometry });
  cdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...geometry,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  cdp("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: geometry.x + 65,
    y: geometry.y + 25,
    buttons: 1,
  });
  cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: geometry.x + 65,
    y: geometry.y + 25,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await until(
    "automatic original-file write",
    async () =>
      sha(await readFile(absolutePath)) !== baseline &&
      json(`!${view}.saving && !${pdf}._saveInProgress`),
  );
  report.checks.nativePointerAutosave = true;
  const saveLabel = json(
    `(()=>{const d=${view}.iframe.contentDocument,e=d.getElementById('pdfReaderSaveStatus');return {text:e?.textContent,width:e?.getBoundingClientRect().width,toolbar:!!e?.closest('#toolbarViewer'),popup:d.getElementById('pdfReaderBridgeStatus')?.textContent||''};})()`,
  );
  assert.equal(saveLabel.text, undefined);
  assert.equal(saveLabel.toolbar, false);
  assert.equal(saveLabel.popup, "");
  report.checks.noSaveInformationDisplayed = true;
  const firstSaveHash = sha(await readFile(absolutePath));
  await pause(1500);
  assert.equal(sha(await readFile(absolutePath)), firstSaveHash);
  report.checks.idleDoesNotRewrite = true;
  evaluate(`(${lookup}).detach()`);
  await open();
  assert.equal(
    evaluate(
      `(async()=>{const p=await ${pdf}.pdfDocument.getPage(1);return (await p.getAnnotations()).filter(a=>a.subtype==='Square').length;})()`,
    ),
    1,
  );
  evaluate(`${pdf}.eventBus.dispatch('switchannotationeditormode',{mode:5})`);
  await until(
    "restored square editor",
    () =>
      json(
        `${view}.iframe.contentDocument.querySelectorAll('.inkEditor').length`,
      ) > 0,
  );
  setColor("#ff0000");
  evaluate(`(${lookup}).detach()`);
  assert.equal(
    evaluate(`!!(${lookup})`),
    false,
    "Close must wait for the color write before detaching",
  );
  assert.notEqual(sha(await readFile(absolutePath)), firstSaveHash);
  report.checks.closeFlushesPendingColor = true;
  await open();
  const savedColor = JSON.parse(
    evaluate(
      `(async()=>{const p=await ${pdf}.pdfDocument.getPage(1);return JSON.stringify([...((await p.getAnnotations()).find(a=>a.subtype==='Square').color)]);})()`,
    ),
  );
  assert.deepEqual(savedColor, [255, 0, 0]);
  report.checks.colorSurvivesReopen = true;
  evaluate(`${pdf}.eventBus.dispatch('switchannotationeditormode',{mode:5})`);
  await until(
    "square for conflict",
    () =>
      json(
        `${view}.iframe.contentDocument.querySelectorAll('.inkEditor').length`,
      ) > 0,
  );
  const renameSession = evaluate(`${view}.sessionId`);
  const preRenameHash = sha(await readFile(absolutePath));
  diskPath = relativePath.replace(/\.pdf$/, "-renamed.pdf");
  evaluate(`app.fileManager.renameFile(${view}.file,${quote(diskPath)})`);
  absolutePath = path.join(vault, diskPath);
  assert.equal(evaluate(`${view}.requestedPath`), relativePath);
  assert.equal(evaluate(`${view}.sessionId`), renameSession);
  assert.equal(evaluate(`${view}.getState().file`), diskPath);
  setColor("#00ff00");
  await until(
    "automatic save after native rename",
    async () =>
      sha(await readFile(absolutePath)) !== preRenameHash &&
      json(
        `!${view}.saving && !${pdf}._saveInProgress && !${pdf}._hasChanges()`,
      ),
  );
  assert.equal(evaluate(`${view}.lastSaveError`), null);
  report.checks.renamePreservesSessionAndAutosave = true;
  report.renamedPath = diskPath;
  evaluate(
    `(async()=>{const f=app.vault.getAbstractFileByPath(${quote(diskPath)});globalThis.__autosaveTestOriginal=await app.vault.readBinary(f);const a=new Uint8Array(globalThis.__autosaveTestOriginal);const b=new Uint8Array(a.length+1);b.set(a);b[a.length]=10;await app.vault.modifyBinary(f,b.buffer);})()`,
  );
  setColor("#0000ff");
  await until(
    "conflict paused",
    () => json(`${view}.lastSaveError?.code || ''`) === "conflict",
  );
  const conflictHash = sha(await readFile(absolutePath));
  assert.equal(
    json(
      `${view}.iframe.contentDocument.getElementById('pdfReaderBridgeStatus')?.textContent || ''`,
    ),
    "",
    "Conflict information must not be displayed",
  );
  await pause(1500);
  assert.equal(sha(await readFile(absolutePath)), conflictHash);
  evaluate(`(${lookup}).detach()`);
  assert.equal(
    evaluate(`!!(${lookup})`),
    true,
    "Failed save must retain the native tab",
  );
  report.checks.conflictRetainsViewAndStopsRetry = true;
  evaluate(
    `(async()=>{const f=app.vault.getAbstractFileByPath(${quote(diskPath)});await app.vault.modifyBinary(f,globalThis.__autosaveTestOriginal);delete globalThis.__autosaveTestOriginal;return await ${pdf}.save();})()`,
  );
  evaluate(`(${lookup}).detach()`);
  assert.equal(evaluate(`!!(${lookup})`), false);
  report.checks.manualRetryRecovers = true;
  const concurrentPath = relativePath.replace(/\.pdf$/, "-concurrent.pdf");
  const concurrentResult = evaluate(`(async()=>{
    const original=await app.vault.readBinary(app.vault.getAbstractFileByPath(${quote(diskPath)}));
    const f=await app.vault.createBinary(${quote(concurrentPath)},original);
    const leaves=[];
    globalThis.__pdfReaderConcurrentTestLeaves=leaves;
    for(let n=0;n<2;n++){
      const l=app.workspace.getLeaf(true);
      await l.setViewState({type:'pdf-web-reader-view',state:{file:f.path},active:false});
      leaves.push(l);
    }
    if(leaves[0]===leaves[1] || leaves[0].view===leaves[1].view)throw Error('Expected distinct native views');
    return true;
  })()`);
  assert.equal(concurrentResult, true);
  await until("two native views loaded", () =>
    json(
      `globalThis.__pdfReaderConcurrentTestLeaves.every(l=>l.view.ready && l.view.originalBytes && l.view.iframe?.contentWindow.PDFViewerApplication.pdfDocument)`,
    ),
  );
  const concurrentProof = JSON.parse(
    evaluate(`(async()=>{
    const views=globalThis.__pdfReaderConcurrentTestLeaves.map(l=>l.view);
    const make=(v,n)=>{const tail=new TextEncoder().encode('\\n% concurrent-view-'+n+'\\n'),a=v.originalBytes;
      const b=new Uint8Array(a.length+tail.length);b.set(a);b.set(tail,a.length);return b.buffer;};
    await Promise.all(views.map((v,n)=>v.saveFile(make(v,n),v.requestedPath,'native-concurrent-'+n)));
    const bytes=new Uint8Array(await app.vault.readBinary(views[0].file));
    return JSON.stringify({errors:views.map(v=>v.lastSaveError?.code||null),tail:new TextDecoder().decode(bytes.slice(-80))});
  })()`),
  );
  assert.deepEqual(concurrentProof.errors, [null, "conflict"]);
  assert.ok(concurrentProof.tail.includes("% concurrent-view-0"));
  assert.ok(!concurrentProof.tail.includes("% concurrent-view-1"));
  report.checks.sameFileConcurrentSaveConflicts = true;
  evaluate(
    `(async()=>{for(const l of globalThis.__pdfReaderConcurrentTestLeaves)await l.detach();delete globalThis.__pdfReaderConcurrentTestLeaves;})()`,
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  throw error;
} finally {
  if (focusEnabled)
    cdp("Emulation.setFocusEmulationEnabled", { enabled: false });
  await mkdir(path.join(root, "tests/artifacts"), { recursive: true });
  await writeFile(
    path.join(root, "tests/artifacts", `native-autosave-${Date.now()}.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
