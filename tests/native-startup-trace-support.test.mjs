import assert from 'node:assert/strict';
import test from 'node:test';
import { metricDelta, summarizeRendererTrace, startStartupDiagnostics, stopStartupDiagnostics } from './native-startup-trace-support.mjs';
const event = (name, ts, extra = {}) => ({ name, ts, pid: 7, tid: 9, ph: 'X', dur: 0, ...extra });
test('trace confirms renderer thread and clips union of tasks without double counting nested slices', () => {
  const trace = { traceEvents: [
    event('thread_name', 0, { ph: 'M', args: { name: 'CrRendererMain' } }),
    event('obreader-startup:run:onload-start', 1000, { ph: 'I' }),
    event('obreader-startup:run:quiet-end', 11000, { ph: 'I' }),
    event('ThreadControllerImpl::RunTask', 0, { dur: 5000 }),
    event('RunTask', 2000, { dur: 2000 }),
    event('RunTask', 8000, { ph: 'B' }), event('RunTask', 12000, { ph: 'E' }),
    event('FunctionCall', 2000, { dur: 1000 }),
    event('RunTask', 0, { dur: 30000, tid: 12 }),
  ] };
  const result = summarizeRendererTrace(trace, 'run');
  assert.equal(result.status, 'MEASURED_RENDERER_WINDOW_OCCUPANCY');
  assert.equal(result.pid, 7); assert.equal(result.tid, 9);
  assert.equal(result.taskOccupancyMs, 7); // [1,5] union [8,11] ms
  assert.equal(result.functionAndGCSlices.length, 1);
  assert.equal(summarizeRendererTrace({ traceEvents: [] }, 'run').status, 'NOT_MEASURED');
  trace.traceEvents[0].args.name = 'WorkerThread';
  assert.equal(summarizeRendererTrace(trace, 'run').status, 'NOT_MEASURED');
});
test('Performance counters preserve actual units and do not claim exclusive CPU', () => {
  const delta = metricDelta({ metrics: [{ name: 'TaskDuration', value: 2 }, { name: 'ThreadTime', value: 3 }] }, { metrics: [{ name: 'TaskDuration', value: 2.04 }, { name: 'ThreadTime', value: 3.01 }] });
  assert.equal(delta.TaskDuration.unit, 'seconds');
  assert.ok(Math.abs(delta.TaskDuration.delta - 0.04) < 1e-9);
});
test('optional CDP diagnostics preserve stream and profile without a browser', async () => {
  const handlers = new Map();
  const calls = [];
  const session = {
    once(name, fn) { handlers.set(name, fn); }, off(name) { handlers.delete(name); },
    async send(command) { calls.push(command);
      if (command === 'Tracing.end') handlers.get('Tracing.tracingComplete')({ stream: 'owned', dataLossOccurred: false });
      if (command === 'IO.read') return { data: '{"traceEvents":[]}', eof: true };
      if (command === 'Profiler.stop') return { profile: { nodes: [], samples: [] } };
      if (command === 'Performance.getMetrics') return { metrics: [] };
      return {};
    },
  };
  const state = await startStartupDiagnostics(session);
  const result = await stopStartupDiagnostics(session, state);
  assert.equal(result.traceRaw, '{"traceEvents":[]}');
  assert.deepEqual(result.cpuProfile.nodes, []);
  assert.ok(calls.includes('IO.close'));
});
