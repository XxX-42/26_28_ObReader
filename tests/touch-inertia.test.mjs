import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url),
  "utf8",
);
const section = source.slice(
  source.indexOf("  const MANUAL_INERTIA_SAMPLE_WINDOW_MS"),
  source.indexOf("  function clearManualPointerSessions"),
);
const selectionPolicySection = source.slice(
  source.indexOf("  function annotationToolIsActive"),
  source.indexOf("  function isPdfTextLayerTarget"),
);

function harness({ time = 0, scrollTop = 100, maxTop = 9500 } = {}) {
  let currentTime = time;
  let frameId = 0;
  let top = scrollTop;
  let left = 0;
  const frames = new Map();
  const containerClasses = new Set();
  const container = {
    isConnected: true,
    scrollHeight: maxTop + 500,
    clientHeight: 500,
    scrollWidth: 500,
    clientWidth: 500,
    style: { scrollBehavior: "smooth" },
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(maxTop, value)); },
    get scrollLeft() { return left; },
    set scrollLeft(value) { left = Math.max(0, Math.min(0, value)); },
    classList: {
      add(name) { containerClasses.add(name); },
      remove(name) { containerClasses.delete(name); },
      contains(name) { return containerClasses.has(name); },
    },
    setPointerCapture() {},
  };
  const pdfDocument = {};
  const state = {
    app: { pdfDocument },
    activeDocumentId: "doc",
    activeOpenRequest: 1,
    manualPointers: new Map(),
    manualMomentum: null,
    editorMode: 0,
    fingerTextSelectionSuppressionOwned: false,
  };
  const classes = new Set();
  const document = {
    visibilityState: "visible",
    body: { classList: { contains: () => false } },
    documentElement: { classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      remove(name) { classes.delete(name); },
    } },
    getElementById(id) { return id === "viewerContainer" ? container : null; },
  };
  const context = {
    state,
    runtimeLogRecord() {},
    rendererGeneration: 1,
    iosInputPolicy: true,
    document,
    directManipulationPage(target) { return target; },
    hasActivePenEditorGesture() { return false; },
    stopDirectManipulationEvent(event) {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
    },
    window: { matchMedia: () => ({ matches: false }) },
    performance: { now: () => currentTime },
    requestAnimationFrame(callback) {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
    releasePointerCapture() {},
  };
  vm.runInNewContext(
    selectionPolicySection + section +
      "\nglobalThis.api = { touchReleaseVelocity, rememberManualScroll, manualPointerEventTime, startManualMomentum, finishManualPointer, startManualPointer, applyManualPan, onManualDocumentVisibilityChange };",
    context,
  );
  return {
    state,
    container,
    document,
    frames,
    api: context.api,
    setTime(value) { currentTime = value; },
    frameAt(value) {
      currentTime = value;
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(value);
    },
  };
}

function makePointer(h, samples, overrides = {}) {
  const normalizedSamples = samples.map((sample) => ({
    time: sample.time,
    scrollTop: sample.y ?? 0,
    scrollLeft: sample.x ?? 0,
  }));
  const last = normalizedSamples.at(-1) || {
    time: h.api.manualPointerEventTime(null, null),
    scrollTop: h.container.scrollTop,
    scrollLeft: h.container.scrollLeft,
  };
  h.container.scrollTop = last.scrollTop;
  h.container.scrollLeft = last.scrollLeft;
  return {
    pointerId: 1,
    pointerType: "touch",
    container: h.container,
    pdfDocument: h.state.app.pdfDocument,
    documentId: "doc",
    openRequest: 1,
    rendererGeneration: 1,
    startX: 50,
    startY: 100,
    lastX: 50,
    lastY: 100,
    startScrollTop: last.scrollTop,
    startScrollLeft: last.scrollLeft,
    moved: true,
    lastMotionAt: last.time,
    scrollSamples: normalizedSamples,
    ...overrides,
  };
}

function linearSamples({ speedX = 0, speedY = 0, start = 0, duration = 80 }) {
  return [
    { time: start, x: 0, y: 0 },
    { time: start + duration, x: speedX * duration, y: speedY * duration },
  ];
}

