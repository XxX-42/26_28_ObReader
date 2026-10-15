import { nativeEvalJson } from "../tests/native-config.mjs";

const expression = `JSON.stringify({
  vault: app.vault.adapter.basePath,
  version: app.plugins.plugins["pdf-web-reader"]?.manifest.version,
  enabled: app.plugins.enabledPlugins.has("pdf-web-reader"),
  views: [...(app.plugins.plugins["pdf-web-reader"]?.views || [])].map(v => ({
    path: v.requestedPath, revision: v.currentRevision,
    confirmed: v.confirmedRevision, pending: v.pendingSaves,
    dirty: !!v.iframe?.contentWindow?.PDFViewerApplication?._hasChanges?.(),
    selectionEnvironment: (()=>{
      const w=v.iframe?.contentWindow,d=w?.document,span=d?.querySelector('.textLayer span');
      return d ? {hasFocus:d.hasFocus(),active:d.activeElement?.tagName,
        rootClass:d.documentElement.className,userSelect:span?w.getComputedStyle(span).userSelect:null,
        rootSelect:w.getComputedStyle(d.documentElement).userSelect,bodySelect:w.getComputedStyle(d.body).userSelect,
        cursorTool:w.PDFViewerApplication?.pdfCursorTools?.activeTool,
        isTopActive:document.activeElement===v.iframe} : null;
    })()
  }))
})`;
console.log(JSON.stringify(nativeEvalJson(expression), null, 2));
