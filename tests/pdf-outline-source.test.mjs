import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {PDFDocument,PDFName,PDFString,PDFNumber,PDFArray,PDFRef} from 'pdf-lib';
const require=createRequire(import.meta.url);
const {verifyOutlineUpdate,LIMITS}=require('../plugin/pdf-outline-source.cjs');
const {createPdfHashRuntime}=require('../plugin/pdf-hash-runtime.cjs');
const {captureIncrementalSnapshot,createIncrementalPatch,materializeIncrementalResult,readSourceTrailer}=require('../plugin/pdf-incremental.cjs');
const runtime=await createPdfHashRuntime();
const K=PDFName.of;
import {fixture,sourceOf,append,addOutline} from './pdf-outline-fixtures.mjs';
function rawRevision(base,entries,body=''){const t=readSourceTrailer(base);const bodyBytes=new TextEncoder().encode('\n'+body);const offset=base.length+bodyBytes.length;const xref='xref\n'+entries.map(e=>`${e.num} 1\n${String(e.offset).padStart(10,'0')} ${String(e.gen||0).padStart(5,'0')} ${e.type||'n'} \n`).join('');const trailer=`trailer\n<< /Size ${Math.max(t.declaredSize,...entries.map(e=>e.num+1))} /Root ${t.root} /Prev ${t.xrefOffset}${t.info?' /Info '+t.info:''} >>\nstartxref\n${offset}\n%%EOF\n`;return new Uint8Array(Buffer.concat([base,bodyBytes,Buffer.from(xref+trailer)]));}

test('directory add, repeated revision, deletion preserve original source identity',async()=>{const f=await fixture();const one=await append(f.bytes,d=>addOutline(d));const first=await verifyOutlineUpdate({bytes:one,source:f.source});assert.equal(first.status,'VERIFIED');assert.equal(first.beforeHash,f.source.sourceHash);const two=await append(one,d=>addOutline(d,'Revised'));const proof=await verifyOutlineUpdate({bytes:two,source:f.source});assert.equal(proof.revisions.length,2);const three=await append(two,d=>d.catalog.delete(K('Outlines')));assert.equal((await verifyOutlineUpdate({bytes:three,source:f.source})).revisions.length,3);});

for(const [name,mutate] of [
 ['page rotation',d=>{addOutline(d);d.getPages()[0].node.set(K('Rotate'),PDFNumber.of(90));}],
 ['page content',d=>{addOutline(d);d.getPages()[0].node.set(K('Contents'),d.context.register(d.context.stream('q 1 0 0 1 0 0 cm Q')));}],
 ['page resource',d=>{addOutline(d);d.getPages()[0].node.set(K('Resources'),d.context.obj({ProcSet:['PDF']}));}],
 ['page order',d=>{addOutline(d);const kids=d.catalog.Pages().Kids();const first=kids.get(0);kids.set(0,kids.get(1));kids.set(1,first);}],
 ['annotation',d=>{addOutline(d);d.getPages()[0].node.set(K('Annots'),d.context.obj([d.context.register(d.context.obj({Type:'Annot',Subtype:'Text',Rect:[0,0,10,10]}))]));}],
 ['form',d=>{addOutline(d);d.catalog.set(K('AcroForm'),d.context.register(d.context.obj({Fields:[]})));}],
 ['metadata',d=>{addOutline(d);d.setTitle('Changed source');}],
 ['executable outline',d=>{const {item}=addOutline(d);const o=d.context.lookup(item);o.delete(K('Dest'));o.set(K('A'),d.context.obj({S:'JavaScript',JS:PDFString.of('alert(1)')}));}],
 ['outline target not a page',d=>{const {item}=addOutline(d);d.context.lookup(item).set(K('Dest'),d.context.obj([d.context.trailerInfo.Info,'Fit']));}],
 ['catalog action',d=>{addOutline(d);d.catalog.set(K('OpenAction'),d.context.obj({S:'JavaScript',JS:PDFString.of('1')}));}],
 ['outline sharing protected dictionary',d=>{const {root}=addOutline(d);d.getPages()[0].node.set(K('Resources'),root);}],
])test(`rejects ${name}`,async()=>{const f=await fixture();const b=await append(f.bytes,mutate);await assert.rejects(verifyOutlineUpdate({bytes:b,source:f.source}));});

