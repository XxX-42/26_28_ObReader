import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStartupRun, summarizeStartupPair } from './resource-startup-pair-support.mjs';

const run = (extra = {}) => ({ processCold: true, traceStartedBeforeBundle: true,
  deferredWarmupSettled: true, startMs: 0, endMs: 1000, pid: 1,
  packageSha256: 'bundle', resourceManifestSha256: 'manifest', fixtureSha256: 'fixture',
  runtime: 'Obsidian fixture', windowPolicy: 'bundle-start-plus-1000ms',
  availabilityActivation: false, tasks: [{ startMs: 10, durationMs: 25 }, { startMs: 50, durationMs: 25 }], ...extra });

test('sub-50ms tasks contribute main-thread task wall time despite zero TBT; idle elapsed is excluded', () => {
  assert.deepEqual(summarizeStartupRun(run()), { rendererMainTaskWallMs: 50,
    longestTaskMs: 25, tbtMs: 0, elapsedMs: 1000 });
  const result = summarizeStartupPair(run(), run({ pid: 2, availabilityActivation: true,
    tasks: [{ startMs: 10, durationMs: 40 }, { startMs: 70, durationMs: 40 }] }));
  assert.equal(result.addedRendererMainTaskWallMs, 30);
  assert.equal(result.startupAcceptance, 'NOT_VERIFIED');
});
test('reject attach-only, incomplete deferred work, mismatched packages and nested slices', () => {
  for (const patch of [{ processCold: false }, { traceStartedBeforeBundle: false }, { deferredWarmupSettled: false },
    { tasks: [{ startMs: 0, durationMs: 100 }, { startMs: 10, durationMs: 10 }] }]) {
    assert.throws(() => summarizeStartupRun(run(patch)));
  }
  assert.throws(() => summarizeStartupPair(run(), run({ pid: 2, availabilityActivation: true, packageSha256: 'other' })));
});
test('preserve negative paired increment and clip tasks to the measurement window', () => {
  const result = summarizeStartupPair(run(), run({ pid: 2, availabilityActivation: true,
    tasks: [{ startMs: -10, durationMs: 20 }, { startMs: 990, durationMs: 30 }] }));
  assert.equal(result.addedRendererMainTaskWallMs, -30);
});
