/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
'use strict';
const { parseReaderLinkFragment } = require('./reader-anchor-store.cjs');
const { createRegionImageCache } = require('./region-image-cache.cjs');

function squareRegion(row) {
  const editor = row?.payload?.editor;
  const rect = editor?.rect;
  if (row?.deleted === true || row?.kind !== 'Square') return null;
  if (!Number.isSafeInteger(row.pageIndex) || row.pageIndex < 0 ||
      !Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) {
    throw new Error('矩形区域坐标无效。');
  }
  const normalized = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]),
    Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  if (normalized[2] <= normalized[0] || normalized[3] <= normalized[1]) throw new Error('矩形区域为空。');
  return { uuid: row.uuid, pageIndex: row.pageIndex, rect: normalized };
}

function cropViewport(page, rect, pixelRatio = 1) {
  const [left, bottom, right, top] = page.view;
  const bounded = [Math.max(left, rect[0]), Math.max(bottom, rect[1]),
    Math.min(right, rect[2]), Math.min(top, rect[3])];
  if (bounded[2] <= bounded[0] || bounded[3] <= bounded[1]) throw new Error('矩形区域不在页面内。');
  let viewport = page.getViewport({ scale: 1 });
  const unit = viewport.convertToViewportRectangle(bounded);
  const width = Math.abs(unit[2] - unit[0]), height = Math.abs(unit[3] - unit[1]);
  const scale = Math.min(Math.max(1, Math.min(2, pixelRatio)), Math.sqrt(4_000_000 / (width * height)));
  viewport = page.getViewport({ scale });
  const box = viewport.convertToViewportRectangle(bounded);
  return { viewport, x: Math.min(box[0], box[2]), y: Math.min(box[1], box[3]),
    width: Math.max(1, Math.ceil(Math.abs(box[2] - box[0]))),
    height: Math.max(1, Math.ceil(Math.abs(box[3] - box[1]))), cssWidth: width };
}

// Source-only rendering. No AnnotationStorage, DOM annotation layer or PDF save.
async function renderRegion(page, rect, { document, pixelRatio = 1, signal, onTask = () => {} }) {
  if (signal?.aborted) throw new Error('区域渲染已取消。');
  const crop = cropViewport(page, rect, pixelRatio);
  const Offscreen = document.defaultView?.OffscreenCanvas;
  const canvas = typeof Offscreen?.prototype?.convertToBlob === 'function'
    ? new Offscreen(crop.width, crop.height) : document.createElement('canvas');
  canvas.width = crop.width; canvas.height = crop.height;
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: crop.viewport,
    transform: [1, 0, 0, 1, -crop.x, -crop.y], annotationMode: 0, background: 'rgb(255,255,255)' });
  onTask(task);
  const cancel = () => task.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    await task.promise;
    if (signal?.aborted) throw new Error('区域渲染已取消。');
    const blob = typeof canvas.convertToBlob === 'function' ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法生成区域图片。')), 'image/png'));
    return { blob, cssWidth: crop.cssWidth, width: crop.width, height: crop.height };
  } finally {
    signal?.removeEventListener('abort', cancel); onTask(null); canvas.width = canvas.height = 0;
  }
}