test('xref free entries and redirected offsets cannot hide page deletion',async()=>{const f=await fixture();const d=await PDFDocument.load(f.bytes,{updateMetadata:false});const page=d.getPages()[0].ref;const b=rawRevision(f.bytes,[{num:page.objectNumber,type:'f',gen:1,offset:0}]);await assert.rejects(verifyOutlineUpdate({bytes:b,source:f.source}),/referenced object|deleted/);const bad=rawRevision(f.bytes,[{num:page.objectNumber,offset:1}]);await assert.rejects(verifyOutlineUpdate({bytes:bad,source:f.source}));});

test('rejects replacement, truncated update, wrong prefix/hash and over-limit input',async()=>{const f=await fixture();const b=await append(f.bytes,d=>addOutline(d));await assert.rejects(verifyOutlineUpdate({bytes:b.subarray(0,b.length-12),source:f.source}));await assert.rejects(verifyOutlineUpdate({bytes:b,source:{...f.source,sourceHash:'sha256-v1:'+'0'.repeat(64)}}));await assert.rejects(verifyOutlineUpdate({bytes:b,source:f.source,expectedAfterHash:'sha256-v1:'+'0'.repeat(64)}));await assert.rejects(verifyOutlineUpdate({bytes:new Uint8Array(1),source:f.source}));await assert.rejects(verifyOutlineUpdate({bytes:new Uint8Array(f.source.size+LIMITS.appendBytes+1),source:f.source}),/limit/);});

test('original signed and unknown directory structures remain blocked',async()=>{const f=await fixture();const signed=await append(f.bytes,d=>{d.catalog.set(K('Perms'),d.context.obj({DocMDP:d.context.register(d.context.obj({Type:'Sig',ByteRange:[0,10,20,30]}))}));});const source=await sourceOf(signed),next=await append(signed,d=>addOutline(d));await assert.rejects(verifyOutlineUpdate({bytes:next,source}),/Signed/);});

test('xref bookkeeping cannot replace a protected page object',async()=>{const f=await fixture(),d=await PDFDocument.load(f.bytes,{updateMetadata:false}),t=readSourceTrailer(f.bytes),page=d.getPages()[0].ref;const offset=f.bytes.length+1;const row=Buffer.alloc(7);row[0]=1;row.writeUInt32BE(offset,1);const header=`\n${page.objectNumber} 0 obj\n<< /Type /XRef /Root ${t.root} /Prev ${t.xrefOffset} /Size ${t.declaredSize} /W [1 4 2] /Index [${page.objectNumber} 1] /Length 7 >>\nstream\n`;const b=new Uint8Array(Buffer.concat([f.bytes,Buffer.from(header),row,Buffer.from(`\nendstream\nendobj\nstartxref\n${offset}\n%%EOF\n`)]));await assert.rejects(verifyOutlineUpdate({bytes:b,source:f.source}),/xref|protected|Protected/);});

test('verified proof cache still hashes the entire new file and never trusts returned objects',async()=>{const f=await fixture(),b=await append(f.bytes,d=>addOutline(d,'cache isolation'));const first=await verifyOutlineUpdate({bytes:b,source:f.source});assert.equal(first.cacheHit,false);first.status='FAKE';first.revisions[0].outlineObjects=999;const cached=await verifyOutlineUpdate({bytes:b,source:f.source});assert.equal(cached.status,'VERIFIED');assert.equal(cached.cacheHit,true);assert.notEqual(cached.revisions[0].outlineObjects,999);const bad=b.slice();bad[0]=0;await assert.rejects(verifyOutlineUpdate({bytes:bad,source:f.source}));});
