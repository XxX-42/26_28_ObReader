import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import puppeteer from "puppeteer-core";
import { PDFDocument } from "pdf-lib";
import UPNGModule from "@pdf-lib/upng";
import { resolveBrowserPath } from "./browser-path.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { cleanupBrowserTestResources } from "./browser-test-cleanup.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";

const root = path.resolve(import.meta.dirname, "..");
const UPNG = UPNGModule.default || UPNGModule;

function isWithinDirectory(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

test("pointer eraser routes native highlights to PDF and sidecar highlights to JSONL despite a legacy tombstone", { timeout: 90_000 }, async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  const ctx = pdf.context;
  const squareAppearance = ctx.register(ctx.flateStream("0 0 1 rg 0 0 70 70 re f", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 70, 70],
  }));
  const squareRef = ctx.register(ctx.obj({
    Type: "Annot", Subtype: "Square", Rect: [30, 30, 100, 100],
    C: [0, 0, 1], CA: 1, BS: { W: 2 }, AP: { N: squareAppearance },
  }));
  const appearance = ctx.register(ctx.flateStream("1 1 0 rg 0 0 70 18 re f", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 70, 18],
  }));
  const nativeRef = ctx.register(ctx.obj({
    Type: "Annot", Subtype: "Highlight", Rect: [120, 30, 190, 48],
    QuadPoints: [120, 48, 190, 48, 120, 30, 190, 30],
    C: [1, 1, 0], CA: 1, AP: { N: appearance },
  }));
  page.node.addAnnot(squareRef);
  page.node.addAnnot(nativeRef);
  const bytes = Buffer.from(await pdf.save());
  const originalHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const documentId = "native-erase-routing-browser";
  const seedRows = [
    // Old rows have no provenance. They must not hide the actual source mark.
    { uuid: "legacy-native-delete", kind: "Square", pageIndex: 0,
      embeddedRef: squareRef.toString(), deleted: true,
      clock: { timestamp: 10, logical: 1, deviceId: "legacy", opId: "legacy-native-delete" } },
    { uuid: "external-highlight", kind: "Highlight", pageIndex: 0,
      embeddedRef: null, deleted: false, provenance: "external",
      clock: { timestamp: 11, logical: 1, deviceId: "jsonl", opId: "external-highlight" },
      payload: { editor: { annotationType: 9, pageIndex: 0, rect: [220, 30, 290, 48],
        rotation: 0, color: [255, 0, 0], opacity: 0.8,
        quadPoints: [220, 48, 290, 48, 220, 30, 290, 30], isCopy: true } } },
  ];
  const bridge = await readBridgeRuntimeSource();
  const vendor = path.join(root, "vendor/pdfjs-generic-legacy");
  const viewerHtml = (await readFile(path.join(vendor, "web/viewer.html"), "utf8")).replace(
    '<script src="viewer.mjs" type="module"></script>',
    '<link rel="stylesheet" href="/bridge.css"><script src="/bridge.js" data-channel="pdf-web-reader" data-token="native-erase-routing"></script><script src="viewer.mjs" type="module"></script>',
  );
  const hostHtml = `<!doctype html><style>body{margin:0}iframe{width:900px;height:740px;border:0}</style><iframe id="reader" src="/pdfjs/web/viewer.html?file="></iframe><script>
    const frame=document.getElementById('reader');const rows=new Map(${JSON.stringify(seedRows)}.map(row=>[row.uuid,row]));let identity=null;let sequence=0;
    window.host={rows,errors:[],saves:[],opened:0,sourceWrites:0};
    const snapshot=()=>({schemaVersion:1,kind:'pdf-annotation-snapshot',documentId:${JSON.stringify(documentId)},revision:0,legacyIdentities:[],source:identity&&{sourceHash:'xxh64-v1:native-erase-test',pageCount:identity.pageCount,orderedPageIdentities:identity.orderedPageIdentities},annotations:[...rows.values()],tombstones:[]});
    const send=data=>frame.contentWindow.postMessage({channel:'pdf-web-reader',token:'native-erase-routing',documentId:${JSON.stringify(documentId)},openRequest:sequence,...data},'*');
    window.reopen=async()=>{sequence++;send({type:'open',data:await fetch('/source.pdf').then(r=>r.arrayBuffer()),filename:'native-erase-routing.pdf',autoSave:true,sourceHashConfirmed:!!identity,externalAnnotations:identity?snapshot():null});};
    addEventListener('message',event=>{if(event.source!==frame.contentWindow)return;const m=event.data;if(m?.token!=='native-erase-routing')return;
      if(m.type==='ready'&&!sequence)void reopen();
      if(m.type==='opened')host.opened++;
      if(m.type==='annotation-source-identity'){identity=m;send({type:'external-annotations-update',identityConfirmed:true,sourceMatch:'MATCH',externalAnnotations:snapshot()});}
      if(m.type==='save'){host.saves.push({revision:m.revision,operations:m.operations||[]});send({type:'saved',external:true,requestId:m.requestId,revision:m.revision,operationCount:(m.operations||[]).length,batchId:'routing-test'});}
      if(m.type==='error')host.errors.push({message:m.message,code:m.code});
    });
  </script>`;
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      if (pathname === "/") { res.setHeader("Content-Type", "text/html"); return res.end(hostHtml); }
      if (pathname === "/source.pdf") { res.setHeader("Content-Type", "application/pdf"); return res.end(bytes); }
      if (pathname === "/pdfjs/web/viewer.html") { res.setHeader("Content-Type", "text/html"); return res.end(viewerHtml); }
      if (pathname === "/bridge.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(bridge); }
      if (pathname === "/bridge.css") { res.setHeader("Content-Type", "text/css"); return res.end(await readFile(path.join(root, "viewer-adapter/bridge.css"))); }
      const relative = pathname.startsWith("/pdfjs/") ? pathname.slice(7) : pathname.startsWith("/build/") ? pathname.slice(1) : `web${pathname}`;
      const target = path.resolve(vendor, relative);
      if (!isWithinDirectory(vendor, target)) throw new Error("path");
      const ext = path.extname(target);
      res.setHeader("Content-Type", ({ ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".ftl": "text/plain", ".svg": "image/svg+xml" })[ext] || "application/octet-stream");
      res.end(await readFile(target));
    } catch { res.statusCode = 404; res.end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await launchTestBrowser(puppeteer, { executablePath: resolveBrowserPath(), headless: true, args: ["--no-sandbox"] }, { testName: "native-erase-routing" });
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: 1 });
    page.on("pageerror", error => console.log("PAGE_ERROR", error.message));
    page.on("console", message => { if (message.type() === "error") console.log("CONSOLE_ERROR", message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => host.opened === 1);
    const viewer = page.frames().find(frame => frame.url().includes("/pdfjs/web/viewer.html"));
    await viewer.waitForFunction(() => PDFViewerApplication.pdfViewer.getPageView(0)?.renderingState === 3 &&
      !document.documentElement.hasAttribute("data-pdf-reader-readonly"));
    const squarePaint = await (async () => {
      const rect = await viewer.evaluate(() => {
        const pageView = PDFViewerApplication.pdfViewer.getPageView(0);
        const [x1, y1, x2, y2] = pageView.viewport.convertToViewportRectangle([30, 30, 100, 100]);
        const canvas = pageView.canvas.getBoundingClientRect();
        const page = pageView.div.getBoundingClientRect();
        return { left: Math.floor(Math.min(x1, x2) + canvas.left - page.left),
          top: Math.floor(Math.min(y1, y2) + canvas.top - page.top),
          right: Math.ceil(Math.max(x1, x2) + canvas.left - page.left),
          bottom: Math.ceil(Math.max(y1, y2) + canvas.top - page.top) };
      });
      const png = await (await viewer.$('.page[data-page-number="1"]')).screenshot();
      const image = UPNG.decode(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
      const rgba = new Uint8Array(UPNG.toRGBA8(image)[0]);
      let blue = 0;
      for (let y = Math.max(0, rect.top); y < Math.min(image.height, rect.bottom); y++) {
        for (let x = Math.max(0, rect.left); x < Math.min(image.width, rect.right); x++) {
          const offset = (y * image.width + x) * 4;
          if (rgba[offset] < 60 && rgba[offset + 1] < 60 && rgba[offset + 2] > 180) blue++;
        }
      }
      return blue;
    })();
    assert.ok(squarePaint > 0, `legacy tombstone must not mask native Square/AP pixels: ${squarePaint}`);
    const nativeDisplay = await viewer.evaluate(ref => {
      const page = PDFViewerApplication.pdfViewer.getPageView(0).div;
      const node = [...page.querySelectorAll("[data-annotation-id]")].find(element =>
        element.getAttribute("data-annotation-id") === ref ||
        element.getAttribute("data-annotation-id") === ref.replace(/R$/, "R0"));
      return node ? { found: true, display: getComputedStyle(node).display,
        hiddenByBridge: node.getAttribute("data-pdf-reader-external-hidden") } : { found: false };
    }, squareRef.toString());
    if (nativeDisplay.found) {
      assert.notEqual(nativeDisplay.display, "none", `legacy tombstone must not hide source annotation: ${JSON.stringify(nativeDisplay)}`);
      assert.notEqual(nativeDisplay.hiddenByBridge, "1", `legacy tombstone must not apply bridge suppression: ${JSON.stringify(nativeDisplay)}`);
    }
    await viewer.evaluate(() => PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
      source: window, mode: 15,
    }));
    await viewer.waitForFunction(() => {
      const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      return [...manager.getEditors(0)].filter(editor => !editor.deleted).length >= 2;
    });
    const editorInfo = await viewer.evaluate(() => {
      const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      return [...manager.getEditors(0)].filter(editor => !editor.deleted).map(editor => ({
        id: editor.id, ref: editor.annotationElementId || null, kind: editor.editorType,
        rect: (() => { const r = editor.div.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; })(),
      }));
    });
    const nativeEditor = editorInfo.find(editor => editor.ref && editor.kind === "highlight");
    const externalEditor = editorInfo.find(editor => !editor.ref);
    assert.ok(nativeEditor, `source-PDF highlight editor present: ${JSON.stringify(editorInfo)}`);
    assert.ok(externalEditor, `external JSONL highlight editor present: ${JSON.stringify(editorInfo)}`);
    assert.ok(nativeEditor.rect.width > 0 && nativeEditor.rect.height > 0);
    assert.ok(externalEditor.rect.width > 0 && externalEditor.rect.height > 0);

    // The actual pointer eraser consumes editor DOM targets. Two separate
    // pointer gestures preserve which origin each deletion belongs to.
    await viewer.click("#editorEraserButton");
    await viewer.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 17);
    const eraseAt = async editor => {
      const point = { x: editor.rect.x + editor.rect.width / 2, y: editor.rect.y + editor.rect.height / 2 };
      await page.mouse.move(point.x, point.y);
      await page.mouse.down({ button: "left" });
      await page.mouse.up({ button: "left" });
    };
    await eraseAt(nativeEditor);
    await new Promise(resolve => setTimeout(resolve, 150));
    const eraseDebug = await viewer.evaluate(id => {
      const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      const editor = manager.getEditor(id);
      const rect = editor?.div?.getBoundingClientRect();
      return { mode: PDFViewerApplication.pdfViewer.annotationEditorMode, stillRegistered: Boolean(editor), deleted: editor?.deleted,
        className: editor?.div?.className, rect: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        saves: window.parent.host.saves.length };
    }, nativeEditor.id);
    assert.equal(eraseDebug.stillRegistered, false, `native editor pointer eraser removed it: ${JSON.stringify(eraseDebug)}`);
    await page.waitForFunction(() => host.saves.length >= 1);
    // UUIDs are derived from source identity, so locate by provenance-bearing
    // fields rather than assuming a particular generated UUID spelling.
    const nativeDelete = await page.evaluate(() => host.saves.flatMap(save => save.operations)
      .find(operation => operation.deleted === true &&
        (operation.ref || operation.embeddedRef) && operation.kind === "Highlight"));
    assert.ok(nativeDelete, `native pointer erase emitted a ref-bearing delete: ${JSON.stringify(await page.evaluate(() => host.saves))}`);
    assert.equal(nativeDelete.provenance, "embedded");
    assert.equal(nativeDelete.pageIndex, 0);
    assert.match(nativeDelete.embeddedRef || nativeDelete.ref, /^\d+R\d*$/);

    await eraseAt(externalEditor);
    await viewer.waitForFunction(id => {
      const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      return !manager.getEditor(id);
    }, {}, externalEditor.id);
    await page.waitForFunction(() => host.saves.flatMap(save => save.operations)
      .some(operation => operation.deleted === true && operation.uuid === "external-highlight"));
    const externalDelete = await page.evaluate(() => host.saves.flatMap(save => save.operations)
      .find(operation => operation.deleted === true && operation.uuid === "external-highlight"));
    assert.equal(externalDelete.provenance, "external");
    assert.equal(externalDelete.pageIndex, 0);
    assert.equal(externalDelete.ref ?? null, null);
    assert.deepEqual(await page.evaluate(() => host.errors), []);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), originalHash,
      "the browser host transport records operations but never writes the source PDF");
    console.log(JSON.stringify({ nativeDisplay, nativeDelete: { provenance: nativeDelete.provenance, ref: nativeDelete.ref, pageIndex: nativeDelete.pageIndex },
      externalDelete: { provenance: externalDelete.provenance, ref: externalDelete.ref, pageIndex: externalDelete.pageIndex },
      legacyTombstoneIgnoredForSource: true, sourceBytesUnchanged: true }));
  } finally {
    await cleanupBrowserTestResources({ browser, ownedPages: browser ? await browser.pages() : [], server });
  }
});
