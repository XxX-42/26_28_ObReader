import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { squareRegion, cropViewport, createRectangleDocumentPool } = require('../plugin/rectangle-embed.cjs');
const { encodeReaderLinkFragment, parseReaderLinkFragment } = require('../plugin/reader-anchor-store.cjs');

test('region embeds opt into existing document identity without changing ordinary copied links', () => {
  const options = { pageNumber: 8, docKey: '123456abcdef', documentId: 'document-rectangle', target: { kind: 'annotation', id: 'square-uuid' } };
  const compact = encodeReaderLinkFragment(options);
  assert.equal(parseReaderLinkFragment(compact).docKey, null);
  const link = encodeReaderLinkFragment({ ...options, includeIdentity: true });
  assert.deepEqual(parseReaderLinkFragment(link), { pageNumber: 8, selection: null,
    docKey: options.docKey, documentId: options.documentId, target: options.target });
});

test('Square region uses current durable geometry and rejects invalid/deleted targets', () => {
  const row = { kind: 'Square', uuid: 'uuid', pageIndex: 2, payload: { editor: { rect: [40, 60, 10, 20] } } };
  assert.deepEqual(squareRegion(row), { uuid: 'uuid', pageIndex: 2, rect: [10,20,40,60] });
  assert.deepEqual(row.payload.editor.rect, [40,60,10,20]);
  assert.equal(squareRegion({ ...row, deleted: true }), null);
  assert.equal(squareRegion({ ...row, kind: 'Highlight' }), null);
  assert.throws(() => squareRegion({ ...row, payload: { editor: { rect: [1,2,1,2] } } }), /为空/);
  assert.throws(() => squareRegion({ ...row, payload: { editor: { rect: [1,2,Infinity,4] } } }), /无效/);
});

test('crop bounds honor CropBox, preserve PDF geometry, and bound output memory', () => {
  const rect = [0, 0, 10000, 10000];
  const page = { view: [10,20,8010,8020], getViewport({scale}) {
    return { convertToViewportRectangle: r => r.map(x => x * scale) };
  } };
  const result = cropViewport(page, rect, 2);
  assert.ok(result.width * result.height <= 4_005_000);
  assert.deepEqual(rect, [0,0,10000,10000]);
  assert.equal(result.cssWidth, 8000);
  assert.throws(() => cropViewport(page, [0,0,1,1]), /页面内/);
});

test('document pool borrows only verified matching Readers and never destroys their document', async () => {
  let destroyed = 0;
  const document = { getPage() {}, destroy() { destroyed++; } };
  const plugin = { app:{vault:{adapter:{stat:async()=>({mtime:1,size:3})},readBinary:async()=>new Uint8Array([1,2,3])}},
    pdfHashRuntime:{matches:()=>true},views: [{ annotationHydrationAllowed: true, annotationDocument: { documentId: 'D', docKey: 'K' },
    documentFile: { path: 'A.pdf' }, iframe: { contentWindow: { PDFViewerApplication: { pdfDocument: document } } } }] };
  const pool = createRectangleDocumentPool(plugin);
  assert.equal((await pool.acquire({ file: { path: 'A.pdf' }, document: { documentId: 'D', docKey: 'K',source:{sourceHash:'verified'} } })).document, document);
  await pool.dispose(); assert.equal(destroyed, 0);
  await assert.rejects(pool.acquire({}), /取消/);
});

const bridge = await readFile(new URL('../viewer-adapter/obsidian-bridge.js',import.meta.url),'utf8');
const finishSource = bridge.slice(bridge.indexOf('  async function finishRectangleRegion('),bridge.indexOf('  function installBridgeControls()'));
function regionHarness(save) {
  const pdfDocument={}, events=[], messages=[], status=[];
  const pending={documentId:'doc',openRequest:1,pdfDocument,editor:{id:'runtime'},finishing:false};
  const state={rectangleRegion:pending,activeDocumentId:'doc',activeOpenRequest:1,autoCopySequence:7,
    app:{pdfDocument,eventBus:{dispatch:(...args)=>events.push(args)}},annotationUuidByRuntimeId:new Map([['runtime','stable-uuid']])};
  const finish=new Function('state','requestSave','postToHost','showStatus','makeSyncUuid','window',`${finishSource};return finishRectangleRegion`)(state,save,(...args)=>messages.push(args),value=>status.push(value),()=> 'capture-id',{});
  return {state,pending,events,messages,status,finish};
}
test('one-shot region capture waits for saved ACK and never copies on failed saves', async () => {
  const failed=regionHarness(async()=>false);await failed.finish();assert.deepEqual(failed.messages,[]);
  const rejected=regionHarness(async()=>{throw Error('disk failed')});await rejected.finish();assert.deepEqual(rejected.messages,[]);assert.match(rejected.status[0],/disk failed/);
  let release;const h=regionHarness(()=>new Promise(resolve=>{release=resolve}));
  const finishing=h.finish();assert.deepEqual(h.messages,[]);release(true);await finishing;
  assert.equal(h.messages.length,1);assert.equal(h.messages[0][1].annotationUuid,'stable-uuid');
  assert.equal(h.messages[0][1].output,'region-embed');assert.equal(h.events[0][1].mode,0);assert.equal(h.state.rectangleRegion,null);
});
test('new pointer input and replaced documents cancel a region awaiting save', async () => {
  for(const change of [h=>h.state.autoCopySequence++,h=>h.state.activeOpenRequest++,h=>h.state.disposed=true]) {
    let release;const h=regionHarness(()=>new Promise(resolve=>{release=resolve}));
    const finishing=h.finish();change(h);release(true);await finishing;assert.deepEqual(h.messages,[]);
  }
});
