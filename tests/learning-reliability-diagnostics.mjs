export const LEARNING_RELIABILITY_SEQUENCE_PLAN = Object.freeze([
  Object.freeze({
    id: "gesture21-fast-flick",
    sourceScenario: "ipad-pointer-policy.fastFlick",
    contact: { kind: "finger", pointerId: 21 },
    parameters: Object.freeze({ distancePx: 260, plannedOffsetsMs: [0, 22, 44, 65] }),
    endCondition: "visible pages rendered, Long Tasks quiet for 50 ms, two 120 ms inertia samples and settled state recorded",
  }),
  Object.freeze({
    id: "gesture25-to-26-toolbar-contact",
    sourceScenario: "ipad-pointer-policy.newContact",
    contact: { kind: "finger", pointerId: 25, followupPointerId: 26, followupTarget: "#editorInkButton" },
    parameters: Object.freeze({ distancePx: 180, plannedOffsetsMs: [0, 22, 44, 65], releaseToContactMs: 80 }),
    endCondition: "toolbar finger contact ends, then scroll position is checked after 300 ms",
  }),
  Object.freeze({
    id: "gesture27-to-pencil-contact",
    sourceScenario: "ipad-pointer-policy.penStop",
    contact: { kind: "finger", pointerId: 27, followupKind: "simulated-pen", followupTarget: "#editorInkButton" },
    parameters: Object.freeze({ distancePx: 180, plannedOffsetsMs: [0, 22, 44, 65], releaseToContactMs: 70 }),
    endCondition: "CDP simulated pen tap ends, then scroll position is checked after 300 ms",
  }),
]);