function launchHarness(speedX = 0, speedY = 0) {
  const startTime = 100;
  const h = harness({ time: startTime });
  const pointer = makePointer(
    h,
    linearSamples({ speedX, speedY, start: startTime - 80, duration: 80 }),
  );
  h.api.startManualMomentum(pointer, startTime);
  assert.ok(h.state.manualMomentum, "the test flick should launch inertia");
  return { h, pointer, startTime };
}

test("release velocity is a recency-weighted regression over the final 80 ms", () => {
  const h = harness({ time: 80 });
  const pointer = makePointer(h, [
    { time: 0, x: 0, y: 0 },
    { time: 40, x: 0, y: 0 },
    { time: 80, x: 0, y: 8 },
  ]);
  const velocity = h.api.touchReleaseVelocity(pointer, 80);
  const weights = [Math.exp(-2), Math.exp(-1), 1];
  const times = [-80, -40, 0];
  const positions = [0, 0, 8];
  const sum = weights.reduce((total, weight) => total + weight, 0);
  const meanTime = weights.reduce((total, weight, i) => total + weight * times[i], 0) / sum;
  const meanPosition = weights.reduce((total, weight, i) => total + weight * positions[i], 0) / sum;
  const denominator = weights.reduce(
    (total, weight, i) => total + weight * (times[i] - meanTime) ** 2,
    0,
  );
  const expected = weights.reduce(
    (total, weight, i) =>
      total + weight * (times[i] - meanTime) * (positions[i] - meanPosition),
    0,
  ) / denominator;
  assert.ok(velocity);
  assert.ok(velocity.y > 0.1, "the newest accelerating sample should carry more weight");
  assert.ok(Math.abs(velocity.y - expected) < 1e-12);
  assert.equal(velocity.x, 0);
});

test("a light flick clears the launch threshold while a paused finger does not", () => {
  const h = harness({ time: 80 });
  const lightFlick = makePointer(h, linearSamples({ speedY: 0.1, start: 0 }));
  assert.ok(Math.abs(h.api.touchReleaseVelocity(lightFlick, 80).y - 0.1) < 1e-12);

  const paused = makePointer(
    h,
    linearSamples({ speedY: 0.5, start: 0 }),
    { lastMotionAt: 0 },
  );
  assert.equal(h.api.touchReleaseVelocity(paused, 81), null);
});

test("sample timing merges duplicate timestamps and rejects spans under 8 ms or sparse history", () => {
  const h = harness({ time: 20, scrollTop: 0 });
  const pointer = makePointer(h, [{ time: 0, x: 0, y: 0 }]);
  pointer.lastMotionAt = null;
  h.container.scrollTop = 1;
  h.api.rememberManualScroll(pointer, 10);
  h.container.scrollTop = 2;
  h.api.rememberManualScroll(pointer, 10);
  assert.equal(pointer.scrollSamples.length, 2);
  assert.deepEqual(
    pointer.scrollSamples.map(({ time, scrollTop }) => [time, scrollTop]),
    [[0, 0], [10, 2]],
  );
  assert.equal(pointer.lastMotionAt, 10);

  const tooShort = makePointer(h, [
    { time: 0, y: 0 },
    { time: 7.99, y: 4 },
  ]);
  assert.equal(h.api.touchReleaseVelocity(tooShort, 7.99), null);

  const sparse = makePointer(h, [
    { time: 0, y: 0 },
    { time: 81, y: 81 },
  ]);
  assert.equal(h.api.touchReleaseVelocity(sparse, 81), null);

  for (let i = 1; i <= 200; i += 1) {
    h.container.scrollTop = i;
    h.api.rememberManualScroll(pointer, i / 2);
  }
  assert.equal(pointer.scrollSamples.length, 128);
  const precedingWindow = pointer.scrollSamples.filter((sample) => sample.time < 20);
  assert.ok(precedingWindow.length <= 1);
  assert.ok(pointer.scrollSamples.at(-1).time >= 20);
});

