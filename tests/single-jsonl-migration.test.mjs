import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {PDFDocument}=require('pdf-lib');
const {readPairId,attachPairId}=require('../plugin/pdf-pair-id.cjs');
const {prepareSingleJsonlMigration,digestMigrationBytes}=require('../plugin/storage/single-jsonl-migration.cjs');
const {sha256}=require('@noble/hashes/sha256');
const digest=b=>'sha256-v1:'+Array.from(sha256(b),v=>v.toString(16).padStart(2,'0')).join('');
const document={documentId:'kept-document',docKey:'123456abcdef',sourcePath:'Books/a.pdf',source:{sourceHash:'sha256-v1:'+'1'.repeat(64),orderedPageIdentities:['ref:4R']}};
test('migration SHA-256 uses platform crypto and keeps the exact fallback digest',async()=>{
 const bytes=new Uint8Array([0,1,2,127,128,255]);let calls=0;
 const subtle={async digest(algorithm,input){calls++;assert.equal(algorithm,'SHA-256');assert.deepEqual(new Uint8Array(input),bytes);return sha256(bytes).buffer}};
 assert.equal(await digestMigrationBytes(bytes,subtle),digest(bytes));assert.equal(calls,1);
 assert.equal(await digestMigrationBytes(bytes,null),digest(bytes));
 await assert.rejects(digestMigrationBytes(bytes,{async digest(){throw Error('injected crypto error')}}),/injected crypto error/);
});
async function fixture(){const pdf=await PDFDocument.create();pdf.addPage();return pdf.save({useObjectStreams:false})}
test('migration parses source once and verifies the paired output independently',async()=>{
 const bytes=await fixture(),boundDocument={...document,source:{...document.source,sourceHash:digest(bytes)}};
 const original=PDFDocument.load;let calls=0;
 PDFDocument.load=async function(...args){calls++;return original.apply(this,args)};
 try{
  const result=await prepareSingleJsonlMigration({sourceBytes:bytes,document:boundDocument,snapshot:{annotations:[],tombstones:[]},pairId:'12'.repeat(16)});
  assert.equal(calls,2,'the source and finished PDF each need one parse');
  assert.equal(result.pairId,'12'.repeat(16));
 }finally{PDFDocument.load=original}
});
test('migration retains an existing pair ID and rejects a conflicting requested ID',async()=>{
 const bytes=(await attachPairId(await fixture(),'34'.repeat(16))).bytes;
 const boundDocument={...document,source:{...document.source,sourceHash:digest(bytes)}};
 const snapshot={annotations:[],tombstones:[]};
 const result=await prepareSingleJsonlMigration({sourceBytes:bytes,document:boundDocument,snapshot});
 assert.equal(result.pairId,'34'.repeat(16));assert.equal(result.pdf.changed,false);
 assert.deepEqual(result.pdf.bytes,bytes);
 await assert.rejects(prepareSingleJsonlMigration({sourceBytes:bytes,document:boundDocument,snapshot,pairId:'56'.repeat(16)}),{code:'PDF_PAIR_ID_CONFLICT'});
});
test('migration preparation preserves exact UUID/payload and old logical source, without changing the input PDF',async()=>{
  const bytes=await fixture(),copy=bytes.slice();
  const boundDocument={...document,source:{...document.source,sourceHash:digest(bytes)}};
  const a={uuid:'A',kind:'Ink',pageIndex:0,payload:{editor:{paths:{lines:[1,2],points:[3,4]}}}};
  const d={uuid:'D',kind:'Highlight',pageIndex:0,version:{rev:2,deviceId:'old',seq:1}};
  const snapshot={annotations:[a],tombstones:[d],document:{id:document.documentId},source:{sourceHash:boundDocument.source.sourceHash}};
  const result=await prepareSingleJsonlMigration({sourceBytes:bytes,document:boundDocument,snapshot,pairId:'12'.repeat(16),clock:()=>100});
  assert.deepEqual(bytes,copy);assert.equal(await readPairId(bytes),null);
  assert.equal(await readPairId(result.pdf.bytes),'12'.repeat(16));
  assert.deepEqual(result.current.annotations,[a]);assert.deepEqual(result.current.tombstones,[d]);
  assert.equal(result.current.document.documentId,document.documentId);assert.equal(result.current.document.docKey,document.docKey);
  assert.equal(result.current.document.source.sourceHash,boundDocument.source.sourceHash);
  assert.notEqual(result.pdf.originalSha256,result.pdf.pairedSha256);
  assert.deepEqual(result.counts,{annotations:1,tombstones:1,deletionGuards:0});
});
test('incomplete data and duplicate UUIDs fail closed',async()=>{
  const bytes=await fixture();
  await assert.rejects(prepareSingleJsonlMigration({sourceBytes:bytes,document,snapshot:{annotations:[],tombstones:[],syncPending:true}}),{code:'V15_MIGRATION_UNVERIFIED'});
  await assert.rejects(prepareSingleJsonlMigration({sourceBytes:bytes,document,snapshot:{annotations:[{uuid:'A'}],tombstones:[{uuid:'A'}]}}),{code:'V15_MIGRATION_UNVERIFIED'});
});

test('a mismatched PDF cannot be paired with existing annotation geometry',async()=>{
  await assert.rejects(prepareSingleJsonlMigration({sourceBytes:await fixture(),document,snapshot:{annotations:[],tombstones:[]}}),{code:'V15_MIGRATION_UNVERIFIED'});
});