// This function is serialized by Puppeteer into each document. It is passive:
// it observes existing input and PDF.js state and never dispatches input or
// changes the viewer, tool mode, annotation storage, or vocabulary state.
export function installLearningReliabilityProbe() {
  if (window.__learningReliabilityProbe?.schemaVersion === 1) return;

  const probe = {
    schemaVersion: 1,
    active: null,
    completed: [],
    viewerSignalsInstalled: false,
    animationFramePreviousAt: null,

    stateSnapshot() {
      const app = window.PDFViewerApplication;
      const viewer = app?.pdfViewer;
      const container = document.getElementById("viewerContainer");
      const bounds = container?.getBoundingClientRect();
      const visiblePages = container && bounds
        ? [...container.querySelectorAll(".page")].filter((page) => {
          const rect = page.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        }).map((page) => {
          const pageNumber = Number(page.dataset.pageNumber);
          const pageView = Number.isFinite(pageNumber)
            ? viewer?.getPageView(pageNumber - 1)
            : null;
          return {
            pageNumber: Number.isFinite(pageNumber) ? pageNumber : null,
            loaded: page.dataset.loaded === "true",
            renderingState: pageView?.renderingState ?? null,
            canvasConnected: pageView?.canvas?.isConnected ?? false,
            textLayerReady: !!page.querySelector(".textLayer .endOfContent"),
            textSpanCount: page.querySelectorAll(".textLayer span").length,
          };
        })
        : [];
      const editorNodes = [...document.querySelectorAll(
        ".annotationEditorLayer > div[id]",
      )];
      const annotationStorage = app?.pdfDocument?.annotationStorage;
      const serializedMap = annotationStorage?.serializable?.map;
      const vocabularyPill = document.querySelector(".pdfReaderVocabularyPill");
      return {
        observedAt: performance.now(),
        observedEpochMs: performance.timeOrigin + performance.now(),
        documentVisibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        pageNumber: viewer?.currentPageNumber ?? null,
        scroll: container ? {
          top: container.scrollTop,
          height: container.scrollHeight,
          viewportHeight: container.clientHeight,
        } : null,
        visiblePages,
        annotation: {
          mode: viewer?.annotationEditorMode ?? null,
          editorCount: editorNodes.length,
          selectedEditorCount: editorNodes.filter((node) =>
            node.classList.contains("selectedEditor") ||
            node.getAttribute("aria-selected") === "true",
          ).length,
          storageSize: annotationStorage?.size ?? null,
          serializedEntryCount: serializedMap?.size ?? null,
          modified: !!app?._annotationStorageModified,
          hasChanges: typeof app?._hasChanges === "function"
            ? !!app._hasChanges()
            : null,
        },
        lingq: {
          enabled: document.documentElement.dataset.vocabularyEnabled ?? null,
          pillPresent: !!vocabularyPill,
          pillVisible: !!vocabularyPill && vocabularyPill.getClientRects().length > 0,
          pillActionCount: vocabularyPill?.querySelectorAll("button").length ?? 0,
        },
      };
    },

    begin(id, plan) {
      if (this.active) throw new Error(`Diagnostic sequence already active: ${this.active.id}`);
      this.active = {
        id,
        plan,
        startedAt: performance.now(),
        timeOrigin: performance.timeOrigin,
        pointerOffset: window.__ipadPointerEvents?.length ?? 0,
        longTaskOffset: window.__ipadLongTasks?.length ?? 0,
        startState: this.stateSnapshot(),
        animationFrames: [],
        renderEvents: [],
        annotationEvents: [],
        lingqEvents: [],
      };
      return {
        id,
        startedAt: this.active.startedAt,
        startState: this.active.startState,
      };
    },

    end(id) {
      if (!this.active || this.active.id !== id) {
        throw new Error(`No active diagnostic sequence named ${id}`);
      }
      const active = this.active;
      const endState = this.stateSnapshot();
      const rows = {
        id: active.id,
        plan: active.plan,
        timeOrigin: active.timeOrigin,
        startedAt: active.startedAt,
        endedAt: performance.now(),
        durationMs: performance.now() - active.startedAt,
        startState: active.startState,
        endState,
        inputEvents: (window.__ipadPointerEvents || []).slice(active.pointerOffset),
        longTasks: (window.__ipadLongTasks || []).slice(active.longTaskOffset),
        animationFrames: active.animationFrames,
        renderEvents: active.renderEvents,
        annotationEvents: active.annotationEvents,
        lingqEvents: active.lingqEvents,
      };
      rows.inputEvents = rows.inputEvents.map((event) => ({
        ...event,
        eventEpochMs: Number.isFinite(event.timeStamp)
          ? active.timeOrigin + (event.timeStamp > 1e12
            ? event.timeStamp - active.timeOrigin
            : event.timeStamp)
          : null,
        observedEpochMs: Number.isFinite(event.observedAt)
          ? active.timeOrigin + event.observedAt
          : null,
        eventDispatchDelayMs: Number.isFinite(event.timeStamp) &&
            Number.isFinite(event.observedAt)
          ? event.observedAt - (event.timeStamp > 1e12
            ? event.timeStamp - active.timeOrigin
            : event.timeStamp)
          : null,
      }));
      rows.longTasks = rows.longTasks.map((task) => ({
        ...task,
        sequenceId: active.id,
        epochStartMs: active.timeOrigin + task.startTime,
      }));
      this.completed.push(rows);
      this.active = null;
      return rows;
    },

    snapshotActive() {
      if (!this.active) return null;
      const active = this.active;
      return {
        id: active.id,
        plan: active.plan,
        state: "incomplete",
        timeOrigin: active.timeOrigin,
        startedAt: active.startedAt,
        capturedAt: performance.now(),
        startState: active.startState,
        currentState: this.stateSnapshot(),
        inputEvents: (window.__ipadPointerEvents || []).slice(active.pointerOffset),
        longTasks: (window.__ipadLongTasks || []).slice(active.longTaskOffset),
        animationFrames: active.animationFrames,
        renderEvents: active.renderEvents,
        annotationEvents: active.annotationEvents,
        lingqEvents: active.lingqEvents,
      };
    },

    record(collection, row) {
      if (!this.active || !Array.isArray(this.active[collection])) return;
      this.active[collection].push({
        sequenceId: this.active.id,
        observedAt: performance.now(),
        observedEpochMs: performance.timeOrigin + performance.now(),
        ...row,
      });
    },

    installViewerSignals() {
      if (this.viewerSignalsInstalled) return true;
      const app = window.PDFViewerApplication;
      const bus = app?.eventBus;
      if (!bus) return false;
      this.viewerSignalsInstalled = true;
      const on = typeof bus._on === "function" ? bus._on.bind(bus)
        : typeof bus.on === "function" ? bus.on.bind(bus)
          : null;
      if (on) {
        for (const name of [
          "pagerendered",
          "textlayerrendered",
          "annotationeditorstateschanged",
          "annotationeditorparamschanged",
          "annotationeditorlayerrendered",
          "annotationeditormodechanged",
        ]) {
          on(name, (event) => {
            const row = {
              eventName: name,
              pageNumber: event?.pageNumber ?? null,
              mode: app.pdfViewer?.annotationEditorMode ?? null,
              renderingState: Number.isFinite(event?.pageNumber)
                ? app.pdfViewer?.getPageView(event.pageNumber - 1)?.renderingState ?? null
                : null,
            };
            this.record(name.startsWith("annotationeditor")
              ? "annotationEvents"
              : "renderEvents", row);
          });
        }
      }
      const isRelevant = (node) => {
        const element = node?.nodeType === 1 ? node : node?.parentElement;
        if (!element) return false;
        return !!element.closest?.(".pdfReaderVocabularyPill, .annotationEditorLayer") ||
          !!element.matches?.(".pdfReaderVocabularyPill, .annotationEditorLayer") ||
          !!element.querySelector?.(".pdfReaderVocabularyPill, .annotationEditorLayer");
      };
      if (typeof MutationObserver === "function" && document.documentElement) {
        const observer = new MutationObserver((records) => {
          for (const mutation of records) {
            const relevant = isRelevant(mutation.target) ||
              [...mutation.addedNodes, ...mutation.removedNodes].some(isRelevant);
            if (!relevant) continue;
            const state = this.stateSnapshot();
            this.record(state.lingq.pillPresent ? "lingqEvents" : "annotationEvents", {
              source: "relevant-dom-mutation",
              lingq: state.lingq,
              annotation: state.annotation,
            });
          }
        });
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["class", "aria-selected", "data-vocabulary-enabled"],
        });
      }
      this.record("annotationEvents", {
        source: "viewer-instrumentation-ready",
        mode: app.pdfViewer?.annotationEditorMode ?? null,
      });
      return true;
    },
  };

  window.__learningReliabilityProbe = probe;
  const sampleAnimationFrame = (timestamp) => {
    if (probe.active) {
      probe.active.animationFrames.push({
        timestamp,
        deltaMs: probe.animationFramePreviousAt === null
          ? null
          : timestamp - probe.animationFramePreviousAt,
      });
    }
    probe.animationFramePreviousAt = timestamp;
    window.requestAnimationFrame(sampleAnimationFrame);
  };
  window.requestAnimationFrame(sampleAnimationFrame);
}
