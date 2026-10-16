(() => {
  "use strict";

  const describeTarget = (target) => {
    if (target === window) return {
      role: "window", pageIndex: null, nativeContextTarget: false,
      nativeActivationTarget: false, targetRegion: null, nativeOperation: null,
    };
    if (target === document) return {
      role: "document", pageIndex: null, nativeContextTarget: false,
      nativeActivationTarget: false, targetRegion: null, nativeOperation: null,
    };
    const element = target instanceof Element ? target : target?.parentElement;
    if (!element) return {
      role: "unknown", pageIndex: null, nativeContextTarget: false,
      nativeActivationTarget: false, targetRegion: null, nativeOperation: null,
    };
    const pageNumber = Number(element.closest(".page")?.dataset.pageNumber);
    const pageIndex = Number.isInteger(pageNumber) && pageNumber > 0
      ? pageNumber - 1
      : null;
    const nativeContextTarget = !!element.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=dialog], .editorToolbar, .editToolbar, .editorParamsToolbar",
    );
    const nativeActivationTarget = !!element.closest(
      "a[href], button, [role=button], [role=link]",
    );
    const role = element.closest(".annotationEditorLayer")
      ? "annotation-layer"
      : element.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")
        ? "text-control"
        : element.closest("[role=dialog], .editorToolbar, .editToolbar, .editorParamsToolbar")
        ? "native-control"
        : element.closest(".textLayer")
          ? "text-layer"
          : element.closest("#viewerContainer")
            ? "viewer"
            : "outside-viewer";
    const targetRegion = element.closest(".editorParamsToolbar")
      ? "editor-params-toolbar"
      : element.closest("#editorModeButtons")
        ? "editor-mode-buttons"
        : null;
    const nativeOperation = element.closest(".resizer")
      ? "resize"
      : element.closest(".draggable.selectedEditor")
        ? "move"
        : null;
    return {
      role,
      pageIndex,
      targetRegion,
      nativeOperation,
      nativeContextTarget,
      nativeActivationTarget,
    };
  };

  const touchListHasStylus = (list) => {
    const length = Number.isInteger(list?.length) ? list.length : 0;
    for (let index = 0; index < length; index += 1) {
      const touch = list.item?.(index) || list[index];
      if (touch?.touchType === "stylus" || touch?.touchType === "pen") return true;
    }
    return false;
  };

  const createInteractionIntent = (event) => {
    const target = describeTarget(event?.target);
    return Object.freeze({
      type: String(event?.type || "unknown"),
      pointerId: Number.isFinite(event?.pointerId) ? event.pointerId : null,
      pointerType: typeof event?.pointerType === "string" ? event.pointerType : "unknown",
      button: Number.isInteger(event?.button) ? event.button : null,
      buttons: Number.isInteger(event?.buttons) ? event.buttons : null,
      detail: Number.isInteger(event?.detail) ? event.detail : null,
      clientPoint: Object.freeze({
        x: Number.isFinite(event?.clientX) ? event.clientX : null,
        y: Number.isFinite(event?.clientY) ? event.clientY : null,
      }),
      pageIndex: target.pageIndex,
      targetRole: target.role,
      targetRegion: target.targetRegion,
      nativeOperation: target.nativeOperation,
      nativeContextTarget: target.nativeContextTarget === true,
      nativeActivationTarget: target.nativeActivationTarget === true,
      touchHasStylus: touchListHasStylus(event?.changedTouches) ||
        touchListHasStylus(event?.touches),
      timestamp: Number.isFinite(event?.timeStamp) ? event.timeStamp : null,
      trusted: event?.isTrusted === true,
      key: event?.key === "Escape" ? "Escape" : null,
      relatedTargetPresent: event?.relatedTarget != null,
      modifiers: Object.freeze({
        alt: event?.altKey === true,
        control: event?.ctrlKey === true,
        meta: event?.metaKey === true,
        shift: event?.shiftKey === true,
      }),
    });
  };

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { createInteractionIntent },
  );
})();
