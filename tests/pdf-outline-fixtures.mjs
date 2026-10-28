import {PDFDocument,PDFName,PDFString} from 'pdf-lib';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createPdfHashRuntime}=require('../plugin/pdf-hash-runtime.cjs');
const {captureIncrementalSnapshot,createIncrementalPatch,materializeIncrementalResult}=require('../plugin/pdf-incremental.cjs');
const runtime=await createPdfHashRuntime();
const K=PDFName.of;
export async function fixture(){const d=await PDFDocument.create();d.addPage([300,400]);d.addPage([300,400]);const outline=d.context.register(d.context.obj({Type:'Outlines',Count:0}));d.catalog.set(K('Outlines'),outline);const bytes=await d.save({useObjectStreams:false});return {bytes,source:await sourceOf(bytes)};}
export async function sourceOf(bytes){const d=await PDFDocument.load(bytes,{updateMetadata:false});return {sourceHash:runtime.fingerprint(bytes),size:bytes.length,pageCount:d.getPageCount(),orderedPageIdentities:d.getPages().map(p=>`ref:${p.ref.objectNumber}R${p.ref.generationNumber||''}`)};}
export async function append(bytes,mutate){const d=await PDFDocument.load(bytes,{updateMetadata:false});const snapshot=captureIncrementalSnapshot({sourceBytes:bytes,document:d});await mutate(d);const patch=createIncrementalPatch({sourceBytes:bytes,document:d,snapshot});return materializeIncrementalResult({sourceBytes:bytes,patch}).bytes;}
export function addOutline(d,title='Chapter'){const c=d.context;const root=c.nextRef(),item=c.nextRef();c.assign(root,c.obj({Type:'Outlines',Count:1,First:item,Last:item}));c.assign(item,c.obj({Title:PDFString.of(title),Parent:root,Dest:[d.getPages()[0].ref,'Fit']}));d.catalog.set(K('Outlines'),root);return {root,item};}