test("the 80 ms window interpolates one nearby predecessor without an edge jump", () => {
  function velocityAt(releaseTime) {
    const h = harness({ time: releaseTime, scrollTop: 46.9 });
    const pointer = makePointer(h, [
      { time: 5953, y: 0 },
      { time: 5999.9, y: 46.9 },
      { time: releaseTime, y: 46.9 },
    ]);
    pointer.lastMotionAt = 5999.9;
    return h.api.touchReleaseVelocity(pointer, releaseTime);
  }

  const sampleAtBoundary = velocityAt(6033);
  const sampleJustOutsideBoundary = velocityAt(6033.8);
  assert.ok(sampleAtBoundary);
  assert.ok(sampleJustOutsideBoundary,
    "A sample 0.8 ms before the window edge must contribute through interpolation");
  assert.ok(sampleJustOutsideBoundary.y > 0.09,
    "The release estimate must retain the real recent flick speed");
  assert.ok(Math.abs(sampleJustOutsideBoundary.y - sampleAtBoundary.y) < 0.02,
    "Crossing the window edge by 0.8 ms must not cause a sudden velocity change");
});

test("a sample exactly on the 80 ms boundary is not counted twice", () => {
  function estimate(samples) {
    const h = harness({ time: 80, scrollTop: 40 });
    const pointer = makePointer(h, samples);
    pointer.lastMotionAt = 40;
    return h.api.touchReleaseVelocity(pointer, 80);
  }

  const withPredecessor = estimate([
    { time: -1, y: -1 },
    { time: 0, y: 0 },
    { time: 40, y: 40 },
    { time: 80, y: 40 },
  ]);
  const boundaryOnly = estimate([
    { time: 0, y: 0 },
    { time: 40, y: 40 },
    { time: 80, y: 40 },
  ]);
  assert.ok(withPredecessor);
  assert.ok(boundaryOnly);
  assert.equal(withPredecessor.x, boundaryOnly.x);
  assert.equal(withPredecessor.y, boundaryOnly.y);
});

test("event timestamps use the performance clock when origins do not match", () => {
  const h = harness({ time: 100 });
  const pointer = makePointer(h, [{ time: 90, y: 0 }]);
  assert.equal(h.api.manualPointerEventTime(pointer, { timeStamp: 95 }, 100), 95);
  assert.equal(h.api.manualPointerEventTime(pointer, { timeStamp: 900000 }, 100), 100);
  assert.equal(h.api.manualPointerEventTime(pointer, { timeStamp: 100.1 }, 100), 100);
  assert.equal(h.api.manualPointerEventTime(pointer, { timeStamp: 85 }, 100), 100);
});

test("diagonal release velocity is capped at 4 px/ms by vector magnitude", () => {
  const h = harness({ time: 80 });
  const pointer = makePointer(h, linearSamples({ speedX: 5, speedY: 5, start: 0 }));
  const velocity = h.api.touchReleaseVelocity(pointer, 80);
  assert.ok(velocity);
  assert.ok(Math.abs(Math.hypot(velocity.x, velocity.y) - 4) < 1e-12);
  assert.ok(Math.abs(velocity.x - Math.SQRT2 * 2) < 1e-12);
  assert.ok(Math.abs(velocity.y - Math.SQRT2 * 2) < 1e-12);
});

test("stationary pointerup records its endpoint without refreshing last motion", () => {
  const h = harness({ time: 80, scrollTop: 40 });
  const pointer = makePointer(h, [
    { time: 0, y: 0 },
    { time: 40, y: 40 },
  ]);
  pointer.lastMotionAt = 40;
  pointer.startScrollTop = 40;
  h.state.manualPointers.set(pointer.pointerId, pointer);
  h.api.finishManualPointer(1, { clientX: 50, clientY: 100, timeStamp: 80 });
  assert.equal(pointer.lastMotionAt, 40);
  assert.equal(pointer.scrollSamples.at(-1).time, 80);
  assert.equal(pointer.scrollSamples.at(-1).scrollTop, 40);
  assert.equal(pointer.scrollSamples.at(-1).scrollLeft, 0);
  assert.ok(h.state.manualMomentum);

  const paused = harness({ time: 121, scrollTop: 40 });
  const oldPointer = makePointer(paused, [
    { time: 0, y: 0 },
    { time: 40, y: 40 },
  ]);
  oldPointer.lastMotionAt = 40;
  oldPointer.startScrollTop = 40;
  paused.state.manualPointers.set(oldPointer.pointerId, oldPointer);
  paused.api.finishManualPointer(
    1,
    { clientX: 50, clientY: 100, timeStamp: 121 },
  );
  assert.equal(oldPointer.lastMotionAt, 40);
  assert.equal(paused.state.manualMomentum, null);
});

