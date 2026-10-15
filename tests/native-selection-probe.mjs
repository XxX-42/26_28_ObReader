// Install this helper by evaluating installNativeSelectionProbe.toString() in
// the Native viewer document. Keep it self-contained: the serialized function
// must not depend on module imports or lexical bindings.
export function installNativeSelectionProbe({ d, w, a, trace, captureFixtureText = false }) {
  if (!d || typeof d.addEventListener !== "function") {
    throw new TypeError("A viewer document event target is required");
  }
  if (!trace || typeof trace !== "object") {
    throw new TypeError("A trace object is required");
  }

  const maxEntries = 300;
  const maxRects = 64;
  const previous = trace.nativeSelectionProbe;
  if (previous?.active) {
    throw new Error("Native selection probe is already installed");
  }

  const probe = {
    active: true,
    pointerEvents: [],
    selectionChanges: [],
    eventPhases: [],
    consumers: [],
  };
  trace.nativeSelectionProbe = probe;

  const appendBounded = (entries, entry) => {
    try {
      if (entries.length >= maxEntries) entries.shift();
      entries.push(entry);
    } catch {
      // Diagnostics must never interfere with viewer input.
    }
  };

  const safeMode = () => {
    try {
      const mode = a?.pdfViewer?.annotationEditorMode;
      if (typeof mode === "string" || typeof mode === "number") return mode;
      const fallback = a?.pdfViewer?._layerProperties?.annotationEditorUIManager?.getMode?.();
      return typeof fallback === "string" || typeof fallback === "number"
        ? fallback
        : null;
    } catch {
      return null;
    }
  };

  const elementSummary = (element) => {
    try {
      if (element?.nodeType === 3) element = element.parentElement;
      if (!element || element === d || element === w) return null;
      const rawClass = element.className;
      const className = typeof rawClass === "string"
        ? rawClass.slice(0, 120)
        : typeof rawClass?.baseVal === "string"
          ? rawClass.baseVal.slice(0, 120)
          : null;
      const tag = typeof element.tagName === "string"
        ? element.tagName.toLowerCase().slice(0, 32)
        : null;
      const id = typeof element.id === "string" && element.id
        ? element.id.slice(0, 80)
        : null;
      return { tag, id, className };
    } catch {
      return null;
    }
  };

  const textLayerInfo = (element) => {
    try {
      if (element?.nodeType === 3) element = element.parentElement;
      const layer = element?.closest?.(".textLayer") || null;
      if (!layer) return { found: false, pageNumber: null };
      const page = layer.closest?.('.page[data-page-number]') || null;
      const pageNumber = page?.getAttribute?.("data-page-number") || null;
      return { found: true, pageNumber };
    } catch {
      return { found: false, pageNumber: null };
    }
  };

  const selectionSnapshot = () => {
    try {
      const selection = d.getSelection?.() || w?.getSelection?.() || null;
      if (!selection) {
        return {
          collapsed: null,
          rangeCount: 0,
          anchorTextLayer: { found: false, pageNumber: null },
          rangeRects: [],
          rectsTruncated: false,
          textLength: 0,
        };
      }

      const rangeRects = [];
      let rectsTruncated = false;
      const count = Number.isInteger(selection.rangeCount)
        ? selection.rangeCount
        : 0;
      for (let rangeIndex = 0; rangeIndex < count; rangeIndex += 1) {
        let rects;
        try {
          rects = selection.getRangeAt(rangeIndex)?.getClientRects?.() || [];
        } catch {
          continue;
        }
        for (const rect of rects) {
          if (rangeRects.length >= maxRects) {
            rectsTruncated = true;
            break;
          }
          rangeRects.push({
            x: Number.isFinite(rect.x) ? rect.x : null,
            y: Number.isFinite(rect.y) ? rect.y : null,
            width: Number.isFinite(rect.width) ? rect.width : null,
            height: Number.isFinite(rect.height) ? rect.height : null,
          });
        }
        if (rectsTruncated) break;
      }

      let textLength = 0;
      try {
        textLength = String(selection.toString?.() ?? "").length;
      } catch {
        // Keep the diagnostic shape stable if a browser selection is stale.
      }
      return {
        collapsed: Boolean(selection.isCollapsed),
        rangeCount: count,
        anchorTextLayer: textLayerInfo(selection.anchorNode),
        rangeRects,
        rectsTruncated,
        textLength,
        ...(captureFixtureText ? { selectedText: String(selection.toString?.() ?? "") } : {}),
        ranges: Array.from({ length: Math.min(count, 8) }, (_, index) => {
          const range = selection.getRangeAt(index);
          return { start: elementSummary(range.startContainer), end: elementSummary(range.endContainer),
            startOffset: range.startOffset ?? null, endOffset: range.endOffset ?? null,
            collapsed: range.collapsed ?? null };
        }),
      };
    } catch {
      return {
        collapsed: null,
        rangeCount: 0,
        anchorTextLayer: { found: false, pageNumber: null },
        rangeRects: [],
        rectsTruncated: false,
        textLength: 0,
        readFailed: true,
      };
    }
  };

  let pointerListener = (event) => {
    try {
      const entry = {
        type: String(event?.type || "unknown"),
        at: w?.performance?.now?.() ?? null,
        trusted: Boolean(event?.isTrusted),
        button: Number.isFinite(event?.button) ? event.button : null,
        buttons: Number.isFinite(event?.buttons) ? event.buttons : null,
        pointerId: Number.isFinite(event?.pointerId) ? event.pointerId : null,
        pointerType: typeof event?.pointerType === "string" ? event.pointerType : null,
        clientX: Number.isFinite(event?.clientX) ? event.clientX : null,
        clientY: Number.isFinite(event?.clientY) ? event.clientY : null,
        target: elementSummary(event?.target),
        targetTextLayer: textLayerInfo(event?.target),
        mode: safeMode(),
      };
      if (event?.type === "pointerup" || captureFixtureText) {
        entry.selection = selectionSnapshot();
      }
      appendBounded(probe.pointerEvents, entry);
    } catch {
      // Diagnostics must never interfere with viewer input.
    }
  };

  let selectionChangeListener = () => {
    try {
      appendBounded(probe.selectionChanges, {
        type: "selectionchange",
        at: w?.performance?.now?.() ?? null,
        mode: safeMode(),
        selection: selectionSnapshot(),
      });
    } catch {
      // Diagnostics must never interfere with viewer selection.
    }
  };

  for (const type of ["pointerdown", "pointermove", "pointerup"]) {
    d.addEventListener(type, pointerListener, true);
  }
  d.addEventListener("selectionchange", selectionChangeListener, true);

  const phaseListeners = [];
  if (typeof w?.addEventListener === "function") {
    for (const target of [w, d]) for (const capture of [true, false]) {
      for (const type of ["pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup", "selectstart", "selectionchange", "blur", "keyup"]) {
        const listener = (event) => {
          const layers = [...(d.querySelectorAll?.(".textLayer") || [])].slice(0, 20).map(layer => {
            const end = layer.querySelector(".endOfContent");
            const r = end?.getBoundingClientRect();
            return { className: layer.className, page: layer.closest(".page")?.dataset.pageNumber,
              end: r ? { x:r.x,y:r.y,width:r.width,height:r.height } : null };
          });
          appendBounded(probe.eventPhases, { type, at:w.performance.now(), target:target===w?"window":"document",
            eventTarget:elementSummary(event.target),relatedTarget:elementSummary(event.relatedTarget),
            capture, defaultPrevented:event.defaultPrevented, selection:selectionSnapshot(), layers,
            buttons:event.buttons,button:event.button,detail:event.detail,movementX:event.movementX,movementY:event.movementY,
            modifiers:{shift:event.shiftKey,ctrl:event.ctrlKey,alt:event.altKey,meta:event.metaKey},
            hit:elementSummary(d.elementFromPoint?.(event.clientX || 0, event.clientY || 0)) });
        };
        target.addEventListener(type, listener, capture);
        phaseListeners.push({ target, type, listener, capture });
      }
    }
  }
  const manager = a?.pdfViewer?._layerProperties?.annotationEditorUIManager;
  const priorConsumer = manager && Object.getOwnPropertyDescriptor(manager, "highlightSelection");
  const originalConsumer = manager?.highlightSelection;
  let consumerWrapper;
  if (typeof originalConsumer === "function") {
    consumerWrapper = function (...args) {
      const row = { at:w.performance.now(), before:selectionSnapshot(), mode:safeMode() };
      appendBounded(probe.consumers, row);
      try { return originalConsumer.apply(this, args); }
      finally { row.after=selectionSnapshot(); row.editorCount=d.querySelectorAll(".annotationEditorLayer > div[id]").length; }
    };
    Object.defineProperty(manager, "highlightSelection", { configurable:true, writable:true, value:consumerWrapper });
  }

  let cleaned = false;
  return function cleanupNativeSelectionProbe() {
    if (cleaned) return;
    cleaned = true;
    probe.active = false;
    for (const type of ["pointerdown", "pointermove", "pointerup"]) {
      d.removeEventListener(type, pointerListener, true);
    }
    d.removeEventListener("selectionchange", selectionChangeListener, true);
    for (const entry of phaseListeners) entry.target.removeEventListener(entry.type, entry.listener, entry.capture);
    if (manager?.highlightSelection === consumerWrapper && consumerWrapper) {
      if (priorConsumer) Object.defineProperty(manager, "highlightSelection", priorConsumer);
      else delete manager.highlightSelection;
    }
    pointerListener = null;
    selectionChangeListener = null;
    d = null;
    w = null;
    a = null;
    trace = null;
  };
}
