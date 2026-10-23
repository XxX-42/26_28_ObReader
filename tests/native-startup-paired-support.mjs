import assert from 'node:assert/strict';
export const STARTUP_PROBE_KEY = 'obreader.native.startup-paired.v1';
export function instrumentStartupOnload(source) {
  const seam = 'async onload() {';
  assert.equal(source.split(seam).length - 1, 1, 'Built package must expose exactly one actual async onload seam; refuse minified/ambiguous input');
  return source.replace(seam, `onload() {
    const probe = globalThis[Symbol.for(${JSON.stringify(STARTUP_PROBE_KEY)})];
    if (!probe || probe.record) return this.__nativeBenchmarkOriginalOnload();
    const start = performance.now();
    const record = probe.record = { startedAt: start, status: 'started' };
    let returned;
    try { returned = this.__nativeBenchmarkOriginalOnload(); }
    catch (error) { record.syncInvocationMs = performance.now() - start; record.status = 'failed'; record.error = String(error); throw error; }
    record.syncInvocationMs = performance.now() - start;
    return Promise.resolve(returned).then(value => {
      record.asyncSettledWallMs = performance.now() - start; record.status = 'settled'; return value;
    }, error => { record.asyncSettledWallMs = performance.now() - start; record.status = 'failed'; record.error = String(error); throw error; });
  }
  async __nativeBenchmarkOriginalOnload() {`);
}
export function summarizeStartupPairs(rows) {
  const pairs = Array.from({ length: 5 }, (_, index) => {
    const pair = index + 1;
    const baseline = rows.filter(row => row.pair === pair && row.phase === 'v2-baseline');
    const candidate = rows.filter(row => row.pair === pair && row.phase === 'v3-candidate');
    if (baseline.length !== 1 || candidate.length !== 1 || baseline[0].status !== 'MEASURED' || candidate[0].status !== 'MEASURED' || baseline[0].packageSha256 === candidate[0].packageSha256 || !Number.isFinite(baseline[0].record?.syncInvocationMs) || !Number.isFinite(candidate[0].record?.syncInvocationMs) || baseline[0].record?.status !== 'settled' || candidate[0].record?.status !== 'settled') return { pair, status: 'NOT_MEASURED' };
    return { pair, status: 'MEASURED_SYNCHRONOUS_INVOCATION_ONLY', addedSyncInvocationMs: candidate[0].record.syncInvocationMs - baseline[0].record.syncInvocationMs };
  });
  const measured = pairs.filter(row => Number.isFinite(row.addedSyncInvocationMs));
  return { pairs, syncInvocationUnder50ms: measured.length === 5 ? measured.every(row => row.addedSyncInvocationMs < 50) : null,
    fullStartupAddedBlocking: 'NOT_MEASURED', scope: 'plugin-cold instances in retained Native process/origin; synchronous onload invocation only' };
}
