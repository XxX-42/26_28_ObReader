(() => {
  "use strict";

  const SINGLE_CLICK_DELAY_MS = 600;

  function sameTarget(left, right) {
    return !!left && !!right && left.kind === right.kind && left.id === right.id;
  }

  class BacklinkInteractionController {
    constructor({
      documentRef = globalThis.document,
      getCurrentPageState = () => null,
      postToHost = () => false,
      routedPointerEvents = false,
      canActivate = () => true,
      setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
      clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
      clickDelayMs = SINGLE_CLICK_DELAY_MS,
    } = {}) {
      this.document = documentRef;
      this.getCurrentPageState = getCurrentPageState;
      this.postToHost = postToHost;
      this.canActivate = canActivate;
      this.routedPointerEvents = routedPointerEvents;
      this.setTimeout = setTimeoutFn;
      this.clearTimeout = clearTimeoutFn;
      this.clickDelayMs = clickDelayMs;
      this.page = null;
      this.pendingClick = null;
      this.recentActivation = null;
      this.lastPointerClick = null;
      this.doubleClickDisposition = null;
      this.latestPageRequest = null;
      this.requestSequence = 0;
      this.onClick = (event) => this.handleClick(event);
      this.onDoubleClick = (event) => this.handleDoubleClick(event);
      this.onKeyDown = (event) => this.handleKeyDown(event);
      this.onPointerDown = (event) => this.handlePointerDown(event);
      this.onVisibilityChange = () => {
        if (this.document?.visibilityState === "hidden") this.clearPage();
      };
      if (!routedPointerEvents) {
        this.document?.addEventListener?.("click", this.onClick, true);
        this.document?.addEventListener?.("dblclick", this.onDoubleClick, true);
        this.document?.addEventListener?.("pointerdown", this.onPointerDown, true);
      }
      this.document?.addEventListener?.("keydown", this.onKeyDown, true);
      this.document?.addEventListener?.("visibilitychange", this.onVisibilityChange);
    }

    setPageResults(message, rangeTargets = []) {
      if (!this.isCurrentPageRequest(message)) return false;
      this.cancelPendingClick();
      if (!message || typeof message.documentId !== "string" ||
          !Number.isSafeInteger(message.openRequest) ||
          typeof message.rendererGeneration !== "string" || !message.rendererGeneration ||
          !Number.isSafeInteger(message.pageNumber) || message.pageNumber < 1 ||
          !Number.isSafeInteger(message.pageIndex) || message.pageIndex < 0 ||
          typeof message.pageIdentity !== "string") {
        this.page = null;
        return false;
      }
      this.page = {
        documentId: message.documentId,
        openRequest: message.openRequest,
        rendererGeneration: message.rendererGeneration,
        pageNumber: message.pageNumber,
        pageIndex: message.pageIndex,
        pageIdentity: message.pageIdentity,
        requestId: typeof message.requestId === "string" ? message.requestId : null,
        rangeTargets: Array.isArray(rangeTargets)
          ? rangeTargets.filter((target) => target?.kind === "selection" &&
              typeof target.id === "string" && target.range)
          : [],
      };
      return true;
    }

    beginPageRequest(message) {
      if (!message || typeof message.requestId !== "string" || !message.requestId ||
          message.requestId.length > 128 || typeof message.documentId !== "string" ||
          !Number.isSafeInteger(message.openRequest) ||
          typeof message.rendererGeneration !== "string" || !message.rendererGeneration ||
          !Number.isSafeInteger(message.pageNumber) || message.pageNumber < 1 ||
          !Number.isSafeInteger(message.pageIndex) || message.pageIndex < 0 ||
          typeof message.pageIdentity !== "string" || !message.pageIdentity) return false;
      this.cancelPendingClick();
      this.page = null;
      this.latestPageRequest = {
        requestId: message.requestId,
        documentId: message.documentId,
        openRequest: message.openRequest,
        rendererGeneration: message.rendererGeneration,
        pageNumber: message.pageNumber,
        pageIndex: message.pageIndex,
        pageIdentity: message.pageIdentity,
      };
      return true;
    }

    isCurrentPageRequest(message) {
      const request = this.latestPageRequest;
      if (!request) return !message?.requestId;
      return message?.requestId === request.requestId &&
        message?.documentId === request.documentId &&
        message?.openRequest === request.openRequest &&
        message?.rendererGeneration === request.rendererGeneration &&
        message?.pageNumber === request.pageNumber &&
        message?.pageIndex === request.pageIndex &&
        message?.pageIdentity === request.pageIdentity;
    }

    clearPage() {
      this.cancelPendingClick();
      this.page = null;
      this.latestPageRequest = null;
      this.recentActivation = null;
      this.lastPointerClick = null;
      this.doubleClickDisposition = null;
    }

    currentPageMatches() {
      const page = this.page;
      if (!page) return false;
      let current = null;
      try { current = this.getCurrentPageState(); } catch { return false; }
      return !!current && current.documentId === page.documentId &&
        current.openRequest === page.openRequest &&
        current.rendererGeneration === page.rendererGeneration &&
        current.pageNumber === page.pageNumber &&
        current.pageIdentity === page.pageIdentity;
    }

    // Pointer policy stays in the existing Bridge/InputRouter ownership hook.
    // Intents carry coordinates, never a retained native event or DOM target.
    handleRoutedPointerEvent(intent, controls) {
      if (!this.canActivate() || !["click", "dblclick", "pointerdown"].includes(intent?.type)) {
        this.cancelPendingClick();
        return false;
      }
      const point = intent.clientPoint;
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return false;
      const event = {
        target: this.document?.elementFromPoint?.(point.x, point.y),
        clientX: point.x, clientY: point.y, button: intent.button, detail: intent.detail,
        preventDefault: () => controls?.preventDefault?.(),
        stopPropagation: () => controls?.stopImmediatePropagation?.(),
      };
      if (intent.type === "pointerdown") return this.handlePointerDown(event);
      if (!this.targetFromEvent(event)) {
        this.cancelPendingClick();
        return false;
      }
      if (intent.type === "dblclick") this.handleDoubleClick(event);
      else this.handleClick(event);
      return true;
    }

    targetFromEvent(event) {
      if (!this.canActivate() || !this.currentPageMatches()) return null;
      const page = this.page;
      const element = event?.target?.closest?.(
        ".pdfReaderAnnotationBacklinkBadge, .pdfReaderBacklinkPageBadge",
      ) || null;
      const kind = element?.dataset?.backlinkTargetKind;
      const id = element?.dataset?.backlinkTargetId;
      if ((kind === "annotation" || kind === "page") && typeof id === "string" && id) {
        return { kind, id };
      }

      const x = event?.clientX;
      const y = event?.clientY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      let match = null;
      for (const target of page.rangeTargets) {
        const range = target.range;
        if (!range || range.startContainer?.isConnected === false ||
            range.endContainer?.isConnected === false) continue;
        let rects;
        try { rects = range.getClientRects?.(); } catch { continue; }
        for (const rect of rects || []) {
          if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
          if (match && match.id !== target.id) return null;
          match = target;
          break;
        }
      }
      return match ? { kind: "selection", id: match.id } : null;
    }

    handleClick(event) {
      if (event?.button !== 0) {
        this.cancelPendingClick();
        return;
      }
      const target = this.targetFromEvent(event);
      if (!target) {
        this.cancelPendingClick();
        if (event?.detail > 0) {
          this.lastPointerClick = null;
          this.doubleClickDisposition = null;
        }
        return;
      }
      if (event.detail > 1) {
        this.cancelPendingClick();
        if (event.target?.closest?.(".pdfReaderAnnotationBacklinkBadge, .pdfReaderBacklinkPageBadge")) {
          event.preventDefault?.();
          event.stopPropagation?.();
        }
        const prior = this.lastPointerClick;
        const sameSequence = prior?.page === this.page && sameTarget(prior.target, target) &&
          prior.detail === event.detail - 1;
        this.doubleClickDisposition = {
          target,
          page: this.page,
          shouldOpen: !sameSequence || prior.opened !== true,
        };
        this.lastPointerClick = {
          target,
          page: this.page,
          detail: event.detail,
          opened: sameSequence && prior.opened === true,
        };
        return;
      }
      if (event.target?.closest?.(".pdfReaderAnnotationBacklinkBadge, .pdfReaderBacklinkPageBadge")) {
        event.preventDefault?.();
        event.stopPropagation?.();
      }
      if (event.detail === 0) {
        this.cancelPendingClick();
        if (!this.wasRecentlyKeyboardActivated(target, this.page)) {
          this.sendTarget(target, this.page, "keyboard");
        }
        return;
      }
      this.cancelPendingClick();
      this.doubleClickDisposition = null;
      const clickState = { target, page: this.page, detail: 1, opened: false };
      this.lastPointerClick = clickState;
      const pending = { ...clickState, timer: null };
      pending.timer = this.setTimeout(() => {
        if (this.pendingClick !== pending) return;
        this.pendingClick = null;
        if (this.page !== pending.page || !this.currentPageMatches()) return;
        clickState.opened = this.sendTarget(pending.target, pending.page);
      }, this.clickDelayMs);
      this.pendingClick = pending;
    }

    handleDoubleClick(event) {
      const target = this.targetFromEvent(event);
      this.cancelPendingClick();
      if (!target) return;
      if (event.target?.closest?.(".pdfReaderAnnotationBacklinkBadge, .pdfReaderBacklinkPageBadge")) {
        event.preventDefault?.();
        event.stopPropagation?.();
      }
      const disposition = this.doubleClickDisposition;
      this.doubleClickDisposition = null;
      if (disposition?.page === this.page && sameTarget(disposition.target, target)) {
        if (disposition.shouldOpen) {
          const sent = this.sendTarget(target, this.page);
          if (sent && this.lastPointerClick?.page === this.page &&
              sameTarget(this.lastPointerClick.target, target)) {
            this.lastPointerClick.opened = true;
          }
        }
        return;
      }
      this.sendTarget(target, this.page);
    }

    handleKeyDown(event) {
      if (event?.key !== "Enter" && event?.key !== " ") return;
      const badge = event.target?.closest?.(
        ".pdfReaderAnnotationBacklinkBadge, .pdfReaderBacklinkPageBadge",
      );
      if (!badge) return;
      const target = this.targetFromEvent(event);
      if (!target) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      this.cancelPendingClick();
      this.sendTarget(target, this.page, "keyboard");
    }

    handlePointerDown(event) {
      this.cancelPendingClick();
      const badge = event?.target?.closest?.(
        ".pdfReaderAnnotationBacklinkBadge, .pdfReaderBacklinkPageBadge",
      );
      if (badge) {
        // Do not let the badge's pointerdown start an editor drag. Avoid
        // preventDefault so the browser still emits the later click event.
        event.stopPropagation?.();
      }
      return !!badge;
    }

    handleBadgeFocus(event) {
      const badge = event?.target?.closest?.(
        ".pdfReaderAnnotationBacklinkBadge, .pdfReaderBacklinkPageBadge",
      );
      if (!badge || !this.targetFromEvent(event)) return false;
      // A badge is UI, not the containing PDF.js editor. Preserve native focus
      // and click, but do not let the editor's focus listener switch tools or
      // rebuild its DOM between this badge's pointerdown and click.
      event.stopPropagation?.();
      return true;
    }

    sendTarget(target, page = this.page, activation = "pointer") {
      if (!target || !page || !this.canActivate() || this.page !== page || !this.currentPageMatches()) return false;
      const requestId = `backlink-open-${page.openRequest}-${++this.requestSequence}`;
      try {
        const sent = this.postToHost("reader-backlink-target-open", {
          requestId,
          targetKind: target.kind,
          targetId: target.id,
          pageNumber: page.pageNumber,
          pageIdentity: page.pageIdentity,
          documentId: page.documentId,
          openRequest: page.openRequest,
          rendererGeneration: page.rendererGeneration,
        }) === true;
        if (sent) this.recentActivation = { target, page, activation, at: Date.now() };
        return sent;
      } catch { return false; }
    }

    wasRecentlyKeyboardActivated(target, page) {
      const prior = this.recentActivation;
      return prior?.activation === "keyboard" && prior.page === page &&
        sameTarget(prior.target, target) &&
        Date.now() - prior.at <= 250;
    }

    cancelPendingClick() {
      const pending = this.pendingClick;
      if (!pending) return;
      if (pending.timer !== null) this.clearTimeout?.(pending.timer);
      this.pendingClick = null;
    }

    dispose() {
      this.clearPage();
      this.document?.removeEventListener?.("click", this.onClick, true);
      this.document?.removeEventListener?.("dblclick", this.onDoubleClick, true);
      this.document?.removeEventListener?.("keydown", this.onKeyDown, true);
      this.document?.removeEventListener?.("pointerdown", this.onPointerDown, true);
      this.document?.removeEventListener?.("visibilitychange", this.onVisibilityChange);
    }
  }

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { BacklinkInteractionController },
  );
})();
