(() => {
  "use strict";

  const MODES_BY_PDFJS_EDITOR_TYPE = Object.freeze({
    3: "FREETEXT",
    5: "OBJECT_EDIT", // Square creation is owned by the annotation controller.
    9: "HIGHLIGHT",
    10: "TEXT_SELECT",
    15: "INK",
    17: "ERASER",
  });

  const OWNERS_BY_MODE = Object.freeze({
    READ: Object.freeze(["pdfjs"]),
    TEXT_SELECT: Object.freeze(["text-selection", "annotation"]),
    PAN: Object.freeze(["viewport"]),
    HIGHLIGHT: Object.freeze(["text-selection", "annotation"]),
    INK: Object.freeze(["annotation"]),
    ERASER: Object.freeze(["annotation"]),
    FREETEXT: Object.freeze(["annotation"]),
    OBJECT_EDIT: Object.freeze(["annotation"]),
  });

  class InteractionMode {
    static resolve({
      editorMode = 0,
      eraserActive = false,
      nativeOperation = null,
      pointerType = null,
      isPanGesture = false,
    } = {}) {
      if (nativeOperation === "move" || nativeOperation === "resize") {
        return "OBJECT_EDIT";
      }
      if (eraserActive || editorMode === 17) return "ERASER";
      if (editorMode === 0 && pointerType === "pen" && isPanGesture) {
        return "PAN";
      }
      return MODES_BY_PDFJS_EDITOR_TYPE[editorMode] ||
        (editorMode === 0 ? "READ" : "OBJECT_EDIT");
    }

    static allows(mode, owner) {
      return OWNERS_BY_MODE[mode]?.includes(owner) === true;
    }

    static isTextSelectionMode(mode) {
      return mode === "TEXT_SELECT" || mode === "HIGHLIGHT";
    }

    static isToolActive(mode) {
      return mode !== "READ";
    }
  }

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { InteractionMode },
  );
})();
