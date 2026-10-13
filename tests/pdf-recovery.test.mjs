import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { writeDeltaRecovery, readDeltaRecovery } = require('../plugin/pdf-recovery.cjs');
function harness() {
  const files = new Map(), writes = [];
  const adapter = { exists: async p => files.has(p),
    writeBinary: async (p, a) => { files.set(p, a.slice(0)); writes.push({ p, bytes: a.byteLength }); },
    readBinary: async p => { if (!files.has(p)) throw Error('missing'); return files.get(p).slice(0); },
    write: async (p, a) => { files.set(p, a); writes.push({ p }); },
    read: async p => files.get(p), remove: async p => files.delete(p) };
  return { files, writes, adapter };
}
const root = '.obsidian/plugins/pdf-web-reader/.recovery';
const base = Uint8Array.from({ length: 100000 }, (_, i) => i % 251);
const output = new Uint8Array(base.length + 8); output.set(base); output.set([9,8,7,6,5,4,3,2], base.length);
function input(h, id = 'first') { return { adapter: h.adapter, root, data: output, bases: [base],
  metadata: { candidateId: id, revision: 2, status: 'pending' }, ensureDirectory: async () => {} }; }
test('durable compact recovery shares one baseline and reconstructs exact independent bytes', async () => {
  const h = harness(), a = await writeDeltaRecovery(input(h)), b = await writeDeltaRecovery(input(h, 'second'));
  assert.equal(h.writes.filter(x => x.p.includes('/.bases/')).length, 1);
  assert.equal(h.writes.filter(x => x.p.endsWith('.delta')).every(x => x.bytes === 8), true);
  assert.deepEqual(new Uint8Array(await readDeltaRecovery(h.adapter, root, b)), output);
  assert.equal(a.metadata.recoveryBase.file, b.metadata.recoveryBase.file);
  assert.equal(h.writes.at(-1).p, b.metadataPath, 'completion marker is committed last');
});
test('non-prefix branch keeps the full recovery fallback available', async () => {
  const h = harness(); assert.equal(await writeDeltaRecovery({ ...input(h), data: Uint8Array.from([8,7]) }), null);
  assert.equal(h.writes.length, 0);
});
test('base changed after first revision cannot acknowledge a later compact recovery', async () => {
  const h = harness(), a = await writeDeltaRecovery(input(h));
  h.files.set(`${root}/${a.metadata.recoveryBase.file}`, new Uint8Array(base.length).buffer);
  await assert.rejects(writeDeltaRecovery(input(h, 'second')), /校验失败/);
  assert.equal(h.files.has(`${root}/second.json`), false);
  await assert.rejects(readDeltaRecovery(h.adapter, root, a), /校验失败/);
});
test('partial delta write produces no completed revision and preserves shared baseline', async () => {
  const h = harness(), write = h.adapter.writeBinary;
  h.adapter.writeBinary = async (p, bytes) => write(p, p.endsWith('.delta') ? bytes.slice(0, 2) : bytes);
  await assert.rejects(writeDeltaRecovery(input(h)), /校验失败/);
  assert.equal(h.files.has(`${root}/first.json`), false); assert.equal(h.files.has(`${root}/first.delta`), false);
  assert.equal([...h.files.keys()].filter(x => x.includes('/.bases/')).length, 1);
});
test('recovery rejects malicious paths and detects corruption at reconstruction', async () => {
  const h = harness(), a = await writeDeltaRecovery(input(h));
  await assert.rejects(readDeltaRecovery(h.adapter, root, { ...a, metadata: { ...a.metadata,
    recoveryBase: { ...a.metadata.recoveryBase, file: '../user.pdf' } } }), /格式无效/);
  h.files.set(a.candidatePath, new Uint8Array(8).buffer);
  await assert.rejects(readDeltaRecovery(h.adapter, root, a), /校验失败/);
});
