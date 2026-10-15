(() => {
  "use strict";

  const describeTarget = (target) => {
    const element = target instanceof Element ? target : target?.parentElement;
    if (!element) return { role: "unknown", pageIndex: null };
    const pageNumber = Number(element.closest(".page")?.dataset.pageNumber);
    const pageIndex = Number.isInteger(pageNumber) && pageNumber > 0
      ? pageNumber - 1
      : null;
    const role = element.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")
      ? "text-control"
      : element.closest(".annotationEditorLayer")
        ? "annotation-layer"
        : element.closest(".textLayer")
          ? "text-layer"
          : element.closest("#viewerContainer")
            ? "viewer"
            : "outside-viewer";
    return { role, pageIndex };
  };

  const createInteractionIntent = (event) => {
    const target = describeTarget(event?.target);
    return Object.freeze({
      type: String(event?.type || "unknown"),
      pointerId: Number.isFinite(event?.pointerId) ? event.pointerId : null,
      pointerType: typeof event?.pointerType === "string" ? event.pointerType : "unknown",
      button: Number.isInteger(event?.button) ? event.button : null,
      buttons: Number.isInteger(event?.buttons) ? event.buttons : null,
      clientPoint: Object.freeze({
        x: Number.isFinite(event?.clientX) ? event.clientX : null,
        y: Number.isFinite(event?.clientY) ? event.clientY : null,
      }),
      pageIndex: target.pageIndex,
      targetRole: target.role,
      timestamp: Number.isFinite(event?.timeStamp) ? event.timeStamp : null,
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
