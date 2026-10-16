(() => {
  "use strict";

  const EMBEDDED_EDITOR_TYPES = new Map([
    [3, "FreeText"],
    [5, "Square"],
    [9, "Highlight"],
    [10, "Underline"],
    [15, "Ink"],
  ]);

  function copyFiniteNumbers(value, { length = null, minimumLength = 0, multiple = 1 } = {}) {
    if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
    const copy = Array.from(value);
    if (
      (length !== null && copy.length !== length) ||
      copy.length < minimumLength ||
      copy.length % multiple !== 0 ||
      !copy.every((number) => typeof number === "number" && Number.isFinite(number))
    ) {
      return null;
    }
    return copy;
  }

  function copyNativeRect(value) {
    const rect = copyFiniteNumbers(value, { length: 4 });
    return rect && rect[0] < rect[2] && rect[1] < rect[3] ? rect : null;
  }

  function copyNativePointLists(value) {
    if (!Array.isArray(value) || value.length === 0) return null;
    const lists = value.map((points) =>
      copyFiniteNumbers(points, { minimumLength: 2, multiple: 2 }),
    );
    return lists.every(Boolean) ? lists : null;
  }

  function copyNativeMetadata(annotation, payload) {
    const popupRef = annotation.popupRef;
    if (typeof popupRef === "string") payload.popupRef = popupRef;
    for (const key of ["creationDate", "modificationDate"]) {
      if (typeof annotation[key] === "string" || annotation[key] === null) {
        payload[key] = annotation[key];
      }
    }
    const comment = annotation.contentsObj?.str;
    if (typeof comment === "string" && comment) payload.comment = comment;
    if (annotation.richText && typeof annotation.richText === "object") {
      payload.richText = annotation.richText;
    }
  }

  function canonicalEmbeddedAnnotationRef(value) {
    if (typeof value === "string") {
      const pdfJsRef = /^(\d+)R(\d+)?$/.exec(value);
      if (pdfJsRef) return `${pdfJsRef[1]}R${pdfJsRef[2] === "0" ? "" : pdfJsRef[2] || ""}`;
      const pdfLibRef = /^(\d+)\s+(\d+)\s+R$/.exec(value);
      if (pdfLibRef) return `${pdfLibRef[1]}R${pdfLibRef[2] === "0" ? "" : pdfLibRef[2]}`;
      return null;
    }
    const ref = value;
    if (
      ref && Number.isSafeInteger(ref.num) && ref.num >= 0 &&
      Number.isSafeInteger(ref.gen) && ref.gen >= 0
    ) {
      return `${ref.num}R${ref.gen === 0 ? "" : ref.gen}`;
    }
    return null;
  }

  function embeddedAnnotationRef(annotation) {
    return canonicalEmbeddedAnnotationRef(annotation?.id) ||
      canonicalEmbeddedAnnotationRef(annotation?.ref);
  }

  function copyEmbeddedEditorPayload(annotation, pageIndex, ref) {
    const sourceAnnotationType = annotation.annotationType;
    if (!EMBEDDED_EDITOR_TYPES.has(sourceAnnotationType)) return null;
    const isInkHighlight = sourceAnnotationType === 15 && annotation.it === "InkHighlight";
    const annotationType = isInkHighlight ? 9 : sourceAnnotationType;

    const rect = copyNativeRect(annotation.rect);
    const color = annotationType === 3
      ? copyFiniteNumbers(annotation.defaultAppearanceData?.fontColor, { length: 3 })
      : copyFiniteNumbers(annotation.color, { length: 3 }) ||
        ([5, 10].includes(annotationType) && annotation.color == null ? [0, 0, 0] : null);
    const rotation = [5, 10].includes(annotationType) ? 0 : (annotation.rotation ?? 0);
    if (
      !rect || !color || !Number.isInteger(rotation) ||
      rotation < 0 || rotation >= 360 || rotation % 90 !== 0
    ) {
      return null;
    }

    const payload = {
      annotationType,
      pageIndex,
      rect,
      rotation,
      color,
      annotationElementId: ref,
      id: ref,
      deleted: false,
    };
    copyNativeMetadata(annotation, payload);

    if (annotationType === 3) {
      const textContent = annotation.textContent;
      const appearance = annotation.defaultAppearanceData;
      const fontColor = copyFiniteNumbers(appearance?.fontColor, { length: 3 });
      const fontSize = appearance?.fontSize;
      if (
        !Array.isArray(textContent) || textContent.length === 0 ||
        !textContent.every((line) => typeof line === "string") ||
        !fontColor || !Number.isFinite(fontSize) || fontSize <= 0
      ) {
        return null;
      }
      payload.color = fontColor;
      payload.fontSize = fontSize;
      payload.value = textContent.join("\n");
      if (Array.isArray(annotation.textPosition)) {
        const position = copyFiniteNumbers(annotation.textPosition, { length: 2 });
        if (!position) return null;
        payload.position = position;
      }
      return payload;
    }

    const rawOpacity = annotation.opacity;
    const opacity = [9, 15].includes(sourceAnnotationType)
      ? (rawOpacity || 1)
      : (rawOpacity ?? 1);
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) return null;
    payload.opacity = opacity;

    if (annotationType === 15) {
      const points = copyNativePointLists(annotation.inkLists);
      const thickness = annotation.borderStyle?.rawWidth ?? 1;
      if (!points || !Number.isFinite(thickness) || thickness < 0) return null;
      payload.thickness = thickness;
      payload.paths = { points };
      payload.boxes = null;
      return payload;
    }

    if (annotationType === 9) {
      if (annotation.quadPoints != null) {
        const quadPoints = copyFiniteNumbers(annotation.quadPoints, {
          minimumLength: 8,
          multiple: 8,
        });
        if (!quadPoints) return null;
        payload.quadPoints = quadPoints;
        payload.boxes = null;
        return payload;
      }
      const inkLists = copyNativePointLists(annotation.inkLists);
      const thickness = annotation.borderStyle?.rawWidth;
      if (!inkLists || !Number.isFinite(thickness) || thickness <= 0) return null;
      payload.thickness = thickness;
      payload.inkLists = inkLists;
      payload.boxes = null;
      return payload;
    }

    const thickness = annotation.borderStyle?.rawWidth || 1;
    if (!Number.isFinite(thickness) || thickness <= 0) return null;
    payload.thickness = thickness;
    if (annotationType === 10) {
      const quadPoints = copyFiniteNumbers(annotation.quadPoints, {
        minimumLength: 8,
        multiple: 8,
      });
      if (!quadPoints) return null;
      payload.quadPoints = quadPoints;
    } else if (annotation.quadPoints != null) {
      const quadPoints = copyFiniteNumbers(annotation.quadPoints, {
        minimumLength: 8,
        multiple: 8,
      });
      if (!quadPoints) return null;
      payload.quadPoints = quadPoints;
    }
    return payload;
  }

  class AnnotationController {
    // Rendering-only mask: PDF.js uses modifiedIds to exclude original AP
    // operators. No source bytes or persisted AnnotationStorage values change.
    setEmbeddedDeletionMask(storage, references) {
      if (!storage) return false;
      this.embeddedRenderMasks ||= new WeakMap();
      let mask = this.embeddedRenderMasks.get(storage);
      if (!mask) {
        let proto = storage;
        let descriptor;
        while (proto && !descriptor) {
          descriptor = Object.getOwnPropertyDescriptor(proto, "modifiedIds");
          proto = Object.getPrototypeOf(proto);
        }
        if (!descriptor?.get) return false;
        mask = { ids: new Set(), original: descriptor.get };
        Object.defineProperty(storage, "modifiedIds", {
          configurable: true,
          get() {
            const original = mask.original.call(this);
            if (!mask.ids.size) return original;
            const ids = new Set([...original.ids, ...mask.ids]);
            return { ids, hash: [...ids].sort().join(",") };
          },
        });
        this.embeddedRenderMasks.set(storage, mask);
      }
      const next = new Set(references);
      if (next.size === mask.ids.size && [...next].every(id => mask.ids.has(id))) return false;
      mask.ids = next;
      return true;
    }

    constructor({
      getManager = () => null,
      getPdfViewer = () => null,
      getEraser = () => null,
      getEditorMode = () => 0,
      getPdfViewerMode = () => 0,
      isPointerSessionCurrent = () => true,
      isTextSelectionValid = () => false,
      hasOtherActivePenPointer = () => false,
      isClosingOrDisposed = () => false,
      isPendingHighlight = () => false,
      clearPendingHighlight = () => {},
      clearToolWheel = () => {},
      onTransformCancel = () => {},
    } = {}) {
      this.getManager = getManager;
      this.getPdfViewer = getPdfViewer;
      this.getEraser = getEraser;
      this.getEditorMode = getEditorMode;
      this.getPdfViewerMode = getPdfViewerMode;
      this.isPointerSessionCurrent = isPointerSessionCurrent;
      this.isTextSelectionValid = isTextSelectionValid;
      this.hasOtherActivePenPointer = hasOtherActivePenPointer;
      this.isClosingOrDisposed = isClosingOrDisposed;
      this.isPendingHighlight = isPendingHighlight;
      this.clearPendingHighlight = clearPendingHighlight;
      this.clearToolWheel = clearToolWheel;
      this.onTransformCancel = onTransformCancel;
    }

    pointerInteractionKind(intent, {
      interactionMode = "READ",
    } = {}) {
      if (intent.button === 0) {
        if (intent.targetRole === "annotation-layer") return "editor";
        if (
          window.PdfReaderInputRuntime.InteractionMode.isTextSelectionMode(
            interactionMode,
          ) && intent.targetRole === "text-layer"
        ) {
          return "text-selection";
        }
        return null;
      }
      if (
        intent.pointerType !== "mouse" ||
        intent.nativeContextTarget === true ||
        ["text-control", "native-control", "outside-viewer"].includes(intent.targetRole) ||
        !["viewer", "text-layer", "annotation-layer"].includes(intent.targetRole)
      ) {
        return null;
      }
      if (intent.button === 1) return "tool-wheel";
      if (intent.button === 2) return "right-eraser";
      return null;
    }

    nativeOperation(intent) {
      if (intent.button !== 0 || !["mouse", "pen"].includes(intent.pointerType)) {
        return null;
      }
      return ["move", "resize"].includes(intent.nativeOperation)
        ? intent.nativeOperation
        : null;
    }

    async scanEmbeddedDeletionTargets(pdfDocument, documentId, {
      pageIndex = null,
      isCurrent = () => true,
      resolveUuid = () => null,
    } = {}) {
      const assertCurrent = () => {
        if (isCurrent()) return;
        const error = new Error("The PDF session changed during annotation scanning.");
        error.name = "AbortError";
        error.code = "ERR_ANNOTATION_SCAN_STALE_SESSION";
        throw error;
      };
      if (!pdfDocument || !Number.isSafeInteger(pdfDocument.numPages) || pdfDocument.numPages < 0) {
        throw new TypeError("A loaded PDF document with a valid page count is required.");
      }
      if (typeof isCurrent !== "function" || typeof resolveUuid !== "function") {
        throw new TypeError("Annotation scanning callbacks must be functions.");
      }
      if (
        pageIndex !== null &&
        (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdfDocument.numPages)
      ) {
        throw new RangeError("The requested annotation page is outside the PDF document.");
      }

      assertCurrent();
      const targets = [];
      const firstPage = pageIndex === null ? 0 : pageIndex;
      const lastPage = pageIndex === null ? pdfDocument.numPages : pageIndex + 1;
      for (let currentPage = firstPage; currentPage < lastPage; currentPage += 1) {
        assertCurrent();
        const pageRequest = pdfDocument.getPage(currentPage + 1);
        assertCurrent();
        const pdfPage = await pageRequest;
        assertCurrent();
        if (typeof pdfPage?.getAnnotations !== "function") {
          throw new TypeError("The PDF page does not expose native annotations.");
        }

        const annotationRequest = pdfPage.getAnnotations({ intent: "any" });
        assertCurrent();
        const annotations = await annotationRequest;
        assertCurrent();
        if (!Array.isArray(annotations)) {
          throw new TypeError("The PDF page returned an invalid annotation list.");
        }

        for (const annotation of annotations) {
          assertCurrent();
          const ref = embeddedAnnotationRef(annotation);
          if (!ref) continue;
          const editorPayload = copyEmbeddedEditorPayload(annotation, currentPage, ref);
          if (!editorPayload) continue;

          let uuid = resolveUuid(ref, currentPage, annotation);
          if (uuid && typeof uuid.then === "function") {
            assertCurrent();
            uuid = await uuid;
            assertCurrent();
          } else {
            assertCurrent();
          }
          if (typeof uuid !== "string" || !uuid) {
            uuid = `embedded-v1:${documentId}:${currentPage}:${ref}`;
          }
          targets.push({
            uuid,
            pageIndex: currentPage,
            kind: editorPayload.annotationType === 9 && editorPayload.inkLists
              ? "InkHighlight"
              : EMBEDDED_EDITOR_TYPES.get(editorPayload.annotationType),
            ref,
            editorPayload,
            source: "embedded",
          });
        }
      }
      assertCurrent();
      return targets;
    }

    async deleteEditors(editors, {
      onDelete = null,
      onRestore = null,
      isCurrent = null,
    } = {}) {
      const manager = this.getManager();
      const targets = [...new Set(editors || [])].filter((editor) =>
        editor && editor.deleted !== true && !editor.isEmpty?.(),
      );
      if (!manager || !targets.length) return 0;
      if (
        typeof manager.setSelected === "function" &&
        typeof manager.toggleSelected === "function" &&
        typeof manager.delete === "function" &&
        typeof manager.addCommands === "function"
      ) {
        const toolbarsReady = await Promise.all(targets.map((editor) =>
          this.waitForDeleteToolbar(editor),
        ));
        if (toolbarsReady.some((ready) => !ready) ||
            (typeof isCurrent === "function" && !isCurrent())) return 0;
        manager.setSelected(targets[0]);
        for (const editor of targets.slice(1)) manager.toggleSelected(editor);
        // Let callers attach owner-managed effects to the same PDF.js history
        // command. This keeps one user action as one undo/redo step while the
        // controller remains unaware of persistence details.
        const originalAddCommands = manager.addCommands;
        let commandCaptured = false;
        let firstExecution = true;
        manager.addCommands = function (params) {
          if (!commandCaptured && params?.mustExec === true) {
            commandCaptured = true;
            const originalCommand = params.cmd;
            const originalUndo = params.undo;
            params = {
              ...params,
              cmd() {
                if (typeof isCurrent === "function" && !isCurrent()) return;
                originalCommand?.();
                if (typeof isCurrent === "function" && !isCurrent()) return;
                onDelete?.({ redo: !firstExecution });
                firstExecution = false;
              },
              undo() {
                if (typeof isCurrent === "function" && !isCurrent()) return;
                originalUndo?.();
                if (typeof isCurrent === "function" && !isCurrent()) return;
                onRestore?.();
              },
            };
          }
          return originalAddCommands.call(manager, params);
        };
        try {
          manager.delete();
        } finally {
          manager.addCommands = originalAddCommands;
        }
        if (!commandCaptured) return 0;
        return targets.length;
      }
      if (onDelete || onRestore) return 0;
      if (typeof manager.deleteEditor !== "function") return 0;
      for (const editor of targets) manager.deleteEditor(editor);
      return targets.length;
    }

    async waitForDeleteToolbar(editor) {
      if (typeof editor?.addEditToolbar !== "function") return true;
      try {
        // Start construction before manager.delete() selects and immediately
        // removes the editor. PDF.js builds some toolbar buttons asynchronously.
        await editor.addEditToolbar();
      } catch {
        return false;
      }
      const isReady = () => Boolean(
        editor?._editToolbar?.div?.querySelector?.(".deleteButton"),
      );
      if (isReady()) return true;
      if (typeof MutationObserver !== "function" || !editor?.div) return false;
      return new Promise((resolve) => {
        let finished = false;
        let observer = null;
        const timeout = setTimeout(() => finish(false), 3000);
        const finish = (ready) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          observer?.disconnect();
          resolve(ready);
        };
        observer = new MutationObserver(() => {
          if (isReady()) finish(true);
        });
        observer.observe(editor.div, { childList: true, subtree: true });
        if (isReady()) finish(true);
      });
    }

    preparePenHighlight(pointer, { textLayer, page }) {
      if (!textLayer || !page) return false;
      const pageIndex = Number(page.dataset?.pageNumber) - 1;
      const pageView = Number.isInteger(pageIndex) && pageIndex >= 0
        ? this.getPdfViewer()?.getPageView?.(pageIndex)
        : null;
      pointer.pageEditorLayerBuilder = pageView?.annotationEditorLayer || null;
      pointer.pageEditorLayer =
        pointer.pageEditorLayerBuilder?.annotationEditorLayer || null;
      pointer.highlightManager = this.getManager();
      return !!(pointer.pageEditorLayer && pointer.highlightManager);
    }

    finishPenHighlight(pointer) {
      if (!this.isPendingHighlight(pointer)) return false;
      this.clearPendingHighlight();
      const manager = this.getManager();
      const pdfViewer = this.getPdfViewer();
      const pageIndex = Number(pointer.page?.dataset?.pageNumber) - 1;
      const pageView = Number.isInteger(pageIndex) && pageIndex >= 0
        ? pdfViewer?.getPageView?.(pageIndex)
        : null;
      const pageEditorLayerBuilder = pageView?.annotationEditorLayer;
      if (
        !pointer.ending ||
        pointer.kind !== "text-selection" ||
        pointer.pointerType !== "pen" ||
        pointer.button !== 0 ||
        pointer.mode !== 9 ||
        !pointer.moved ||
        pointer.penTextSelectionOwnershipLost ||
        !this.isPointerSessionCurrent(pointer) ||
        this.getEditorMode() !== 9 ||
        this.getPdfViewerMode() !== 9 ||
        manager !== pointer.highlightManager ||
        manager?.getMode?.() !== 9 ||
        !manager.currentLayer ||
        manager.getLayer?.(pageIndex) !== pointer.pageEditorLayer ||
        pageEditorLayerBuilder !== pointer.pageEditorLayerBuilder ||
        pageEditorLayerBuilder?.annotationEditorLayer !== pointer.pageEditorLayer ||
        pageEditorLayerBuilder?.div !== pointer.pageEditorLayer?.div ||
        !pointer.pageEditorLayer?.div?.isConnected ||
        !pointer.page?.contains(pointer.pageEditorLayer.div) ||
        !pointer.pageEditorLayer.hasTextLayer?.(pointer.textLayer) ||
        typeof manager?.highlightSelection !== "function" ||
        !this.isTextSelectionValid(pointer) ||
        this.hasOtherActivePenPointer(pointer) ||
        this.isClosingOrDisposed()
      ) {
        return false;
      }
      manager.highlightSelection("main_toolbar");
      return true;
    }

    cancelPointerSession(pointer) {
      if (!this.isPointerSessionCurrent(pointer)) return false;
      if (pointer.button === 1) {
        this.clearToolWheel(pointer.pointerId);
        return true;
      }
      if (pointer.button === 2) {
        this.getEraser()?.cancelTemporaryStroke?.();
        return true;
      }
      if (pointer.button === 0 && [5, 15].includes(pointer.mode)) {
        this.getManager()?.currentLayer?.endDrawingSession?.(true);
      }
      if (
        pointer.button === 0 &&
        ["mouse", "pen"].includes(pointer.pointerType) &&
        ["move", "resize"].includes(pointer.nativeOperation) &&
        !pointer.internalCancelScheduled
      ) {
        pointer.internalCancelScheduled = true;
        this.onTransformCancel(pointer);
      }
      return true;
    }
  }

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { AnnotationController },
  );
})();