test("pointerup applies its final position while pointercancel ignores it", () => {
  const released = harness({ time: 116, scrollTop: 100 });
  const releasePointer = makePointer(released, [
    { time: 0, y: 0 },
    { time: 100, y: 100 },
  ]);
  released.state.manualPointers.set(releasePointer.pointerId, releasePointer);
  released.api.finishManualPointer(
    releasePointer.pointerId,
    { clientX: 50, clientY: 60, timeStamp: 116 },
  );
  assert.equal(released.container.scrollTop, 140);
  assert.equal(released.state.manualPointers.size, 0);
  assert.ok(released.state.manualMomentum);

  const cancelled = harness({ time: 116, scrollTop: 100 });
  const cancelPointer = makePointer(cancelled, [
    { time: 0, y: 0 },
    { time: 100, y: 100 },
  ]);
  cancelled.state.manualPointers.set(cancelPointer.pointerId, cancelPointer);
  cancelled.api.finishManualPointer(
    cancelPointer.pointerId,
    { clientX: 50, clientY: 60, timeStamp: 116 },
    { cancel: true },
  );
  assert.equal(cancelled.container.scrollTop, 100);
  assert.equal(cancelled.state.manualPointers.size, 0);
  assert.equal(cancelled.state.manualMomentum, null);
});

test("a second direct pointer blocks both touch pans regardless of lift order", () => {
  for (const releaseOrder of [[2, 1], [1, 2]]) {
    const h = harness({ time: 0, scrollTop: 100 });
    const down = (pointerId) => h.api.startManualPointer({
      pointerId,
      pointerType: "touch",
      target: { id: `target-${pointerId}` },
      clientX: 50,
      clientY: 100,
      timeStamp: h.api.manualPointerEventTime(null, null, 0),
      preventDefault() {},
      stopImmediatePropagation() {},
    }, "touch");
    const first = down(1);
    h.setTime(16);
    h.api.applyManualPan(first, {
      clientX: 50,
      clientY: 80,
      timeStamp: 16,
    });
    assert.equal(h.container.scrollTop, 120);
    assert.equal(first.moved, true);

    h.setTime(20);
    const second = h.api.startManualPointer({
      pointerId: 2,
      pointerType: "touch",
      target: { id: "target-2" },
      clientX: 50,
      clientY: 100,
      timeStamp: 20,
      preventDefault() {},
      stopImmediatePropagation() {},
    }, "touch");
    assert.equal(first.blockedByOtherPointer, true);
    assert.equal(first.moved, false);
    assert.equal(first.lastMotionAt, null);
    assert.equal(first.scrollSamples.length, 1);
    assert.equal(second.blockedByOtherPointer, true);

    h.setTime(36);
    h.api.applyManualPan(first, {
      clientX: 50,
      clientY: 50,
      timeStamp: 36,
    });
    h.api.applyManualPan(second, {
      clientX: 50,
      clientY: 70,
      timeStamp: 36,
    });
    assert.equal(h.container.scrollTop, 120,
      "Neither pointer may pan after the second direct contact joins");

    for (const pointerId of releaseOrder) {
      const pointer = pointerId === 1 ? first : second;
      h.setTime(40);
      h.api.finishManualPointer(pointerId, {
        clientX: 50,
        clientY: pointer.lastY,
        timeStamp: 40,
      });
      assert.equal(h.state.manualMomentum, null,
        "No release order may create one-finger inertia after multi-touch");
      assert.equal(h.container.scrollTop, 120);
    }
    assert.equal(h.state.manualPointers.size, 0);
  }
});

