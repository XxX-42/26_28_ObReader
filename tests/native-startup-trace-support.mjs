// CDP-only optional diagnostics; task occupancy is not exclusive plugin CPU.
export function metricDelta(before, after) {
  const first = new Map((before?.metrics || []).map(row => [row.name, row.value]));
  return Object.fromEntries((after?.metrics || []).filter(row => first.has(row.name) && ['TaskDuration', 'ScriptDuration', 'JSDuration', 'ThreadTime', 'JSHeapUsedSize', 'Timestamp'].includes(row.name))
    .map(row => [row.name, { before: first.get(row.name), after: row.value, delta: row.value - first.get(row.name), unit: row.name === 'JSHeapUsedSize' ? 'bytes' : 'seconds' }]));
}
function unionDuration(intervals) {
  let total = 0, end = -Infinity;
  for (const [start, stop] of intervals.sort((a, b) => a[0] - b[0])) { total += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop); }
  return total;
}
export function summarizeRendererTrace(trace, runId) {
  const events = trace.traceEvents || [];
  const marker = suffix => events.filter(row => row.name === `obreader-startup:${runId}:${suffix}` && Number.isFinite(row.ts));
  const start = marker('onload-start'), stop = marker('quiet-end');
  if (start.length !== 1 || stop.length !== 1 || stop[0].ts <= start[0].ts) return { status: 'NOT_MEASURED', reason: 'Unique ordered onload-start/quiet-end userTiming marks unavailable' };
  const { pid, tid } = start[0];
  const metadata = events.find(row => row.ph === 'M' && row.name === 'thread_name' && row.pid === pid && row.tid === tid);
  if (metadata?.args?.name !== 'CrRendererMain' || stop[0].pid !== pid || stop[0].tid !== tid) return { status: 'NOT_MEASURED', reason: 'UserTiming thread was not confirmed as CrRendererMain', pid, tid, threadName: metadata?.args?.name || null };
  const lower = start[0].ts, upper = stop[0].ts;
  // Chrome emits complete X slices or paired B/E slices depending on version.
  const slices = [], stack = [];
  for (const row of events.filter(event => event.pid === pid && event.tid === tid).sort((a, b) => a.ts - b.ts)) {
    if (row.ph === 'X' && Number.isFinite(row.dur)) slices.push(row);
    else if (row.ph === 'B') stack.push(row);
    else if (row.ph === 'E') { const opened = stack.pop(); if (opened) slices.push({ ...opened, dur: row.ts - opened.ts }); }
  }
  const relevant = slices.filter(row => row.ts < upper && row.ts + row.dur > lower && row.dur >= 0);
  const tasks = relevant.filter(row => /(?:^|::)RunTask$/u.test(row.name));
  if (!tasks.length) return { status: 'NOT_MEASURED', reason: 'No recognized renderer RunTask slices; inspect raw trace rather than treating absence as zero', pid, tid, threadName: metadata.args.name };
  const interval = row => [Math.max(lower, row.ts), Math.min(upper, row.ts + row.dur)];
  const taskOccupancyMs = unionDuration(tasks.map(interval)) / 1000;
  return { status: 'MEASURED_RENDERER_WINDOW_OCCUPANCY', pid, tid, threadName: metadata.args.name,
    boundsTraceUs: { onloadStart: lower, quietEnd: upper }, windowWallMs: (upper - lower) / 1000,
    taskOccupancyMs, taskCount: tasks.length,
    tasks: tasks.map(row => ({ name: row.name, startTraceUs: row.ts, durationMs: row.dur / 1000, clippedDurationMs: (interval(row)[1] - interval(row)[0]) / 1000 })),
    functionAndGCSlices: relevant.filter(row => /FunctionCall|EvaluateScript|V8\.Execute|GC|Parse/u.test(row.name)).map(row => ({ name: row.name, startTraceUs: row.ts, durationMs: row.dur / 1000, args: row.args })),
    scope: 'Union of renderer main-thread task wall slices in onload-start through quiet-end; includes app activity, instrumentation, GC and scheduling; not exclusive plugin CPU' };
}
export async function startStartupDiagnostics(session) {
  const state = { capabilities: {}, traceStarted: false, profilerStarted: false };
  for (const [label, command, params] of [
    ['performance', 'Performance.enable', {}],
    ['profiler', 'Profiler.enable', {}],
  ]) try { await session.send(command, params); state.capabilities[label] = 'ENABLED'; } catch (error) { state.capabilities[label] = `NOT_MEASURED: ${error.message}`; }
  if (state.capabilities.performance === 'ENABLED') try { state.performanceBefore = await session.send('Performance.getMetrics'); } catch (error) { state.capabilities.performance = `NOT_MEASURED: ${error.message}`; }
  if (state.capabilities.profiler === 'ENABLED') try { await session.send('Profiler.setSamplingInterval', { interval: 1000 }); await session.send('Profiler.start'); state.profilerStarted = true; } catch (error) { state.capabilities.profiler = `NOT_MEASURED: ${error.message}`; }
  try {
    await session.send('Tracing.start', { transferMode: 'ReturnAsStream', categories: 'toplevel,devtools.timeline,v8.execute,blink.user_timing,renderer.scheduler', options: 'record-as-much-as-possible' });
    state.traceStarted = true; state.capabilities.tracing = 'STARTED';
  } catch (error) { state.capabilities.tracing = `NOT_MEASURED: ${error.message}`; }
  return state;
}
export async function stopStartupDiagnostics(session, state) {
  const result = { capabilities: state.capabilities, performanceBefore: state.performanceBefore || null };
  if (state.performanceBefore) try { result.performanceAfter = await session.send('Performance.getMetrics'); result.performanceDelta = metricDelta(state.performanceBefore, result.performanceAfter); } catch (error) { result.performanceError = String(error); }
  if (state.profilerStarted) try { result.cpuProfile = (await session.send('Profiler.stop')).profile; } catch (error) { result.profilerError = String(error); }
  if (state.traceStarted) {
    let listener;
    const complete = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { session.off('Tracing.tracingComplete', listener); reject(Error('Trace completion timed out')); }, 15000);
      listener = event => { clearTimeout(timeout); resolve(event); };
      session.once('Tracing.tracingComplete', listener);
    });
    try {
      await session.send('Tracing.end');
      const completed = await complete;
      result.traceDataLoss = completed.dataLossOccurred === true;
      if (!completed.stream) throw Error('Tracing produced no stream');
      const chunks = [];
      try {
        for (;;) { const chunk = await session.send('IO.read', { handle: completed.stream }); chunks.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data); if (chunk.eof) break; }
      } finally { result.traceRaw = chunks.join(''); await session.send('IO.close', { handle: completed.stream }); }
    } catch (error) { result.traceError = String(error); complete.catch(() => {}); }
  }
  return result;
}
