/*
 * Copyright 2026 XxX-42 and contributors
 * SPDX-License-Identifier: Apache-2.0
 * Bundled third-party notices are preserved in the embedded viewer resources.
 */
const {
  EditableFileView,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} = require("obsidian");

/* BUILD:ASSET_RUNTIME_REQUIRE */ const {
  ensureViewerAssets,
} = require("./asset-runtime.cjs");
/* BUILD:VIEWER_ASSET_PAYLOAD */ const VIEWER_ASSET_PAYLOAD = null;

const VIEW_TYPE = "pdf-web-reader-view";
const CHANNEL = "pdf-web-reader";

function isPdfFile(file) {
  return file instanceof TFile && file.extension.toLowerCase() === "pdf";
}

function resolvePdfFile(plugin, fileOrPath) {
  if (isPdfFile(fileOrPath)) {
    return fileOrPath;
  }
  if (typeof fileOrPath !== "string" || !fileOrPath) {
    return null;
  }
  const file = plugin.app.vault.getAbstractFileByPath(
    normalizePath(fileOrPath),
  );
  return isPdfFile(file) ? file : null;
}

function installPdfOpenRouting(plugin) {
  const prototype = WorkspaceLeaf?.prototype;
  if (!prototype || typeof prototype.setViewState !== "function") {
    return null;
  }

  const routing = {
    active: true,
    plugin,
    prototype,
    originalSetViewState: prototype.setViewState,
    originalDetach: prototype.detach,
    setViewStateWrapper: null,
  };

  routing.setViewStateWrapper = async function (viewState, eState) {
    const activePlugin = routing.plugin;
    const nextPath = viewState?.state?.file ?? viewState?.state?.path;
    if (
      routing.active &&
      this.app === activePlugin?.app &&
      this.view instanceof PdfReaderView &&
      (viewState?.type !== VIEW_TYPE ||
        (nextPath && nextPath !== this.view.requestedPath))
    ) {
      if (!(await this.view.flushBeforeLeave())) return;
    }
    if (
      !routing.active ||
      !activePlugin ||
      this.app !== activePlugin.app ||
      viewState?.type !== "pdf"
    ) {
      return routing.originalSetViewState.call(this, viewState, eState);
    }
    const file = resolvePdfFile(
      activePlugin,
      viewState.state?.file ?? viewState.state?.path,
    );
    if (!file) {
      return routing.originalSetViewState.call(this, viewState, eState);
    }
    return routing.originalSetViewState.call(
      this,
      {
        ...viewState,
        type: VIEW_TYPE,
        state: { ...viewState.state, file: file.path, path: file.path },
      },
      eState,
    );
  };

  prototype.setViewState = routing.setViewStateWrapper;
  if (typeof routing.originalDetach === "function") {
    routing.detachWrapper = async function (...args) {
      if (
        routing.active &&
        this.app === routing.plugin?.app &&
        this.view instanceof PdfReaderView
      ) {
        if (!(await this.view.flushBeforeLeave())) return;
      }
      return routing.originalDetach.apply(this, args);
    };
    prototype.detach = routing.detachWrapper;
  }
  return routing;
}