test("inertia has partition-independent decay across 60, 120 Hz and an 80 ms stall", () => {
  const duration = 200;
  const stopTime = 350 * Math.log(0.8 / 0.01);
  const frame60 = duration / 12;
  const frame120 = duration / 24;
  const schedules = [
    Array.from(
      { length: Math.ceil(stopTime / frame60) },
      (_, i) => frame60 * (i + 1),
    ),
    Array.from(
      { length: Math.ceil(stopTime / frame120) },
      (_, i) => frame120 * (i + 1),
    ),
    (() => {
      const frames = [16, 33, 50, 130, 146, 163, 181, 200];
      const intervals = [16, 17, 19, 80, 13, 21];
      let i = 0;
      while (frames.at(-1) <= stopTime) {
        frames.push(frames.at(-1) + intervals[i % intervals.length]);
        i += 1;
      }
      return frames;
    })(),
  ];
  const results = schedules.map((schedule) => {
    const { h, startTime } = launchHarness(0, 0.8);
    let at200 = null;
    for (const elapsed of schedule) {
      h.frameAt(startTime + elapsed);
      if (elapsed === duration) {
        at200 = {
          position: h.container.scrollTop,
          velocity: h.state.manualMomentum.velocityY,
        };
      }
    }
    return {
      at200,
      finalPosition: h.container.scrollTop,
      stopped: h.state.manualMomentum === null,
    };
  });
  const expectedPosition = 64 + 0.8 * 350 * (1 - Math.exp(-duration / 350));
  const expectedVelocity = 0.8 * Math.exp(-duration / 350);
  for (const result of results) {
    assert.ok(result.at200);
    assert.ok(Math.abs(result.at200.position - expectedPosition) < 1e-9);
    assert.ok(Math.abs(result.at200.velocity - expectedVelocity) < 1e-12);
    assert.equal(result.stopped, true);
    assert.ok(Math.abs(result.finalPosition - (64 + 350 * (0.8 - 0.01))) <= 1);
  }
  assert.ok(Math.max(...results.map((result) => result.at200.position)) -
    Math.min(...results.map((result) => result.at200.position)) < 1e-9);
  assert.ok(Math.max(...results.map((result) => result.finalPosition)) -
    Math.min(...results.map((result) => result.finalPosition)) <= 1);
});

test("a long frame integrates only through the exact stop time", () => {
  const { h, startTime } = launchHarness(0, 0.8);
  const stopTime = 350 * Math.log(0.8 / 0.01);
  h.frameAt(startTime + stopTime + 80);
  assert.equal(h.state.manualMomentum, null);
  const expected = 64 + 350 * (0.8 - 0.01);
  assert.ok(Math.abs(h.container.scrollTop - expected) <= 1);
  const stoppedPosition = h.container.scrollTop;
  h.frameAt(startTime + stopTime + 160);
  assert.equal(h.container.scrollTop, stoppedPosition);
});

test("hiding cancels inertia and prevents an active finger from restarting it", () => {
  const { h, pointer, startTime } = launchHarness(0, 0.8);
  h.state.manualPointers.set(pointer.pointerId, pointer);
  h.setTime(startTime + 16);
  h.document.visibilityState = "hidden";
  h.api.onManualDocumentVisibilityChange();
  assert.equal(h.state.manualMomentum, null);
  assert.equal(h.container.classList.contains("pdfReaderBackgrounded"), true,
    "The hidden Viewer scroll surface must be frozen during backgrounding");
  assert.equal(pointer.blockedByVisibility, true);
  assert.equal(pointer.moved, false);

  h.document.visibilityState = "visible";
  h.setTime(startTime + 32);
  h.api.onManualDocumentVisibilityChange();
  h.api.finishManualPointer(
    pointer.pointerId,
    { clientX: 50, clientY: 100, timeStamp: startTime + 32 },
  );
  assert.equal(h.state.manualMomentum, null);
  assert.equal(h.container.classList.contains("pdfReaderBackgrounded"), false,
    "Foregrounding must release the background scroll freeze");
});
