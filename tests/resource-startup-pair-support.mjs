import assert from 'node:assert/strict';

// Input tasks must be non-overlapping top-level renderer-main tasks, in ms.
// Nested trace slices must be flattened by the trace extractor before use.
export function summarizeStartupRun(run) {
  assert.equal(run.processCold, true, 'A fresh Dictionary is not process cold');
  assert.equal(run.traceStartedBeforeBundle, true, 'Trace must start before bundle evaluation');
  assert.equal(run.deferredWarmupSettled, true, 'Deferred work must be inside the window');
  assert.ok(Number.isFinite(run.startMs) && Number.isFinite(run.endMs) && run.endMs > run.startMs);
  let previousEnd = -Infinity;
  let cpuMs = 0, longestTaskMs = 0, tbtMs = 0;
  for (const task of run.tasks) {
    assert.ok(Number.isFinite(task.startMs) && Number.isFinite(task.durationMs) && task.durationMs >= 0);
    assert.ok(task.startMs >= previousEnd, 'Use top-level tasks, without nested double counting');
    previousEnd = task.startMs + task.durationMs;
    const duration = Math.max(0, Math.min(previousEnd, run.endMs) - Math.max(task.startMs, run.startMs));
    cpuMs += duration;
    longestTaskMs = Math.max(longestTaskMs, duration);
    tbtMs += Math.max(0, duration - 50);
  }
  return { cpuMs, longestTaskMs, tbtMs, elapsedMs: run.endMs - run.startMs };
}

export function summarizeStartupPair(baseline, enabled) {
  for (const key of ['packageSha256', 'resourceManifestSha256', 'fixtureSha256', 'runtime', 'windowPolicy']) {
    assert.ok(baseline[key], `Missing ${key}`);
    assert.equal(enabled[key], baseline[key], `Mismatched ${key}`);
  }
  assert.equal(baseline.availabilityActivation, false);
  assert.equal(enabled.availabilityActivation, true);
  assert.notEqual(baseline.pid, enabled.pid, 'Each arm needs its own cold process');
  assert.ok(Number.isInteger(baseline.pid) && Number.isInteger(enabled.pid));
  const a = summarizeStartupRun(baseline), b = summarizeStartupRun(enabled);
  return { baseline: a, enabled: b, addedRendererMainCpuMs: b.cpuMs - a.cpuMs,
    startupAcceptance: 'NOT_VERIFIED',
    reason: 'One pair is diagnostic only; retain all counterbalanced pairs and their signed increments.' };
}