async function cropRenderedPage(page, rect, rendered, { document, pixelRatio = 1, signal }) {
  if (!rendered?.canvas || !rendered.viewport || signal?.aborted) return null;
  // Embedded annotations may already be painted into the Viewer canvas.
  if ((await page.getAnnotations({ intent: 'display' })).length || signal?.aborted || !rendered.current()) return null;
  const crop = cropViewport(page, rect, pixelRatio);
  const bounded = [Math.max(page.view[0],rect[0]),Math.max(page.view[1],rect[1]),Math.min(page.view[2],rect[2]),Math.min(page.view[3],rect[3])];
  const box = rendered.viewport.convertToViewportRectangle(bounded);
  const ratioX = rendered.canvas.width / rendered.viewport.width, ratioY = rendered.canvas.height / rendered.viewport.height;
  const canvas = document.createElement('canvas'); canvas.width = crop.width; canvas.height = crop.height;
  try {
    canvas.getContext('2d').drawImage(rendered.canvas, Math.min(box[0],box[2])*ratioX, Math.min(box[1],box[3])*ratioY,
      Math.abs(box[2]-box[0])*ratioX, Math.abs(box[3]-box[1])*ratioY,0,0,crop.width,crop.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
    if (!blob || signal?.aborted || !rendered.current()) return null;
    return { blob, cssWidth: crop.cssWidth, width: crop.width, height: crop.height };
  } finally { canvas.width = canvas.height = 0; }
}

function createRectangleEmbeds({ plugin, Component, resolveTarget, acquireDocument }) {
  const registry = plugin.app.embedRegistry;
  if (typeof registry?.embedByExtension?.pdf !== 'function' || typeof Component !== 'function') return null;
  const original = registry.embedByExtension.pdf;
  const components = new Set(), cache = new Map();
  const diskCache = createRegionImageCache(plugin.app.vault?.adapter?.basePath || plugin.app.vault?.getName?.() || '');
  const resolving = new Map(), resolvedTargets = new Map();
  let resolutionGeneration = 0;
  let disposed = false, queue = Promise.resolve(), cachedBytes = 0;
  function resolveShared(parsed, file, sourcePath) {
    const key = JSON.stringify([resolutionGeneration, file.path, sourcePath, parsed]);
    if (resolvedTargets.has(key)) return Promise.resolve(resolvedTargets.get(key));
    let pending = resolving.get(key);
    if (!pending) {
      const generation = resolutionGeneration;
      pending = Promise.resolve().then(() => resolveTarget(parsed, file, sourcePath)).then(target => {
        if (!disposed && generation === resolutionGeneration) {
          resolvedTargets.set(key, target);
          while (resolvedTargets.size > 64) resolvedTargets.delete(resolvedTargets.keys().next().value);
        }
        return target;
      });
      resolving.set(key, pending);
      void pending.finally(() => { if (resolving.get(key) === pending) resolving.delete(key); }).catch(() => {});
    }
    return pending;
  }
  const enqueue = fn => {
    const result = queue.then(() => { if (disposed) throw new Error('阅读器已关闭。'); return fn(); });
    queue = result.catch(() => {}); return result;
  };
  function remember(key, result) {
    cache.set(key, result); cachedBytes += result.blob.size;
    while (cache.size > 16 || cachedBytes > 32 * 1024 * 1024) {
      const first = cache.keys().next().value; cachedBytes -= cache.get(first).blob.size; cache.delete(first);
    }
  }
  function imageKey(target,region,ownerDocument) {
    return JSON.stringify([target.document.documentId,target.sourceHash,target.sourceVersion,region.uuid,region.pageIndex,region.rect,
      Math.min(2,ownerDocument.defaultView?.devicePixelRatio||1)]);
  }
  async function regionImage(target, region, ownerDocument, signal, current, persist=true) {
    const key=imageKey(target,region,ownerDocument);
    return enqueue(async()=>{
      if(!current())throw Error('区域渲染已取消。');
      if(cache.has(key)){const value=cache.get(key);cache.delete(key);cache.set(key,value);return value;}
      const saved=await diskCache.get(key);
      if(!current())throw Error('区域渲染已取消。');
      if(saved){remember(key,saved);return saved;}
      const lease=await acquireDocument(target,signal);
      try {
        if(!current())throw Error('区域渲染已取消。');
        const page=await lease.document.getPage(region.pageIndex+1);
        const options={document:lease.renderDocument||ownerDocument,pixelRatio:ownerDocument.defaultView?.devicePixelRatio||1,signal};
        const image=await cropRenderedPage(page,region.rect,lease.renderedPage?.(region.pageIndex),options)||await renderRegion(page,region.rect,options);
        if(current()){remember(key,image);if(persist)void diskCache.put(key,image);}return image;
      } finally {await lease.release?.();}
    });
  }
  class RegionEmbed extends Component {
    constructor(context, file, subpath, parsed) {
      super(); this.context = context; this.file = file; this.subpath = subpath; this.parsed = parsed;
      this.containerEl = context.containerEl; this.generation = 0; this.disposed = false;
    }
    onload() {
      components.add(this);
      this.containerEl.classList.add('pdfReaderRectangleEmbed');
      this.showMessage('正在加载矩形区域…');
      // Reading mode and Live Preview may mount a hidden counterpart. Only
      // visible embeds can enter the single rendering queue.
      const Observer = this.containerEl.ownerDocument.defaultView?.IntersectionObserver;
      if (Observer) {
        this.visible = false;
        this.observer = new Observer(entries => {
          const visible = entries.some(entry => entry.isIntersecting);
          if (visible === this.visible) return;
          this.visible = visible;
          if (visible) this.loadFile(); else this.abort?.abort();
        });
        this.observer.observe(this.containerEl);
      } else { this.visible = true; this.loadFile(); }
    }
    loadFile() {
      if (!this.visible) return Promise.resolve();
      if (this.pendingLoad) return this.pendingLoad;
      this.pendingLoad = Promise.resolve().then(() => this.refresh()).finally(() => { this.pendingLoad = null; });
      return this.pendingLoad;
    }
    showMessage(message) {
      this.containerEl.replaceChildren();
      const text = this.containerEl.ownerDocument.createElement('span');
      text.className = 'pdfReaderRectangleEmbedStatus'; text.textContent = message; this.containerEl.append(text);
    }
    async refresh() {
      if (disposed || this.disposed || this.fallback || !this.visible) return;
      const generation = ++this.generation;
      this.abort?.abort(); this.abort = new AbortController();
      const signal = this.abort.signal;
      const current = () => !disposed && !this.disposed && generation === this.generation && !signal.aborted;
      this.showMessage('正在加载矩形区域…');
      try {
        const target = await resolveShared(this.parsed, this.file, this.context.sourcePath || '');
        if (!current()) return;
        const region = squareRegion(target.row);
        if (!region) {
          this.containerEl.replaceChildren(); this.containerEl.classList.remove('pdfReaderRectangleEmbed');
          this.fallback = this.addChild(original(this.context, target.file, this.subpath));
          await this.fallback.loadFile?.(); return;
        }
        this.target = target;
        const result = await regionImage(target,region,this.containerEl.ownerDocument,signal,current);
        if (!current()) return;
        if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
        this.imageUrl = URL.createObjectURL(result.blob);
        const image = this.containerEl.ownerDocument.createElement('img');
        image.className = 'pdfReaderRectangleEmbedImage'; image.src = this.imageUrl;
        image.alt = `${target.file.basename || target.file.path} · p${region.pageIndex + 1}`;
        image.style.cssText = `max-width:100%;width:${result.cssWidth}px;height:auto;display:block;cursor:pointer`;
        image.tabIndex = 0; image.setAttribute('role', 'link');
        const open = event => {
          if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault(); event.stopPropagation();
          // Re-resolve at activation: rename/delete/source changes must not use
          // a stale file object or resurrect a removed UUID.
          void resolveTarget(this.parsed, this.file, this.context.sourcePath || '')
            .then(value => current() && plugin.openPdf(value.file, value.readerTarget))
            .catch(error => current() && this.showMessage(error.message));
        };
        image.addEventListener('click', open); image.addEventListener('keydown', open);
        this.containerEl.replaceChildren(image);
      } catch (error) {
        if (current()) this.showMessage(`区域不可用：${error.message || error}`);
      }
    }
    invalidate(path) {
      if (this.disposed) return;
      const target = this.target;
      if (!path || path === this.file.path || path === target?.file.path || path === target?.annotationPath) {
        if (this.refreshQueued) return;
        this.refreshQueued = true;
        queueMicrotask(() => { this.refreshQueued = false; if (!this.disposed) void this.refresh(); });
      }
    }
    onunload() {
      this.disposed = true; ++this.generation; this.abort?.abort(); this.observer?.disconnect(); components.delete(this);
      if (this.imageUrl) URL.revokeObjectURL(this.imageUrl); this.imageUrl = null;
      this.containerEl.classList.remove('pdfReaderRectangleEmbed'); this.containerEl.replaceChildren();
    }
  }
  const wrapper = (context, file, subpath) => {
    const parsed = parseReaderLinkFragment(subpath);
    if (disposed || parsed.target?.kind !== 'annotation') return original(context, file, subpath);
    return new RegionEmbed(context, file, subpath, parsed);
  };
  registry.embedByExtension.pdf = wrapper;
  return {
    async prepare(parsed,file,ownerDocument,isCurrent=()=>true) {
      const current=()=>!disposed&&isCurrent();
      const target=await resolveTarget(parsed,file,'');
      const region=squareRegion(target.row);
      if(!region||!current())return;
      const image=await regionImage(target,region,ownerDocument,undefined,current,false);
      if(current())await diskCache.put(imageKey(target,region,ownerDocument),image);
    },
    invalidate(path) { ++resolutionGeneration; resolvedTargets.clear(); for (const component of components) component.invalidate(path); },
    dispose() {
      disposed = true;
      diskCache.dispose();
      if (registry.embedByExtension.pdf === wrapper) registry.embedByExtension.pdf = original;
      for (const component of [...components]) component.unload(); cache.clear(); resolving.clear(); resolvedTargets.clear(); cachedBytes = 0;
    },
    get size() { return components.size; },
  };
}
module.exports = { squareRegion, cropViewport, renderRegion, cropRenderedPage, createRectangleEmbeds };

// Borrow open Reader documents. Independently opened documents are released as
// soon as their crop is rendered; only cropped images are kept in the cache.
function createRectangleDocumentPool(plugin, { loadLibrary } = {}) {
  const tasks = new Set(), verifiedSources = new Map(), urls = [];
  let libraryPromise = null, disposed = false;
  async function library() {
    if (loadLibrary) return loadLibrary();
    if (!libraryPromise) libraryPromise = (async () => {
      const [pdfBytes, workerBytes, assets] = await Promise.all([
        plugin.readVerifiedAsset('build/pdf.mjs'), plugin.readVerifiedAsset('build/pdf.worker.mjs'), plugin.ensureViewerAssets(),
      ]);
      if (disposed) throw new Error('阅读器已关闭。');
      const moduleUrl = URL.createObjectURL(new Blob([pdfBytes], { type: 'text/javascript' }));
      const workerUrl = URL.createObjectURL(new Blob([workerBytes], { type: 'text/javascript' }));
      urls.push(moduleUrl, workerUrl);
      const previous = globalThis.pdfjsLib;
      let pdfjs;
      try { pdfjs = await import(moduleUrl); }
      finally { if (previous === undefined) delete globalThis.pdfjsLib; else globalThis.pdfjsLib = previous; }
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      const base = new URL('./', plugin.app.vault.adapter.getResourcePath(`${assets.rootPath}/web/viewer.html`)).href;
      return { pdfjs, base };
    })();
    return libraryPromise;
  }
  return {
    async acquire(target, signal) {
      if (disposed || signal?.aborted) throw new Error('区域渲染已取消。');
      const view = [...(plugin.views || [])].find(view => !view.teardownStarted &&
        view.annotationHydrationAllowed === true && view.annotationSourceMismatch !== true &&
        view.annotationDocument?.documentId === target.document.documentId &&
        view.annotationDocument?.docKey === target.document.docKey && view.documentFile?.path === target.file.path);
      const borrowed = view?.iframe?.contentWindow?.PDFViewerApplication?.pdfDocument;
      const stat = await plugin.app.vault.adapter.stat(target.file.path);
      const key = JSON.stringify([target.document.documentId, target.sourceHash, target.file.path, stat?.mtime, stat?.size]);
      let bytes;
      if (borrowed && !borrowed.destroyed && plugin.annotationHost?.isVerifiedReaderSource?.(view, stat) === true &&
          view.annotationSourceHash === target.document.source?.sourceHash) {
        return { document: borrowed, renderDocument: view.iframe.contentWindow.document, release() {}, renderedPage(index) {
          const pageView = view.iframe.contentWindow.PDFViewerApplication.pdfViewer.getPageView(index);
          const canvas = pageView?.canvas, viewport = pageView?.viewport;
          const current = () => !borrowed.destroyed && !view.teardownStarted && pageView?.renderingState === 3 &&
            pageView.canvas === canvas && pageView.viewport === viewport && canvas?.isConnected;
          return current() ? { canvas, viewport, current } : null;
        } };
      }
      if (!verifiedSources.has(key)) {
        bytes = new Uint8Array(await plugin.app.vault.readBinary(target.file));
        const expected = [target.document.source?.sourceHash, target.document.pairing?.pairedSha256].filter(Boolean);
        let matches = false;
        for (const hash of expected) {
          if (plugin.pdfHashRuntime.matchesAsync ? await plugin.pdfHashRuntime.matchesAsync(bytes, hash) : plugin.pdfHashRuntime.matches(bytes, hash)) { matches = true; break; }
        }
        const after = await plugin.app.vault.adapter.stat(target.file.path);
        if (!matches || stat?.mtime !== after?.mtime || stat?.size !== after?.size) throw new Error('PDF 来源尚未校验，请先打开 PDF 确认来源。');
        verifiedSources.set(key, true);
        while (verifiedSources.size > 4) verifiedSources.delete(verifiedSources.keys().next().value);
      }
      if (borrowed && !borrowed.destroyed) return { document: borrowed, renderDocument: view.iframe.contentWindow.document, release() {} };
      bytes ||= new Uint8Array(await plugin.app.vault.readBinary(target.file));
      const { pdfjs, base } = await library();
      if (disposed || signal?.aborted) throw new Error('区域渲染已取消。');
      const task = pdfjs.getDocument({ data: bytes, cMapUrl: `${base}cmaps/`, cMapPacked: true,
        standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/` });
      tasks.add(task);
      const abort = () => { void task.destroy(); };
      signal?.addEventListener('abort', abort, { once: true });
      let document;
      try { document = await task.promise; }
      catch (error) { tasks.delete(task); await task.destroy(); throw error; }
      finally { signal?.removeEventListener('abort', abort); }
      if (disposed || signal?.aborted) { tasks.delete(task); await task.destroy(); throw new Error('区域渲染已取消。'); }
      return { document, async release() { if (tasks.delete(task)) await task.destroy(); } };
    },
    async dispose() {
      disposed = true;
      await Promise.allSettled([...tasks].map(task => task.destroy())); tasks.clear(); verifiedSources.clear();
      for (const url of urls) URL.revokeObjectURL(url); urls.length = 0;
    },
  };
}
module.exports.createRectangleDocumentPool = createRectangleDocumentPool;
