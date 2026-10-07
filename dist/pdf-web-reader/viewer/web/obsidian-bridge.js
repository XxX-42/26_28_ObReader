/*
 * Obsidian host bridge for the packaged PDF.js viewer.
 *
 * The host inserts this classic script before viewer.mjs and supplies
 * data-channel and data-token attributes on the script element. Keeping this
 * script outside the upstream fork lets the Viewer run without its localhost
 * file server while retaining the fork's annotation editors and serializers.
 */
(() => {
  "use strict";

  const bridgeScript = document.currentScript;
  if (!bridgeScript || window.parent === window) {
    return;
  }

  const channel = bridgeScript.dataset.channel || "pdf-web-reader";
  const token = bridgeScript.dataset.token;
  if (!token) {
    console.error("PDF Reader bridge is missing its session token.");
    return;
  }

  const viewerBaseUrl = new URL(".", bridgeScript.src || document.baseURI);
  const state = {
    app: null,
    pdfJsOpen: null,
    configured: false,
    disposed: false,
    ready: false,
    activeDocumentId: null,
    activeFilename: null,
    readOnly: false,
    revision: 0,
    openQueue: Promise.resolve(),
    queuedOpens: [],
    savePromise: null,
    pendingSave: null,
    saveSequence: 0,
    storageCleanup: null,
    statusTimer: null,
    statusElement: null,
    readOnlyButtonStates: null,
    eventAbortController: null,
    localOpenAbortController: null,
    startupTimer: null,
    startupFailed: false,
  };

  function postToHost(type, fields = {}, transfer = []) {
    if (state.disposed) {
      return false;
    }
    try {
      window.parent.postMessage(
        { channel, type, token, ...fields },
        "*",
        transfer,
      );
      return true;
    } catch (error) {
      console.error("PDF Reader bridge could not message its host:", error);
      return false;
    }
  }

  function showStatus(message) {
    if (!message || state.disposed) {
      return;
    }
    if (!state.statusElement && document.body) {
      const element = document.createElement("div");
      element.id = "pdfReaderBridgeStatus";
      element.className = "pdfReaderBridgeStatus";
      element.setAttribute("role", "status");
      element.setAttribute("aria-live", "polite");
      document.body.append(element);
      state.statusElement = element;
    }
    if (state.statusElement) {
      state.statusElement.textContent = message;
      state.statusElement.hidden = false;
      clearTimeout(state.statusTimer);
      state.statusTimer = setTimeout(() => {
        if (state.statusElement) {
          state.statusElement.hidden = true;
        }
      }, 7000);
    }
  }

  function sendError(
    message,
    { documentId = null, requestId = null, code } = {},
  ) {
    const fields = { message: String(message || "PDF viewer error") };
    if (typeof documentId === "string") {
      fields.documentId = documentId;
    }
    if (typeof requestId === "string") {
      fields.requestId = requestId;
    }
    if (typeof code === "string") {
      fields.code = code;
    }
    postToHost("error", fields);
    showStatus(fields.message);
  }

  function resourceUrl(path) {
    return new URL(path, viewerBaseUrl).href;
  }

  function ensureViewerLayout() {
    const viewerContainer = document.getElementById("viewerContainer");
    if (
      !viewerContainer ||
      getComputedStyle(viewerContainer).position === "absolute"
    ) {
      return;
    }

    // Some Obsidian app:// srcdoc combinations report the packaged stylesheet
    // as loaded while its rules are not yet in the cascade when PDFViewer is
    // constructed. PDF.js requires an absolutely positioned viewer container
    // and aborts initialization otherwise. Add only the viewer's critical
    // layout rules as a last-resort stylesheet; the normal viewer.css remains
    // responsible for the full UI and its more-specific state selectors.
    if (document.getElementById("pdfReaderViewerLayoutFallback")) {
      return;
    }
    const style = document.createElement("style");
    style.id = "pdfReaderViewerLayoutFallback";
    style.textContent = `
      html, body { width: 100%; height: 100%; overflow: hidden; }
      body { margin: 0; }
      #outerContainer { width: 100%; height: 100%; position: relative; margin: 0; }
      #mainContainer {
        position: absolute;
        inset: 0;
        min-width: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
      }
      #viewerContainer {
        position: absolute;
        inset: var(--toolbar-height, 32px) 0 0;
        overflow: auto;
        outline: none;
        z-index: 0;
      }
    `;
    (document.head || document.documentElement).append(style);
  }

  function labelSaveControls() {
    const title = "保存 PDF 到仓库（覆盖当前文件）";
    for (const id of ["downloadButton", "secondaryDownload"]) {
      const button = document.getElementById(id);
      if (!button) {
        continue;
      }
      button.removeAttribute("data-l10n-id");
      button.removeAttribute("data-l10n-args");
      button.title = title;
      button.setAttribute("aria-label", title);

      const label = button.querySelector("span");
      if (label) {
        label.removeAttribute("data-l10n-id");
        label.removeAttribute("data-l10n-args");
        label.textContent = "保存到仓库";
      }
    }
  }

  function makeArrayBuffer(value) {
    if (value instanceof ArrayBuffer) {
      return value;
    }
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      );
    }
    throw new TypeError("PDF.js returned an unsupported PDF byte buffer.");
  }

  function snapshotChanges(app) {
    return (
      app._captureDirtySnapshot?.() || {
        hadAnnotationChanges: !!app._annotationStorageModified,
        hadStructuralChanges:
          !!app.pdfThumbnailViewer?.hasStructuralChanges?.(),
      }
    );
  }

  function restoreChanges(app, snapshot) {
    if (typeof app._restoreDirtySnapshot === "function") {
      app._restoreDirtySnapshot(snapshot);
      return;
    }
    if (snapshot.hadAnnotationChanges) {
      app._annotationStorageModified = true;
    } else {
      delete app._annotationStorageModified;
    }
    app._updateOverwriteOriginalState?.();
    app.setTitle?.();
  }

  function makeSaveRequestId() {
    state.saveSequence += 1;
    return `save-${Date.now().toString(36)}-${state.saveSequence.toString(36)}`;
  }

  function waitForHostSave({ data, documentId, filename, requestId }) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (state.pendingSave?.requestId !== requestId) {
          return;
        }
        state.pendingSave = null;
        reject(new Error("Timed out waiting for Obsidian to save the PDF."));
      }, 120000);

      state.pendingSave = {
        documentId,
        requestId,
        resolve: () => {
          clearTimeout(timeout);
          state.pendingSave = null;
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          state.pendingSave = null;
          reject(error);
        },
      };

      if (
        !postToHost("save", { data, documentId, filename, requestId }, [data])
      ) {
        clearTimeout(timeout);
        state.pendingSave = null;
        reject(new Error("Could not send the PDF to Obsidian for saving."));
      }
    });
  }

  async function requestSave() {
    if (state.savePromise) {
      return state.savePromise;
    }

    const app = state.app;
    const pdfDocument = app?.pdfDocument;
    const documentId = state.activeDocumentId;
    if (!app || !pdfDocument || !documentId) {
      return false;
    }
    if (state.readOnly) {
      showStatus("This PDF is read-only.");
      return false;
    }

    app.pdfViewer?._layerProperties?.annotationEditorUIManager?.commitOrRemove?.();
    const revisionAtStart = state.revision;
    const dirtySnapshot = snapshotChanges(app);
    const requestId = makeSaveRequestId();
    state.savePromise = (async () => {
      let willSaveDispatched = false;
      app._saveInProgress = true;
      app.appConfig?.appContainer?.classList.add("wait");
      app._updateOverwriteOriginalState?.();

      try {
        await app.pdfScriptingManager?.dispatchWillSave?.();
        willSaveDispatched = true;

        const hasStructuralChanges =
          app.pdfThumbnailViewer?.hasStructuralChanges?.() || false;
        if (hasStructuralChanges) {
          throw new Error(
            "Page reordering is unavailable in the Obsidian PDF viewer.",
          );
        }
        const hasAnnotationChanges =
          app._annotationStorageModified ||
          pdfDocument.annotationStorage?.size > 0;
        const bytes = hasAnnotationChanges
          ? await pdfDocument.saveDocument()
          : await pdfDocument.getData();

        if (!bytes) {
          throw new Error("PDF.js did not produce PDF data to save.");
        }
        if (willSaveDispatched) {
          await app.pdfScriptingManager?.dispatchDidSave?.();
          willSaveDispatched = false;
        }

        // PDFDocumentProxy.saveDocument resets AnnotationStorage's modified
        // flag as soon as serialization finishes. Keep the UI dirty until the
        // host confirms that the vault write itself succeeded.
        restoreChanges(app, dirtySnapshot);
        const buffer = makeArrayBuffer(bytes);
        await waitForHostSave({
          data: buffer,
          documentId,
          filename: state.activeFilename || "document.pdf",
          requestId,
        });

        if (
          app.pdfDocument === pdfDocument &&
          state.activeDocumentId === documentId
        ) {
          if (state.revision === revisionAtStart) {
            pdfDocument.annotationStorage?.resetModified?.();
            restoreChanges(app, {
              hadAnnotationChanges: false,
              hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
            });
          } else {
            restoreChanges(app, {
              hadAnnotationChanges: true,
              hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
            });
          }
        }
        return true;
      } catch (error) {
        if (willSaveDispatched) {
          try {
            await app.pdfScriptingManager?.dispatchDidSave?.();
          } catch {
            // Keep the original save error as the user-visible failure.
          }
        }
        if (app.pdfDocument === pdfDocument) {
          restoreChanges(app, {
            hadAnnotationChanges:
              dirtySnapshot.hadAnnotationChanges ||
              state.revision !== revisionAtStart,
            hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
          });
        }
        if (!error?.fromHost) {
          sendError(error?.message || "Could not save the PDF.", {
            documentId,
            requestId,
            code: "save-failed",
          });
        } else {
          showStatus(error.message || "Obsidian could not save the PDF.");
        }
        return false;
      } finally {
        app._saveInProgress = false;
        app.appConfig?.appContainer?.classList.remove("wait");
        app._updateOverwriteOriginalState?.();
        app.setTitle?.();
      }
    })().finally(() => {
      state.savePromise = null;
    });

    return state.savePromise;
  }

  function cleanupStorageObserver() {
    state.storageCleanup?.();
    state.storageCleanup = null;
  }

  function observeAnnotationStorage(storage) {
    cleanupStorageObserver();
    if (!storage) {
      return;
    }
    const previousOnModified = storage.onModified;
    const wrappedOnModified = () => {
      state.revision += 1;
      previousOnModified?.();
    };
    storage.onModified = wrappedOnModified;
    state.storageCleanup = () => {
      if (storage.onModified === wrappedOnModified) {
        storage.onModified = previousOnModified;
      }
    };
  }

  function basename(documentId) {
    const parts = documentId.split(/[\\/]/);
    return parts.at(-1) || "document.pdf";
  }

  function queueOpen(message) {
    if (!state.ready) {
      state.queuedOpens.push(message);
      return;
    }
    state.openQueue = state.openQueue
      .then(() => openDocument(message))
      .catch((error) => {
        sendError(error?.message || "Could not open the PDF.", {
          documentId: message.documentId,
          code: "open-failed",
        });
      });
  }

  function waitForDocumentLoaded(app) {
    let onLoaded;
    let onError;
    let resolveLoaded;
    let rejectLoaded;
    const promise = new Promise((resolve, reject) => {
      resolveLoaded = resolve;
      rejectLoaded = reject;
    });
    promise.catch(() => {});
    const cleanup = () => {
      app.eventBus._off("documentloaded", onLoaded);
      app.eventBus._off("documenterror", onError);
    };
    onLoaded = () => {
      cleanup();
      resolveLoaded();
    };
    onError = ({ message: errorMessage }) => {
      cleanup();
      rejectLoaded(new Error(errorMessage || "PDF.js could not load the PDF."));
    };
    app.eventBus._on("documentloaded", onLoaded, { once: true });
    app.eventBus._on("documenterror", onError, { once: true });
    return { promise, cleanup };
  }

  async function openDocument(message) {
    const { app } = state;
    const documentId = message.documentId;
    const filename = basename(documentId);
    const loadWaiter = waitForDocumentLoaded(app);

    try {
      state.activeDocumentId = null;
      state.activeFilename = null;
      state.readOnly = false;
      state.revision = 0;
      const data = new Uint8Array(message.data);
      if (typeof state.pdfJsOpen !== "function") {
        throw new Error("PDF.js open handler is unavailable.");
      }
      await state.pdfJsOpen.call(app, {
        data,
        filename,
        sourceKind: "generic-source",
        localSessionId: null,
        canOverwriteOriginal: false,
      });

      await loadWaiter.promise;
      cleanupStorageObserver();
      state.activeDocumentId = documentId;
      state.activeFilename = filename;
      state.readOnly = message.readOnly === true;
      state.revision = 0;
      app._contentDispositionFilename = filename;
      app.setTitle(filename);
      observeAnnotationStorage(app.pdfDocument?.annotationStorage);
      setReadOnlyState(state.readOnly);

      if (state.activeDocumentId !== documentId || state.disposed) {
        return;
      }
      postToHost("opened", { documentId, filename });
    } catch (error) {
      cleanupStorageObserver();
      state.activeDocumentId = null;
      state.activeFilename = null;
      state.readOnly = false;
      setReadOnlyState(false);
      sendError(error?.message || "Could not open the PDF.", {
        documentId,
        code: "open-failed",
      });
    } finally {
      loadWaiter.cleanup();
    }
  }

  const readOnlyToolIds = [
    "editorUnderlineButton",
    "editorSquareButton",
    "editorHighlightButton",
    "editorInkButton",
    "editorFreeTextButton",
    "editorCommentButton",
    "editorEraserButton",
    "editorStampButton",
    "editorSignatureButton",
  ];

  function setReadOnlyState(readOnly) {
    document.documentElement.toggleAttribute(
      "data-pdf-reader-readonly",
      readOnly,
    );
    if (readOnly && !state.readOnlyButtonStates) {
      state.readOnlyButtonStates = new Map();
    }
    for (const id of readOnlyToolIds) {
      const button = document.getElementById(id);
      if (button) {
        if (readOnly) {
          state.readOnlyButtonStates?.set(id, button.disabled);
          button.disabled = true;
        } else if (state.readOnlyButtonStates?.has(id)) {
          button.disabled = state.readOnlyButtonStates.get(id);
        }
      }
    }
    if (!readOnly) {
      state.readOnlyButtonStates = null;
    }
  }

  function onReadOnlyHotkey(event) {
    if (
      !state.readOnly ||
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    const target = event.target;
    if (
      target instanceof Element &&
      (target.matches(
        "input, textarea, select, [contenteditable='true'], [role='textbox']",
      ) ||
        target.closest(
          "input, textarea, select, [contenteditable='true'], [role='textbox']",
        ))
    ) {
      return;
    }
    if (/^[1-5]$/.test(event.key) || /^Numpad[1-5]$/.test(event.code)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function onViewerBeforeUnload(event) {
    // Obsidian owns the view lifecycle and its file-save flow. Do not let the
    // generic browser Viewer open a page-unload confirmation inside its iframe.
    event.stopImmediatePropagation();
  }

  function onHostMessage(event) {
    if (event.source !== window.parent) {
      return;
    }
    const message = event.data;
    if (
      !message ||
      typeof message !== "object" ||
      message.channel !== channel ||
      message.token !== token
    ) {
      return;
    }

    if (message.type === "open") {
      if (
        typeof message.documentId !== "string" ||
        !(message.data instanceof ArrayBuffer)
      ) {
        sendError("The host sent an invalid PDF open request.", {
          documentId:
            typeof message.documentId === "string" ? message.documentId : null,
          code: "invalid-open-request",
        });
        return;
      }
      queueOpen(message);
      return;
    }

    if (message.type === "saved" || message.type === "error") {
      const pending = state.pendingSave;
      if (
        !pending ||
        message.requestId !== pending.requestId ||
        message.documentId !== pending.documentId
      ) {
        return;
      }
      if (message.type === "saved") {
        pending.resolve();
      } else {
        const error = new Error(
          message.message || "Obsidian could not save the PDF.",
        );
        error.code = message.code;
        error.fromHost = true;
        pending.reject(error);
      }
    }
  }

  function installAppHooks(app) {
    state.app = app;

    // Retain PDF.js's loader for documents explicitly supplied by Obsidian,
    // but prevent the Viewer file picker/drop path from changing the document
    // while the bridge still associates saves with the host's vault path.
    state.pdfJsOpen = app.open;
    app.open = async () => {
      showStatus("Open PDFs from the Obsidian file list.");
      return false;
    };
    const localOpenGuard = (event) => {
      const target = event.target;
      const isFileInputChange =
        event.type === "change" &&
        target instanceof HTMLInputElement &&
        target.type === "file";
      const transfer = event.dataTransfer;
      const containsFiles =
        !!transfer?.files?.length ||
        Array.from(transfer?.items || []).some((item) => item.kind === "file");

      if (!isFileInputChange && !containsFiles) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      showStatus("Open PDFs from the Obsidian file list.");
    };
    state.localOpenAbortController = new AbortController();
    for (const type of ["change", "dragover", "drop"]) {
      document.addEventListener(type, localOpenGuard, {
        capture: true,
        signal: state.localOpenAbortController.signal,
      });
    }

    const originalRun = app.run;
    app.run = async function (config) {
      try {
        return await originalRun.call(this, config);
      } catch (error) {
        state.startupFailed = true;
        clearTimeout(state.startupTimer);
        console.error("PDF.js viewer initialization failed:", error);
        sendError(error?.message || "Could not initialize the PDF viewer.", {
          documentId: state.activeDocumentId,
          code: "viewer-init-failed",
        });
        return undefined;
      }
    };

    // PDF.js binds these methods to its event bus during run(). Replacing them
    // during webviewerloaded ensures toolbar save/download actions go to the
    // host instead of starting a browser download or local-server request.
    app.downloadOrSave = requestSave;
    app.downloadCopy = requestSave;
    app.save = requestSave;
    app._openLocalFile = async () => {
      showStatus("Open PDFs from the Obsidian file list.");
      return true;
    };
    // PDF.js maps Ctrl+S to `overwriteoriginal`, while toolbar download/save
    // controls use `download` / `downloadcopy`. Route all of them through the
    // same host-mediated save path; do not invoke the fork's local-session API.
    app.overwriteOriginal = requestSave;
    app._scheduleAutoOverwriteOriginal = () => {};
    app._clearAutoOverwriteOriginalTimer?.();

    app.initializedPromise
      .then(() => {
        if (state.disposed || state.startupFailed) {
          return;
        }
        clearTimeout(state.startupTimer);
        state.eventAbortController = new AbortController();
        app.eventBus?._on(
          "annotationeditormodechanged",
          () => {
            if (state.readOnly) {
              setReadOnlyState(true);
            }
          },
          { signal: state.eventAbortController.signal },
        );
        for (const id of [
          "openFile",
          "secondaryOpenFile",
          "overwriteOriginalButton",
          "secondaryOverwriteOriginal",
        ]) {
          const button = document.getElementById(id);
          if (button) {
            button.hidden = true;
          }
        }
        labelSaveControls();
        state.ready = true;
        postToHost("ready");
        for (const message of state.queuedOpens.splice(0)) {
          queueOpen(message);
        }
      })
      .catch((error) => {
        state.startupFailed = true;
        clearTimeout(state.startupTimer);
        sendError(error?.message || "Could not initialize the PDF viewer.", {
          code: "viewer-init-failed",
        });
      });

    state.startupTimer = setTimeout(() => {
      if (state.ready || state.disposed || state.startupFailed) {
        return;
      }
      state.startupFailed = true;
      const diagnostics = {
        eventBus: !!app.eventBus,
        l10n: !!app.l10n,
        pdfViewer: !!app.pdfViewer,
        thumbnailViewer: !!app.pdfThumbnailViewer,
        initialized: !!app.initialized,
      };
      console.error("PDF.js viewer initialization stalled:", diagnostics);
      sendError(
        `PDF viewer initialization timed out (${Object.entries(diagnostics)
          .map(([name, ready]) => `${name}=${ready ? "yes" : "no"}`)
          .join(", ")}).`,
        { code: "viewer-init-timeout" },
      );
    }, 15000);
  }

  function configureBeforeViewerRun(event) {
    if (state.configured) {
      return true;
    }
    if (event?.detail?.source && event.detail.source !== window) {
      return false;
    }
    const app = window.PDFViewerApplication;
    const options = window.PDFViewerApplicationOptions;
    if (!app || !options?.setAll) {
      return false;
    }

    options.setAll({
      defaultUrl: "",
      disablePreferences: true,
      enableScripting: false,
      enableAltText: false,
      enableGuessAltText: false,
      enableAltTextModelDownload: false,
      enableFakeMLManager: false,
      enablePermissions: true,
      enableMerge: false,
      enableSplitMerge: false,
      workerSrc: resourceUrl("../build/pdf.worker.mjs"),
      cMapUrl: resourceUrl("./cmaps/"),
      iccUrl: resourceUrl("./iccs/"),
      standardFontDataUrl: resourceUrl("./standard_fonts/"),
      wasmUrl: resourceUrl("./wasm/"),
      imageResourcesPath: resourceUrl("./images/"),
    });

    ensureViewerLayout();
    state.configured = true;
    installAppHooks(app);
    return true;
  }

  function onViewerLoaded(event) {
    if (configureBeforeViewerRun(event)) {
      removeViewerLoadedListeners();
    }
  }

  function removeViewerLoadedListeners() {
    document.removeEventListener("webviewerloaded", onViewerLoaded, true);
    try {
      window.parent.document.removeEventListener(
        "webviewerloaded",
        onViewerLoaded,
        true,
      );
    } catch {
      // The generic Viewer also dispatches on its own document if the parent
      // document cannot be accessed.
    }
  }

  function dispose() {
    if (state.disposed) {
      return;
    }
    state.disposed = true;
    removeViewerLoadedListeners();
    window.removeEventListener("message", onHostMessage);
    window.removeEventListener("keydown", onReadOnlyHotkey, true);
    window.removeEventListener("beforeunload", onViewerBeforeUnload, true);
    window.removeEventListener("pagehide", dispose);
    window.removeEventListener("unload", dispose);
    clearTimeout(state.statusTimer);
    clearTimeout(state.startupTimer);
    cleanupStorageObserver();
    state.eventAbortController?.abort();
    state.eventAbortController = null;
    state.localOpenAbortController?.abort();
    state.localOpenAbortController = null;

    if (state.pendingSave) {
      state.pendingSave.reject(new Error("The PDF view was closed."));
    }
    const loadingTask = state.app?.pdfLoadingTask;
    if (loadingTask) {
      void loadingTask.destroy().catch(() => {});
    }
  }

  window.addEventListener("message", onHostMessage);
  window.addEventListener("keydown", onReadOnlyHotkey, true);
  window.addEventListener("beforeunload", onViewerBeforeUnload, true);
  window.addEventListener("pagehide", dispose, { once: true });
  window.addEventListener("unload", dispose, { once: true });
  document.addEventListener("webviewerloaded", onViewerLoaded, true);
  try {
    window.parent.document.addEventListener(
      "webviewerloaded",
      onViewerLoaded,
      true,
    );
  } catch {
    // The embedded Viewer falls back to dispatching webviewerloaded locally.
  }
})();
