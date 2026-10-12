import assert from 'node:assert/strict';
import test from 'node:test';
import coordinator from '../plugin/heavy-work.cjs';

function harness(enabled = true) {
  let next = 0;
  return coordinator.createHeavyWorkCoordinator({ enabled: () => enabled, makeId: () => String(++next) });
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('mobile save slot keeps serialization and borrowed host cleanup serial across Readers', async () => {
  const work = harness(), a = {}, b = {}, file = {};
  const context = { file, documentId: 'a', openRequest: 1, rendererGeneration: 'r' };
  const lease = await work.acquire(a, context);
  const host = work.borrow(a, context, lease.id);
  let granted = false;
  const second = work.acquire(b, { file: {}, documentId: 'b' }).then(l => { granted = true; return l; });
  lease.release();
  await turn();
  assert.equal(granted, false, 'Viewer ack must not unlock before host cleanup finishes');
  host.release();
  const next = await second;
  assert.equal(granted, true);
  host.release(); // idempotent, must not release the next owner's slot
  assert.equal(work.release(a, next.id), false);
  next.release();
  work.dispose();
});

test('borrow rejects another Reader, document, stale open and detached session', async () => {
  const work = harness(), owner = {}, file = {};
  let current = true;
  const context = { file, documentId: 'doc', openRequest: 2, rendererGeneration: 'r' };
  const lease = await work.acquire(owner, context, { valid: () => current });
  assert.throws(() => work.borrow({}, context, lease.id));
  assert.throws(() => work.borrow(owner, { ...context, file: {} }, lease.id));
  assert.throws(() => work.borrow(owner, { ...context, openRequest: 3 }, lease.id));
  current = false;
  assert.throws(() => work.borrow(owner, context, lease.id));
  lease.release();
});

test('cancel and stale queued sessions never grant a PDF slot to a closed Reader', async () => {
  const work = harness(), a = {}, b = {}, c = {};
  const held = await work.acquire(a, {});
  const cancelled = work.acquire(b, {}, { requestId: 'cancelled' });
  const rejected = assert.rejects(cancelled, /cancelled/);
  work.cancel(b, 'cancelled');
  await rejected;
  let valid = true;
  const queued = work.acquire(c, {}, { valid: () => valid });
  const stale = assert.rejects(queued, /changed/);
  valid = false;
  held.release();
  await stale;
  work.dispose();
});

test('desktop skips the mobile budget; unload rejects queued work without prematurely detaching active host buffers', async () => {
  const desktop = harness(false);
  const [a, b] = await Promise.all([desktop.acquire({}, {}), desktop.acquire({}, {})]);
  assert.equal(a.id, null); assert.equal(b.id, null);
  a.release(); b.release();
  const work = harness(), owner = {}, context = { file: {} };
  const lease = await work.acquire(owner, context);
  const host = work.borrow(owner, context, lease.id);
  const queued = work.acquire({}, {});
  const rejection = assert.rejects(queued, /disposed/);
  work.dispose();
  await rejection;
  host.release(); lease.release();
  await assert.rejects(work.acquire({}, {}), /disposed/);
});

test('closing a Reader cannot unlock a still-running host-owned parser', async () => {
  const work = harness(), owner = {};
  const parsing = await work.acquire(owner, {});
  let granted = false;
  const next = work.acquire({}, {}).then(lease => { granted = true; return lease; });
  work.cancel(owner);
  await turn();
  assert.equal(granted, false);
  parsing.release();
  (await next).release();
  work.dispose();
});
