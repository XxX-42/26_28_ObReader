import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { constants, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import xxhash from "xxhash-wasm";
import { PDFDocument, PDFName } from "pdf-lib";
import { nativeConfig, nativeCdp, nativeEvalJson, assertNativeTestPreflight } from "./native-config.mjs";
import { installNativeSelectionProbe } from "./native-selection-probe.mjs";
import { mapNativeSidecarAdapterArgs } from "./native-sidecar-isolation.mjs";

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
const report = { version: expectedVersion, scenario, vault: nativeConfig.vault, fixture: file, isolatedStoreRoot, startedAt: new Date().toISOString(), stages: [], status: "running" };
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
async function tree(dir) {
  const result = new Map();
  for (const e of await readdir(absolute(dir), { withFileTypes: true }).catch(() => [])) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) for (const [p2, value] of await tree(p)) result.set(p2, value);
    else result.set(p, await readFile(absolute(p)));
  }
  return result;
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
  await doc(({ v, w, a, d, arg }) => {
    a.pdfViewer.currentScaleValue = arg;
    d.getElementById("viewerContainer").scrollTop = 0;
    const t = globalThis.__sidecarNative07;
    t.viewerWindows.set(w,v.token);
    t.docKey=v.annotationDocument?.docKey;
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
  const base = `${storeRoot}/checkpoints/${s.docKey}`;
  const ck = JSON.parse(await readFile(absolute(`${base}.json`), "utf8"));
  const all = await tree(storeRoot);
  return { revision: ck.revision, integrity: ck.integrity, annotations: ck.annotations, tombstones: ck.tombstones,
    operationBatchFiles: [...all.keys()].filter(p => p.includes(`/ops/${s.docKey}/`) && p.endsWith(".json")),
    checkpointBytes: all.get(`${base}.json`)?.byteLength, backupHash: sha(all.get(`${base}.previous.json`) || Buffer.alloc(0)),
    snapshotPointers: [...all].filter(([p]) => p.endsWith(`--${s.docKey}.pdfdata.json`)).map(([p,b]) => ({ path: p, value: JSON.parse(b) })) };
}
async function saved(label, expectedTypes) {
  await doc(({ w, d }) => { w.focus(); d.getElementById("viewerContainer").focus(); return true; });
  await key("s", "KeyS", 83, 2);
  await wait(`saved ${label}`, state, s => !s.dirty && !s.pending && s.revision === s.confirmed, 30_000);
  const ck = await wait(`checkpoint ${label}`, async () => checkpoint().catch(() => null), ck => ck && JSON.stringify(ck.annotations.map(x => x.kind).sort()) === JSON.stringify([...expectedTypes].sort()));
  report.stages.push({ label, state: await state(), checkpoint: ck, hashes: await sourceHashes(label) });
  console.log(`Native sidecar stage: ${label}`);
  assert.deepEqual(report.stages.at(-1).hashes, report.sourceBefore);
  return ck;
}
async function close() {
  await run(async p => { const v = [...app.plugins.plugins["pdf-web-reader"].views].find(v => v.requestedPath === p); await v.leaf.detach(); return true; }, file);
  await wait("Reader completely detached", () => run(p => [...app.plugins.plugins["pdf-web-reader"].views].filter(v => v.requestedPath === p).length, file), n => n === 0, 8_000);
}
async function exportCopy(expectedTypes) {
  run(()=>{globalThis.__sidecarNative07.exportAllowed=true;return true;});
  let exported;
  try {
    exported=await run(async p=>{const v=[...app.plugins.plugins['pdf-web-reader'].views].find(v=>v.requestedPath===p);return await v.exportAnnotatedCopy();},file);
  } finally {
    run(()=>{globalThis.__sidecarNative07.exportAllowed=false;return true;});
  }
  assert.notEqual(exported,file);
  assert.ok(exported.startsWith(folder+'/'),'Export must stay in this new fixture folder');
  const exportBytes=await readFile(absolute(exported)), pdf=await PDFDocument.load(exportBytes), annotations=[];
  const supported=['Underline','Square','Highlight','Ink','FreeText'];
  for(const [pageIndex,page] of pdf.getPages().entries()){const list=page.node.Annots();if(!list)continue;for(let i=0;i<list.size();i++){const dict=list.lookup(i), subtype=dict.get(PDFName.of('Subtype'))?.toString().slice(1);if(supported.includes(subtype))annotations.push({pageIndex,subtype,rect:dict.get(PDFName.of('Rect'))?.toString(),contents:dict.get(PDFName.of('Contents'))?.decodeText?.()});}}
  assert.deepEqual(annotations.map(x=>x.subtype).sort(),[...expectedTypes].sort());
  report.export={path:exported,hashes:hashes(exportBytes),annotations};
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
  await run(async()=>{await globalThis.__sidecarNative07.lifecycleFirst.leaf.detach();return true;});
  await wait('A fully detached while B remains',()=>run(p=>[...app.plugins.plugins['pdf-web-reader'].views].filter(v=>v.requestedPath===p).length,file),n=>n===1);
  await open();
  assert.equal(await doc(({v})=>v.token),report.readerLifecycle.secondToken);
  report.readerLifecycle.firstClosedBeforeSecondDrag=true;
}

try {
  report.installedTripletBefore=await installedTriplet();
  const preflight = run(() => ({ vault: app.vault.adapter.basePath, configDir: app.vault.configDir, pluginEnabled: app.plugins.enabledPlugins.has("pdf-web-reader"), pluginVersion: app.plugins.plugins["pdf-web-reader"].manifest.version, readerViews: [...app.plugins.plugins["pdf-web-reader"].views].map(v=>({path:v.requestedPath,revision:v.currentRevision,confirmed:v.confirmedRevision,pending:v.pendingSaves,dirty:!!v.iframe?.contentWindow?.PDFViewerApplication?._hasChanges?.()})), visibility: document.visibilityState }));
  assertNativeTestPreflight(preflight, expectedVersion); report.preflight=preflight;
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
  instrumented=true;
  run(async ({file,prefix,protectedPaths,isolatedRoot})=>{
    if(globalThis.__sidecarNative07)throw Error("Previous Native instrumentation still present");
    const a=app.vault.adapter, p=app.plugins.plugins["pdf-web-reader"], protectedSet=new Set(protectedPaths), originals=[];
    const trace=globalThis.__sidecarNative07={file,prefix,isolatedRoot,clockOrigin:performance.timeOrigin,viewerWindows:new Map(),viewerTimings:[],viewerLogLosses:[],storeTimings:[],io:[],acks:[],pointers:[],messages:[],listeners:[],pdfSerializations:[],sourceWriteAttempts:[],blockedExistingWrites:[],exportAllowed:false,originals};
    trace.messageListener=e=>{const v=[...p.views].find(v=>v.requestedPath===file);const expected=trace.viewerWindows.get(e.source)||(e.source===v?.iframe?.contentWindow?v.token:null);if(!expected||e.data?.channel!=='pdf-web-reader'||e.data.token!==expected)return;if(['save','recover'].includes(e.data.type))trace.messages.push({at:performance.now(),type:e.data.type,revision:e.data.revision,requestId:e.data.requestId,operations:e.data.operations?.length??e.data.annotationOperations?.length,encodedBytes:new TextEncoder().encode(JSON.stringify(e.data)).length});if(e.data.type==='runtime-log'&&Array.isArray(e.data.rows))for(const raw of e.data.rows){try{const row=JSON.parse(raw);if(row.kind==='sidecar-performance')trace.viewerTimings.push({...row,receivedAt:performance.now()});else if(row.kind==='log-loss')trace.viewerLogLosses.push({...row,receivedAt:performance.now()});}catch{}}};window.addEventListener('message',trace.messageListener);
    const record=p.sessionLog.record;originals.push({object:p.sessionLog,name:'record',original:record});p.sessionLog.record=function(kind,fields){if(kind==='annotationStore'&&fields?.event==='annotation-performance')trace.storeTimings.push({...fields,receivedAt:performance.now()});return record.call(this,kind,fields);};
    const adapterMethods=["read","write","readBinary","writeBinary","append","appendBinary","remove","rename","exists","mkdir","list","process"];
    for(const name of adapterMethods){if(typeof a[name]!=="function")continue;const original=a[name];originals.push({object:a,name,original});a[name]=async function(...args){const target=String(args[0]||'');const mappedArgs=mapNativeSidecarAdapterArgs(name,args,prefix,isolatedRoot);const mappedTarget=String(mappedArgs[0]||'');const writing=!["read","readBinary","exists","list"].includes(name);if(writing&&(target===file||String(args[1]||'')===file)){trace.sourceWriteAttempts.push({name,target});throw Error("Source PDF mutation forbidden");}if(writing&&!mappedTarget.startsWith(isolatedRoot)&&protectedSet.has(target)){trace.blockedExistingWrites.push(target);throw Error("Existing annotation data is protected");}if(name==='rename'&&protectedSet.has(String(args[1]))&&!String(mappedArgs[1]||'').startsWith(isolatedRoot)){trace.blockedExistingWrites.push(String(args[1]));throw Error('Existing target protected');}const t=performance.now();try{const result=await original.apply(this,mappedArgs);if(target===file||target===prefix||target.startsWith(prefix+'/'))trace.io.push({name,path:target,storagePath:mappedTarget,at:t,ms:performance.now()-t,bytes:typeof args[1]==='string'?new TextEncoder().encode(args[1]).length:args[1]?.byteLength??(typeof result==='string'?new TextEncoder().encode(result).length:result?.byteLength??0)});return result;}catch(e){trace.io.push({name,path:target,storagePath:mappedTarget,at:t,error:String(e)});throw e;}};}
    for(const name of ['modifyBinary','appendBinary','modify','append','createBinary','create','delete','rename']){if(typeof app.vault[name]!=='function')continue;const original=app.vault[name];originals.push({object:app.vault,name,original});app.vault[name]=function(target,...args){if(String(target?.path||target)===file){trace.sourceWriteAttempts.push({name,path:file});throw Error('Source PDF mutation forbidden');}return original.call(this,target,...args);};}
    return true;
  },{file,prefix:storeRoot,isolatedRoot:isolatedStoreRoot,protectedPaths:[...protectedFiles.keys()]});
  await open();
  if(benchmarking){
    report.benchmark=[];
    await mode(2,5);
    for(let i=0;i<10;i++){
      await drag(await point(.14+i*.025,.28+i*.012),await point(.25+i*.025,.34+i*.012));
      await wait('benchmark Square created',state,s=>s.editors.filter(e=>e.type===5).length===i+1);
      const ck=await saved(`benchmark-${i+1}`,Array(i+1).fill('Square'));
      report.benchmark.push({edit:i+1,checkpointRevision:ck.revision,checkpointBytes:ck.checkpointBytes,heap:nativeCdp('Runtime.getHeapUsage')});
    }
    if(process.env.PDF_READER_REQUIRE_PHASE_TIMINGS==='1'){
      await wait('independent phase telemetry delivered',()=>run(()=>{const t=globalThis.__sidecarNative07;return{capture:t.viewerTimings.filter(x=>x.phase==='capture'&&x.status==='ok').length,encode:t.viewerTimings.filter(x=>x.phase==='encode'&&x.status==='ok').length,gc:t.storeTimings.filter(x=>x.phase==='gc'&&x.docKey===t.docKey).length};}),s=>s.capture>=10&&s.encode>=10&&s.gc>0,8_000);
    }
    await close(); report.status='passed';
  }else if(scenario==='underline'){
    await independentReaderLifecycle();
    await createNativeUnderline('underline-single',5);
    const initial=(await checkpoint()).annotations.map(r=>r.uuid);
    await close();await open();
    await wait('Underline hydrated after reopen',state,s=>s.editors.filter(e=>e.type===10).length===1);
    assert.deepEqual((await checkpoint()).annotations.map(r=>r.uuid),initial);
    await underlineVisual('underline-after-reopen');
    await createNativeUnderline('underline-adjacent',6);
    await createNativeUnderline('underline-multiline',9,true);
    const all=(await checkpoint()).annotations.map(r=>r.uuid);assert.equal(new Set(all).size,3);
    await close();await open();
    await wait('Three Underlines hydrate without duplication',state,s=>s.editors.filter(e=>e.type===10).length===3);
    assert.deepEqual((await checkpoint()).annotations.map(r=>r.uuid).sort(),all.sort());
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
    const uuid=(await checkpoint()).annotations[0].uuid;
    const createdRect=(await state()).editors.find(e=>e.type===3).serialized.rect;
    await close(); await open();
    await wait('FreeText hydrated',state,s=>s.editors.some(e=>e.type===3));
    assert.equal((await checkpoint()).annotations[0].uuid,uuid);
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
  await doc(({a})=>{a.eventBus.dispatch('switchannotationeditormode',{mode:0});return true;});
  const squareBefore=(await state()).editors.find(e=>e.type===5).serialized.rect;
  const squarePoint=await doc(({v,d,a})=>{const m=a.pdfViewer._layerProperties.annotationEditorUIManager;const e=[...d.querySelectorAll('.annotationEditorLayer > div[id]')].find(e=>m.getEditor(e.id)?.constructor._editorType===5);const r=e.getBoundingClientRect(),f=v.iframe.getBoundingClientRect();return{x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2};});
  await click(squarePoint); await drag(squarePoint,{x:squarePoint.x+20,y:squarePoint.y+14});
  await wait('saved Square moved',state,s=>JSON.stringify(s.editors.find(e=>e.type===5)?.serialized.rect)!==JSON.stringify(squareBefore));
  await saved('square-moved',five);
  const underlinePoint=await doc(({v,d,a})=>{const m=a.pdfViewer._layerProperties.annotationEditorUIManager;const e=[...d.querySelectorAll('.annotationEditorLayer > div[id]')].find(e=>m.getEditor(e.id)?.constructor._editorType===10);const r=e.getBoundingClientRect(),f=v.iframe.getBoundingClientRect();return{x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2};});
  await click(underlinePoint); await key('Delete','Delete',46);
  const four=five.filter(t=>t!=='Underline'); await saved('delete',four);
  await button('#pdfReaderBridgeUndoButton'); await saved('undo',five);
  assert.equal((await checkpoint()).annotations.find(r=>r.kind==='Underline').uuid,report.initialUuids.Underline);
  await button('#pdfReaderBridgeRedoButton'); await saved('redo',four);
  await close(); await open(); await wait('final four hydrated',state,s=>s.editors.length===4);
  const final=await checkpoint(); assert.equal(final.tombstones.find(r=>r.kind==='Underline').uuid,report.initialUuids.Underline);
  report.finalUuids=Object.fromEntries(final.annotations.map(r=>[r.kind,r.uuid]));
  await exportCopy(four);
  await close(); report.status='passed';
  }
  }
} catch(error) {
  report.status='failed';report.error=error.stack||String(error);
  try{report.failureState=await state();report.failureScreenshot=(await screenshot('failure')).output;}catch(e){report.failureCaptureError=String(e);}
  process.exitCode=1;
} finally {
  if (diagnoseTextCapture && report.status === "passed") report.status = "diagnostic-passed";
  if (instrumented) {
    try {
      const artifactMeta = run(async tracePath => {
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
          selectionProbes: (t.selectionProbes || []).map(summarizeSelectionProbe),
          io: t.io.map(({ name, path, ms, bytes, error }) => ({ name, path, ms, bytes, error })),
          acks: t.acks.map(({ at, type, documentId, openRequest, revision, external,
            operationCount, batchId, requestId, code }) => ({ at, type, documentId,
            openRequest, revision, external, operationCount, batchId, requestId, code })),
          pointers: t.pointers.map(({ at, trusted, type, x, y }) => ({ at, trusted, type, x, y })),
          messages: t.messages,
          pdfSerializations: t.pdfSerializations,
          sourceWriteAttempts: t.sourceWriteAttempts,
          blockedExistingWrites: t.blockedExistingWrites,
        };
        window.removeEventListener('message', t.messageListener);
        for (const { target, type, listener } of t.listeners) target.removeEventListener(type, listener, true);
        for (const { object, name, original } of t.originals.reverse()) object[name] = original;
        delete globalThis.__sidecarNative07;
        const serialized = JSON.stringify(out);
        const adapter = app.vault.adapter;
        const folder = tracePath.slice(0, tracePath.lastIndexOf("/"));
        if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
        if (await adapter.exists(tracePath)) throw Error(`Refusing to overwrite Native trace artifact ${tracePath}`);
        await adapter.write(tracePath, serialized);
        const bytes = Buffer.byteLength(serialized, "utf8");
        const sha256 = require("node:crypto").createHash("sha256").update(serialized, "utf8").digest("hex");
        return { ok: true, artifactPath: tracePath, bytes, sha256 };
      }, traceArtifactVaultPath);
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
      };
    } catch (error) {
      report.instrumentationCleanupError = String(error);
    }
  }
  if (report.instrumentationCleanupError || report.trace?.sourceWriteAttempts.length ||
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
  report.protectedFiles=await Promise.all([...protectedFiles].filter(([p])=>p!==storeRoot+'/_index.json').map(async([p,b])=>({path:p,before:sha(b),after:sha(await readFile(absolute(p))),unchanged:sha(b)===sha(await readFile(absolute(p)))})));
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
  console.log(JSON.stringify({status:report.status,resultPath,error:report.error,sourceBefore:report.sourceBefore,sourceAfter:report.sourceAfter,sourceWriteAttempts:report.trace?.sourceWriteAttempts,pdfSerializations:report.trace?.pdfSerializations}));
}
