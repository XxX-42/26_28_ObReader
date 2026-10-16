(() => {
  "use strict";

  const SAMPLE_WINDOW_MS = 80;
  const MAX_SAMPLES = 128;
  const MAX_SPEED = 4;
  const START_SPEED = 0.09;
  const STOP_SPEED = 0.01;
  const DECAY_MS = 350;
  const MIN_SAMPLE_SPAN_MS = 8;
  const TIMESTAMP_TOLERANCE_MS = 5000;

  class ViewportController {
    constructor({
      canPan = () => true,
      canStartMomentum = () => true,
      getVisibilityState = () => document.visibilityState,
      prefersReducedMotion = () =>
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
      requestFrame = (callback) => requestAnimationFrame(callback),
      cancelFrame = (frame) => cancelAnimationFrame(frame),
    } = {}) {
      this.canPan = canPan;
      this.canStartMomentum = canStartMomentum;
      this.getVisibilityState = getVisibilityState;
      this.prefersReducedMotion = prefersReducedMotion;
      this.requestFrame = requestFrame;
      this.cancelFrame = cancelFrame;
      this.momentum = null;
    }

    dispose() {
      this.cancelMomentum();
    }

    cancelMomentum() {
      const momentum = this.momentum;
      if (!momentum) return;
      this.cancelFrame(momentum.frame);
      this.momentum = null;
    }

    eventTime(pointer, event, now = performance.now()) {
      const eventTime = event?.timeStamp;
      let time = Number.isFinite(eventTime) &&
          eventTime >= 0 &&
          eventTime <= now &&
          now - eventTime <= TIMESTAMP_TOLERANCE_MS
        ? eventTime
        : now;
      const previousTime = pointer?.scrollSamples?.at(-1)?.time;
      if (Number.isFinite(previousTime) && time < previousTime) {
        time = Math.max(previousTime, now);
      }
      return time;
    }

    rememberScroll(pointer, time = performance.now()) {
      if (pointer.pointerType !== "touch") return;
      const sample = {
        time: Number.isFinite(time) ? time : performance.now(),
        scrollTop: pointer.container.scrollTop,
        scrollLeft: pointer.container.scrollLeft,
      };
      const previous = pointer.scrollSamples[pointer.scrollSamples.length - 1];
      const moved = previous && (
        Math.abs(sample.scrollTop - previous.scrollTop) >= 0.01 ||
        Math.abs(sample.scrollLeft - previous.scrollLeft) >= 0.01
      );
      if (previous && sample.time < previous.time) sample.time = previous.time;
      if (previous && sample.time === previous.time) {
        pointer.scrollSamples[pointer.scrollSamples.length - 1] = sample;
      } else {
        pointer.scrollSamples.push(sample);
      }
      if (moved) pointer.lastMotionAt = sample.time;
      const oldestRecentTime = sample.time - SAMPLE_WINDOW_MS;
      while (
        pointer.scrollSamples.length > 1 &&
        pointer.scrollSamples[1].time < oldestRecentTime
      ) {
        pointer.scrollSamples.shift();
      }
      if (pointer.scrollSamples.length > MAX_SAMPLES) {
        pointer.scrollSamples.splice(0, pointer.scrollSamples.length - MAX_SAMPLES);
      }
    }

    releaseVelocity(pointer, now = performance.now()) {
      if (
        pointer.pointerType !== "touch" ||
        !pointer.moved ||
        pointer.blockedByPen ||
        pointer.blockedByOtherPointer ||
        pointer.blockedByVisibility ||
        !Number.isFinite(pointer.lastMotionAt) ||
        now < pointer.lastMotionAt ||
        now - pointer.lastMotionAt > SAMPLE_WINDOW_MS
      ) {
        return null;
      }
      const windowStart = now - SAMPLE_WINDOW_MS;
      const samples = pointer.scrollSamples.filter((sample) =>
        Number.isFinite(sample.time) &&
        sample.time >= windowStart &&
        sample.time <= now &&
        Number.isFinite(sample.scrollTop) &&
        Number.isFinite(sample.scrollLeft)
      );
      const firstRecent = samples[0];
      const predecessor = [...pointer.scrollSamples].reverse().find((sample) =>
        Number.isFinite(sample.time) &&
        sample.time < windowStart &&
        Number.isFinite(sample.scrollTop) &&
        Number.isFinite(sample.scrollLeft)
      );
      if (
        predecessor &&
        firstRecent &&
        firstRecent.time > windowStart &&
        firstRecent.time - predecessor.time <= SAMPLE_WINDOW_MS
      ) {
        const fraction = (windowStart - predecessor.time) /
          (firstRecent.time - predecessor.time);
        samples.unshift({
          time: windowStart,
          scrollLeft: predecessor.scrollLeft +
            (firstRecent.scrollLeft - predecessor.scrollLeft) * fraction,
          scrollTop: predecessor.scrollTop +
            (firstRecent.scrollTop - predecessor.scrollTop) * fraction,
        });
      }
      if (samples.length < 2) return null;
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (last.time - first.time < MIN_SAMPLE_SPAN_MS) return null;

      let weightSum = 0;
      let weightedTime = 0;
      let weightedLeft = 0;
      let weightedTop = 0;
      for (const sample of samples) {
        const weight = Math.exp(-(now - sample.time) / (SAMPLE_WINDOW_MS / 2));
        const relativeTime = sample.time - now;
        weightSum += weight;
        weightedTime += weight * relativeTime;
        weightedLeft += weight * sample.scrollLeft;
        weightedTop += weight * sample.scrollTop;
      }
      if (weightSum <= 0) return null;

      const meanTime = weightedTime / weightSum;
      const meanLeft = weightedLeft / weightSum;
      const meanTop = weightedTop / weightSum;
      let timeVariance = 0;
      let leftCovariance = 0;
      let topCovariance = 0;
      for (const sample of samples) {
        const weight = Math.exp(-(now - sample.time) / (SAMPLE_WINDOW_MS / 2));
        const timeOffset = sample.time - now - meanTime;
        timeVariance += weight * timeOffset * timeOffset;
        leftCovariance += weight * timeOffset * (sample.scrollLeft - meanLeft);
        topCovariance += weight * timeOffset * (sample.scrollTop - meanTop);
      }
      if (timeVariance <= 0) return null;

      const velocity = {
        x: leftCovariance / timeVariance,
        y: topCovariance / timeVariance,
      };
      const speed = Math.hypot(velocity.x, velocity.y);
      if (speed > MAX_SPEED) {
        velocity.x *= MAX_SPEED / speed;
        velocity.y *= MAX_SPEED / speed;
      }
      if (
        Math.hypot(velocity.x, velocity.y) < START_SPEED ||
        this.prefersReducedMotion()
      ) {
        return null;
      }
      return velocity;
    }

    startMomentum(pointer, now = performance.now()) {
      if (
        !this.canStartMomentum(pointer) ||
        this.getVisibilityState() === "hidden"
      ) {
        return;
      }
      const velocity = this.releaseVelocity(pointer, now);
      if (!velocity) return;
      this.cancelMomentum();
      const momentum = {
        container: pointer.container,
        pdfDocument: pointer.pdfDocument,
        documentId: pointer.documentId,
        openRequest: pointer.openRequest,
        rendererGeneration: pointer.rendererGeneration,
        velocityX: velocity.x,
        velocityY: velocity.y,
        targetLeft: pointer.container.scrollLeft,
        targetTop: pointer.container.scrollTop,
        lastFrameTime: now,
        frame: 0,
      };
      this.momentum = momentum;
      const tick = (frameTime) => {
        if (this.momentum !== momentum) return;
        if (
          this.prefersReducedMotion() ||
          this.getVisibilityState() === "hidden" ||
          !this.canStartMomentum(momentum) ||
          !Number.isFinite(frameTime)
        ) {
          this.cancelMomentum();
          return;
        }
        const elapsed = Math.max(0, frameTime - momentum.lastFrameTime);
        momentum.lastFrameTime = Math.max(momentum.lastFrameTime, frameTime);
        const speed = Math.hypot(momentum.velocityX, momentum.velocityY);
        const timeToStop = speed > STOP_SPEED
          ? DECAY_MS * Math.log(speed / STOP_SPEED)
          : 0;
        const activeElapsed = Math.min(elapsed, timeToStop);
        if (activeElapsed > 0) {
          const decay = Math.exp(-activeElapsed / DECAY_MS);
          const travelFactor = DECAY_MS * (1 - decay);
          const requestedX = momentum.velocityX * travelFactor;
          const requestedY = momentum.velocityY * travelFactor;
          const previousLeft = momentum.container.scrollLeft;
          const previousTop = momentum.container.scrollTop;
          const maxLeft = Math.max(
            0,
            momentum.container.scrollWidth - momentum.container.clientWidth,
          );
          const maxTop = Math.max(
            0,
            momentum.container.scrollHeight - momentum.container.clientHeight,
          );
          momentum.targetLeft += requestedX;
          momentum.targetTop += requestedY;
          momentum.container.scrollLeft = momentum.targetLeft;
          momentum.container.scrollTop = momentum.targetTop;
          const movedX = momentum.container.scrollLeft - previousLeft;
          const movedY = momentum.container.scrollTop - previousTop;
          const atXBoundary = requestedX > 0
            ? momentum.container.scrollLeft >= maxLeft - 1
            : requestedX < 0 && momentum.container.scrollLeft <= 1;
          const atYBoundary = requestedY > 0
            ? momentum.container.scrollTop >= maxTop - 1
            : requestedY < 0 && momentum.container.scrollTop <= 1;
          if (
            Math.sign(movedX) !== Math.sign(requestedX) &&
            Math.abs(movedX) > 0.01
          ) {
            momentum.velocityX = 0;
          } else if (atXBoundary) {
            momentum.velocityX = 0;
            momentum.targetLeft = momentum.container.scrollLeft;
          } else {
            momentum.velocityX *= decay;
          }
          if (
            Math.sign(movedY) !== Math.sign(requestedY) &&
            Math.abs(movedY) > 0.01
          ) {
            momentum.velocityY = 0;
          } else if (atYBoundary) {
            momentum.velocityY = 0;
            momentum.targetTop = momentum.container.scrollTop;
          } else {
            momentum.velocityY *= decay;
          }
        }
        if (
          activeElapsed < elapsed ||
          Math.hypot(momentum.velocityX, momentum.velocityY) <= STOP_SPEED
        ) {
          this.cancelMomentum();
          return;
        }
        momentum.frame = this.requestFrame(tick);
      };
      momentum.frame = this.requestFrame(tick);
    }

    applyPan(pointer, event, eventTime = null) {
      if (!pointer || !this.canPan(pointer)) return;
      pointer.lastX = event.clientX;
      pointer.lastY = event.clientY;
      if (!pointer.moved) {
        pointer.moved = Math.hypot(
          event.clientX - pointer.startX,
          event.clientY - pointer.startY,
        ) >= 3;
      }
      if (!pointer.moved) return;
      pointer.container.scrollTop = pointer.startScrollTop -
        (event.clientY - pointer.startY);
      pointer.container.scrollLeft = pointer.startScrollLeft -
        (event.clientX - pointer.startX);
      this.rememberScroll(pointer, eventTime ?? this.eventTime(pointer, event));
    }
  }

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { ViewportController },
  );
})();
