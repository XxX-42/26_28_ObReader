import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PDFDocument, PDFName, PDFString } = require('pdf-lib');
const { generatePairId, readPairId, attachPairId, appendPairUpdate } = require('../plugin/pdf-pair-id.cjs');

async function fixture(noInfo = false) {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Preserved title'); pdf.addPage([200, 300]);
  if (noInfo) delete pdf.context.trailerInfo.Info;
  return pdf.save({ useObjectStreams: false });
}

test('pair identity comes from random bytes without reading PDF contents', () => {
  let calls = 0;
  const id = generatePairId({ getRandomValues(bytes) { calls++; bytes.fill(42); return bytes; } });
  assert.equal(id, '2a'.repeat(16)); assert.equal(calls, 1);
  assert.match(generatePairId(), /^[a-f0-9]{32}$/);
});

for (const noInfo of [false, true]) test(`metadata-only incremental identity preserves source prefix and page references (noInfo=${noInfo})`, async () => {
  const original = await fixture(noInfo), before = await PDFDocument.load(original, { updateMetadata: false });
  const id = '12'.repeat(16), result = await attachPairId(original, id);
  assert.equal(result.changed, true);
  assert.deepEqual(result.bytes.slice(0, original.length), original);
  assert.equal(await readPairId(result.bytes), id);
  const after = await PDFDocument.load(result.bytes, { updateMetadata: false });
  assert.deepEqual(after.getPages().map(p => p.ref.toString()), before.getPages().map(p => p.ref.toString()));
  assert.equal(after.getTitle(), before.getTitle());
  assert.equal(result.changedObjectCount, 1);
  const again = await attachPairId(result.bytes, id);
  assert.equal(again.changed, false); assert.deepEqual(again.bytes, result.bytes);
  await assert.rejects(attachPairId(result.bytes, '34'.repeat(16)), { code: 'PDF_PAIR_ID_CONFLICT' });
});

test('invalid identity and signed PDF are rejected before mutation', async () => {
  const original = await fixture();
  await assert.rejects(attachPairId(original, '../bad'), { code: 'PDF_PAIR_ID_INVALID' });
  const pdf = await PDFDocument.load(original, { updateMetadata: false });
  const sig = pdf.context.obj({ Type: PDFName.of('Sig'), Contents: PDFString.of('signature') });
  pdf.context.register(sig);
  const signed = await pdf.save({ useObjectStreams: false });
  await assert.rejects(attachPairId(signed, '12'.repeat(16)), { code: 'PDF_PAIR_ID_UNSUPPORTED' });
});

test('pair publication appends only the verified increment and retains the original prefix on partial write',async()=>{
  const original=await fixture(),paired=await attachPairId(original,'56'.repeat(16));
  let current=original.slice(),calls=0,partial=false;
  const vault={async readBinary(){return current.slice().buffer},async appendBinary(_file,buffer){calls++;let suffix=new Uint8Array(buffer);if(partial)suffix=suffix.subarray(0,Math.floor(suffix.length/2));const next=new Uint8Array(current.length+suffix.length);next.set(current);next.set(suffix,current.length);current=next;if(partial)throw Error('injected partial append')}};
  await appendPairUpdate(vault,{},paired.bytes);assert.equal(calls,1);assert.deepEqual(current,paired.bytes);
  current=original.slice();partial=true;await assert.rejects(appendPairUpdate(vault,{},paired.bytes),/injected partial append/);
  assert.deepEqual(current.slice(0,original.length),original);assert.ok(current.length<paired.bytes.length);
  current=original.slice();current[10]^=1;const before=calls;
  await assert.rejects(appendPairUpdate(vault,{},paired.bytes),{code:'PDF_PAIR_SOURCE_CHANGED'});assert.equal(calls,before);
});

test('the frozen PDF.js metadata reader exposes the pair identity used by the Viewer', async () => {
  // Rendering is not exercised in this Node test; PDF.js still expects these
  // browser constructors at module initialization.
  globalThis.DOMMatrix ??= class {};
  globalThis.ImageData ??= class {};
  globalThis.Path2D ??= class {};
  const pdfjs = await import('../vendor/pdfjs-generic-legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs-generic-legacy/build/pdf.worker.mjs', import.meta.url).href;
  const id = '34'.repeat(16), paired = await attachPairId(await fixture(), id);
  const loading = pdfjs.getDocument({data: Uint8Array.from(paired.bytes)});
  try {
    const document = await loading.promise;
    assert.equal((await document.getMetadata()).info.Custom.ObReaderPairId, id);
    await document.destroy();
  } finally { await loading.destroy(); }
});
