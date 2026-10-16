// Test-only emulation of one local DataAdapter's per-path atomic process().
// Facades of the same persistent backing must pass the same backing object.
const queues = new WeakMap();
export function withAtomicProcess(adapter, backing = adapter) {
  let paths = queues.get(backing);
  if (!paths) { paths = new Map(); queues.set(backing, paths); }
  const run = (path, work) => {
    const result = (paths.get(path) || Promise.resolve()).catch(() => {}).then(work);
    const tail = result.then(() => undefined, () => undefined);
    paths.set(path, tail);
    void tail.then(() => { if (paths.get(path) === tail) paths.delete(path); });
    return result;
  };
  adapter.process = (path, modify) => run(path, async () => {
    const current = await adapter.exists(path) ? await adapter.read(path) : "";
    const next = modify(current);
    if (typeof next !== "string") throw new TypeError("process callback must return text synchronously");
    if (next !== current) await adapter.write(path, next);
    return next;
  });
  adapter.append ||= (path, value) => run(path, async () => {
    const current = await adapter.exists(path) ? await adapter.read(path) : "";
    await adapter.write(path, current + value);
  });
  return adapter;
}