function restorePdfOpenRouting(routing) {
  if (!routing) {
    return;
  }
  routing.active = false;
  routing.plugin = null;
  if (routing.prototype.setViewState === routing.setViewStateWrapper) {
    routing.prototype.setViewState = routing.originalSetViewState;
  }
  if (
    routing.detachWrapper &&
    routing.prototype.detach === routing.detachWrapper
  )
    routing.prototype.detach = routing.originalDetach;
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeStyleText(value) {
  return String(value).replace(/<\/style/gi, "<\\/style");
}

function makeToken() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function toArrayBuffer(value) {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  throw new Error("The PDF viewer returned invalid document data.");
}

function bytesEqual(left, right) {
  if (!left || !right || left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

class PdfReaderView extends EditableFileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.token = makeToken();
    this.file = null;
    this.requestedPath = null;
    this.navigationState = {};
    this.originalBytes = null;
    this.pendingBytes = null;
    this.ready = false;
    this.saving = false;
    this.openRequest = 0;
    this.resourcePromise = null;
    this._assetCache = null;
    this.iframe = null;
    this.messageListener = (event) => this.onMessage(event);
    this.sessionId = null;
    this.flushPending = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return this.file?.basename || "PDF 阅读器";
  }

  getIcon() {
    return "file-text";
  }

  get assetCache() {
    return this._assetCache;
  }

  getState() {
    const baseState = super.getState();
    const path = this.requestedPath ?? this.file?.path ?? null;
    return {
      ...baseState,
      ...this.navigationState,
      ...(path ? { path, file: path } : {}),
    };
  }

  async setState(state, result) {
    const file = resolvePdfFile(this.plugin, state?.file ?? state?.path);
    if (
      file &&
      this.requestedPath &&
      file.path !== this.requestedPath &&
      !(await this.flushBeforeLeave())
    )
      return;
    if (!file && (this.requestedPath || this.file)) {
      return;
    }
    const normalizedState = file
      ? { ...state, file: file.path, path: file.path }
      : state;
    if (file) {
      this.navigationState = { ...normalizedState };
    }
    await super.setState(normalizedState, result);
  }

  async onLoadFile(file) {
    await super.onLoadFile(file);
    if (!isPdfFile(file)) {
      return;
    }
    this.navigationState = {
      ...this.navigationState,
      file: file.path,
      path: file.path,
    };
    if (this.requestedPath !== file.path) {
      await this.openFile(file);
    }
  }

  async onUnloadFile(file) {
    await super.onUnloadFile(file);
    if (this.requestedPath === file.path) {
      this.openRequest += 1;
      this.pendingBytes = null;
      this.originalBytes = null;
      this.requestedPath = null;
      this.sessionId = null;
      this.navigationState = {};
    }
  }

  async onOpen() {
    await super.onOpen();
    this.contentEl.empty();
    this.contentEl.addClass("pdf-web-reader-content");

    this.iframe = this.contentEl.createEl("iframe", {
      cls: "pdf-web-reader-frame",
      attr: {
        title: "PDF 阅读器",
        allow: "clipboard-read; clipboard-write",
        sandbox:
          "allow-downloads allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts",
      },
    });
    window.addEventListener("message", this.messageListener);
    const iframe = this.iframe;

    try {
      const documentHtml = await this.createViewerDocument();
      if (this.iframe === iframe) {
        iframe.srcdoc = documentHtml;
        this.bridgeTimeout = window.setTimeout(() => {
          if (this.iframe === iframe && !this.ready) {
            this.showError(
              "PDF 阅读器未能启动。请检查插件内置的 Viewer 资源是否完整。",
            );
          }
        }, 20000);
      }
    } catch (error) {
      if (this.iframe === iframe) {
        this.showError(`无法加载内置 PDF 阅读器：${error.message}`);
      }
    }
  }

  async onClose() {
    await super.onClose();
    this.flushPending?.finish(false);
    window.removeEventListener("message", this.messageListener);
    if (this.bridgeTimeout) {
      window.clearTimeout(this.bridgeTimeout);
      this.bridgeTimeout = null;
    }
    if (this.iframe) {
      this.iframe.srcdoc = "";
      this.iframe.remove();
      this.iframe = null;
    }
    this.ready = false;
    this.openRequest += 1;
    this.pendingBytes = null;
    this.originalBytes = null;
    this.requestedPath = null;
    this.sessionId = null;
    this.navigationState = {};
    this.contentEl.removeClass("pdf-web-reader-content");
  }

  async createViewerDocument() {
    if (!this.resourcePromise) {
      this.resourcePromise = this.loadViewerDocument().catch((error) => {
        this.resourcePromise = null;
        throw error;
      });
    }
    return this.resourcePromise;
  }

  async loadViewerDocument() {
    const assets = await this.plugin.ensureViewerAssets();
    this._assetCache = Object.freeze({ ...assets });
    const webRoot = assets.webRoot;
    const viewerHtmlPath = `${webRoot}/viewer.html`;
    const viewerCssPath = `${webRoot}/viewer.css`;
    const bridgeCssPath = `${webRoot}/bridge.css`;
    const [viewerHtml, viewerCss, bridgeCss] = await Promise.all([
      this.app.vault.adapter.read(viewerHtmlPath),
      this.app.vault.adapter.read(viewerCssPath),
      this.app.vault.adapter.read(bridgeCssPath),
    ]);
    const viewerUrl = this.app.vault.adapter.getResourcePath(viewerHtmlPath);
    const webBase = new URL("./", viewerUrl).href;
    const bridgeUrl = new URL("obsidian-bridge.js", webBase);
    // Obsidian's app:// resource URLs can remain stable across plugin reloads,
    // and Chromium may then reuse an older bridge script from its cache.
    // A per-view cache key ensures the bridge matches this host's protocol.
    bridgeUrl.searchParams.set("v", this.token);

    const bridgeScript =
      `<script src="${escapeAttribute(bridgeUrl.href)}" ` +
      `data-channel="${CHANNEL}" data-token="${escapeAttribute(this.token)}"></script>`;
    const baseTag = `<base href="${escapeAttribute(webBase)}">`;
    const injection = `${baseTag}${bridgeScript}`;
    const inlineViewerCss = `<style data-pdf-reader="viewer">${escapeStyleText(viewerCss)}</style>`;
    const inlineBridgeCss = `<style data-pdf-reader="bridge">${escapeStyleText(bridgeCss)}</style>`;
    let viewerCssInserted = false;
    const htmlWithInlineStyles = viewerHtml.replace(
      /<link\b[^>]*>/gi,
      (tag) => {
        const relMatch = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
          tag,
        );
        const hrefMatch =
          /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        const rel = relMatch?.[1] ?? relMatch?.[2] ?? relMatch?.[3] ?? "";
        const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "";
        if (
          rel.toLowerCase() === "stylesheet" &&
          /(?:^|\/)viewer\.css(?:[?#].*)?$/i.test(href)
        ) {
          viewerCssInserted = true;
          return `${inlineViewerCss}${inlineBridgeCss}`;
        }
        return tag;
      },
    );
    if (!viewerCssInserted) {
      throw new Error("The bundled viewer.html does not reference viewer.css.");
    }
    const headMatch = /<head\b[^>]*>/i.exec(htmlWithInlineStyles);
    if (headMatch) {
      const withBase = htmlWithInlineStyles.replace(/<base\b[^>]*>/gi, "");
      return withBase.replace(/<head\b[^>]*>/i, `${headMatch[0]}${injection}`);
    }
    return `${injection}${htmlWithInlineStyles}`;
  }

  async openFile(file) {
    if (!isPdfFile(file)) {
      throw new Error("Only PDF files can be opened in this view.");
    }
    const request = ++this.openRequest;
    this.requestedPath = file.path;
    this.sessionId = makeToken();
    this.pendingBytes = null;
    try {
      const bytes = await this.app.vault.readBinary(file);
      if (request !== this.openRequest) {
        return;
      }
      // Keep a private copy for overwrite conflict detection. The original
      // buffer can then be transferred to the viewer without another copy.
      this.originalBytes = new Uint8Array(bytes.slice(0));
      this.pendingBytes = bytes;
      if (this.ready) {
        this.sendPendingDocument();
      }
    } catch (error) {
      if (request === this.openRequest) {
        this.showError(`无法读取 ${file.path}：${error.message}`);
      }
    }
  }

  onMessage(event) {
    if (!this.iframe || event.source !== this.iframe.contentWindow) {
      return;
    }
    const message = event.data;
    if (
      !message ||
      message.channel !== CHANNEL ||
      message.token !== this.token ||
      typeof message.type !== "string"
    ) {
      return;
    }
    if (message.documentId && message.documentId !== this.requestedPath) {
      return;
    }
    if (message.sessionId && message.sessionId !== this.sessionId) return;

    switch (message.type) {
      case "ready":
        this.ready = true;
        if (this.bridgeTimeout) {
          window.clearTimeout(this.bridgeTimeout);
          this.bridgeTimeout = null;
        }
        this.sendPendingDocument();
        break;
      case "save":
        if (message.sessionId !== this.sessionId) return;
        void this.saveFile(
          message.data,
          message.documentId,
          message.requestId,
          message.sessionId,
          message.automatic === true,
        );
        break;
      case "flush-result":
        if (
          message.sessionId === this.sessionId &&
          message.requestId === this.flushPending?.requestId
        )
          this.flushPending.finish(message.success === true);
        break;
      case "error":
        if (message.requestId) {
          this.lastSaveError = { code: message.code, message: message.message };
          return;
        }
        this.showError(message.message || "PDF 阅读器报告了错误。");
        break;
    }
  }

  sendPendingDocument() {
    if (!this.ready || !this.pendingBytes || !this.file) {
      return;
    }
    const data = this.pendingBytes;
    this.pendingBytes = null;
    const message = {
      channel: CHANNEL,
      type: "open",
      token: this.token,
      data,
      documentId: this.file.path,
      readOnly: false,
      sessionId: this.sessionId,
    };
    try {
      this.iframe.contentWindow.postMessage(message, "*", [data]);
    } catch {
      this.iframe.contentWindow.postMessage(message, "*");
    }
  }

  postToViewer(message, transfer = []) {
    const target = this.iframe?.contentWindow;
    if (!target) {
      return false;
    }
    try {
      target.postMessage(message, "*", transfer);
    } catch {
      if (transfer.length === 0) {
        return false;
      }
      try {
        target.postMessage(message, "*");
      } catch {
        return false;
      }
    }
    return true;
  }

  flushBeforeLeave() {
    if (!this.ready || !this.requestedPath || !this.iframe)
      return Promise.resolve(true);
    if (this.flushPending) return this.flushPending.promise;
    const requestId = makeToken();
    let finish;
    const promise = new Promise((resolve) => {
      finish = (success) => {
        clearTimeout(timer);
        this.flushPending = null;
        resolve(success);
      };
    });
    const timer = setTimeout(() => finish(false), 125000);
    this.flushPending = { requestId, promise, finish };
    if (
      !this.postToViewer({
        channel: CHANNEL,
        type: "flush-save",
        token: this.token,
        documentId: this.requestedPath,
        sessionId: this.sessionId,
        requestId,
      })
    )
      finish(false);
    return promise;
  }

  async saveFile(
    value,
    documentId,
    requestId,
    sessionId = this.sessionId,
    automatic = false,
  ) {
    if (this.saving) {
      this.postToViewer({
        channel: CHANNEL,
        type: "error",
        token: this.token,
        code: "busy",
        message: "已有保存操作正在进行，请稍后重试。",
        documentId,
        requestId,
        sessionId,
      });
      return;
    }
    this.saving = true;
    this.lastSaveError = null;
    const iframe = this.iframe;
    const openRequest = this.openRequest;
    try {
      const file = this.file;
      const originalBytes = this.originalBytes;
      if (!file || !originalBytes) {
        throw new Error("当前没有打开的 PDF 文件。");
      }
      if (documentId !== file.path || documentId !== this.requestedPath) {
        const mismatch = new Error(
          "保存请求对应的 PDF 与当前打开的文件不一致。",
        );
        mismatch.code = "document-mismatch";
        throw mismatch;
      }
      const latestFile = this.app.vault.getAbstractFileByPath(file.path);
      if (!isPdfFile(latestFile)) {
        throw new Error("原 PDF 已不在当前仓库中。");
      }

      const latestBytes = new Uint8Array(
        await this.app.vault.readBinary(latestFile),
      );
      if (!bytesEqual(latestBytes, originalBytes)) {
        const conflict = new Error(
          "PDF 在打开后已被其他操作修改。请重新打开文件后再保存，以免覆盖新内容。",
        );
        conflict.code = "conflict";
        throw conflict;
      }

      const data = toArrayBuffer(value);
      const savedBytes = new Uint8Array(data.slice(0));
      if (
        openRequest !== this.openRequest ||
        sessionId !== this.sessionId ||
        iframe !== this.iframe
      )
        throw new Error("PDF 保存会话已失效。");
      await this.app.vault.modifyBinary(latestFile, data);
      if (
        this.file?.path === latestFile.path &&
        this.openRequest === openRequest &&
        this.sessionId === sessionId
      ) {
        this.file = latestFile;
        this.originalBytes = savedBytes;
      }
      iframe?.contentWindow?.postMessage(
        {
          channel: CHANNEL,
          type: "saved",
          token: this.token,
          documentId: latestFile.path,
          requestId,
          sessionId,
        },
        "*",
      );
    } catch (error) {
      iframe?.contentWindow?.postMessage(
        {
          channel: CHANNEL,
          type: "error",
          token: this.token,
          code: error.code || "save-failed",
          message: error.message,
          documentId,
          requestId,
          sessionId,
        },
        "*",
      );
      this.lastSaveError = {
        code: error.code || "save-failed",
        message: error.message,
      };
      console.error("PDF save failed:", error);
    } finally {
      this.saving = false;
    }
  }

  showError(message) {
    new Notice(message, 8000);
  }
}

module.exports = class PdfWebReaderPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new PdfReaderView(leaf, this));
    this.pdfOpenRouting = installPdfOpenRouting(this);
    this.addCommand({
      id: "open-current-pdf",
      name: "在 PDF 阅读器中打开当前 PDF",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isPdfFile(file)) {
          return false;
        }
        if (!checking) {
          void this.openPdf(file);
        }
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!isPdfFile(file)) {
          return;
        }
        menu.addItem((item) => {
          item
            .setTitle("使用 PDF 阅读器打开")
            .setIcon("file-text")
            .onClick(() => void this.openPdf(file));
        });
      }),
    );
  }

  onunload() {
    restorePdfOpenRouting(this.pdfOpenRouting);
    this.pdfOpenRouting = null;
    this.viewerAssetsPromise = null;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  ensureViewerAssets() {
    if (!this.viewerAssetsPromise) {
      const pluginRoot = normalizePath(
        `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
      );
      const pending = Promise.resolve()
        .then(() =>
          ensureViewerAssets(
            this.app.vault.adapter,
            pluginRoot,
            VIEWER_ASSET_PAYLOAD,
          ),
        )
        .finally(() => {
          if (this.viewerAssetsPromise === pending) {
            this.viewerAssetsPromise = null;
          }
        });
      this.viewerAssetsPromise = pending;
    }
    return this.viewerAssetsPromise;
  }

  async openPdf(file) {
    if (!isPdfFile(file)) {
      new Notice("请选择一个 PDF 文件。");
      return;
    }
    const existingLeaf = this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .find(
        (leaf) =>
          leaf.view instanceof PdfReaderView &&
          (leaf.view.requestedPath === file.path ||
            leaf.view.file?.path === file.path),
      );
    if (existingLeaf) {
      await existingLeaf.setViewState({
        type: VIEW_TYPE,
        active: true,
        state: existingLeaf.view.getState(),
      });
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE,
      active: true,
      state: { path: file.path },
    });
  }
};
