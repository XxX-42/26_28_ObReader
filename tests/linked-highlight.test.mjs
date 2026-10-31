import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createReaderBacklinkIndex,buildReaderBacklinkPageIndex}=require('../plugin/reader-backlink-index.cjs');
const bridge=readFileSync(new URL('../viewer-adapter/obsidian-bridge.js',import.meta.url),'utf8');
function functions(context){
  const start=bridge.indexOf('  function linkedAnnotationMetadata(');
  const end=bridge.indexOf('  async function applyReaderBacklinkPageResults(',start);
  vm.runInNewContext(bridge.slice(start,end),context);return context;
}
test('native linked Highlight geometry uses PDF viewport coordinates and keeps exact quote and target',()=>{
  const h=functions({state:{app:{pdfViewer:{getPageView:()=>({viewport:{width:600,height:800,
    convertToPdfPoint:(x,y)=>[x,800-y]}})}}},annotationToolColors:{get:()=> '#12abef'},
    pageElementForIndex:()=>({}),textLayerForPage:()=>({getBoundingClientRect:()=>({left:10,top:20,width:600,height:800})})});
  const result=h.linkedHighlightPayload({getClientRects:()=>[{left:110,top:220,right:210,bottom:240,width:100,height:20}]},0,
    {anchorId:'anchor-stable-1',exactQuote:'准确原文'},'书籍/原文.pdf');
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{annotationType:9,pageIndex:0,rotation:0,color:[18,171,239],opacity:1,
    rect:[100,580,200,600],quadPoints:[100,600,200,600,100,580,200,580],text:'准确原文',
    readerLink:{version:1,anchorId:'anchor-stable-1',pdfTarget:'书籍/原文.pdf#page=1&obreader=sel.anchor-stable-1'}});
});

test('incremental source rename preserves all target/range evidence during a missing metadata cache',()=>{
  const index=createReaderBacklinkIndex();
  const original='笔记/原名.md', moved='Archive/新名字.md';
  const cache={links:[{link:'Books/书.pdf#page=8&obreader=sel.anchor-stable-1',original:'[[source]]',displayText:'原文',
    position:{start:{offset:34,line:2},end:{offset:88,line:2}}}]};
  index.replaceFile(original,cache);
  const before=index.getByPdfPath('Books/书.pdf');
  assert.equal(index.renameFile(original,moved),true);
  assert.deepEqual(index.getByPdfPath('Books/书.pdf'),before.map(row=>({...row,sourcePath:moved})));
  assert.equal(index.renameFile(original,moved),false);
  index.replaceFile(moved,cache);
  assert.equal(index.getByPdfPath('Books/书.pdf').length,1);
  index.removeFile(moved);assert.equal(index.getByPdfPath('Books/书.pdf').length,0);
});

test('a compact reference awaiting identity binding during a two-end move cannot authorize highlight deletion',async()=>{
  const index=createReaderBacklinkIndex();
  // Obsidian moved the Markdown first: its newly relative route is temporarily
  // different from the PDF route while the existing asynchronous binding runs.
  index.replaceFile('Moved/Source.md',{links:[{link:'Before.pdf#page=1&obreader=sel.stable-anchor',
    position:{start:{offset:10,line:1},end:{offset:80,line:1}}}]});
  const page=await buildReaderBacklinkPageIndex({index,anchorStore:{get:async()=>{throw Error('not needed')}},
    docKey:'123456abcdef',documentId:'doc',sourcePath:'Books/After.pdf',pageIdentities:['page-one'],
    annotations:[{uuid:'reader-link:stable-anchor',pageIndex:0,payload:{editor:{readerLink:{version:1,anchorId:'stable-anchor'}}}}]});
  assert.ok(page.referencedSelectionIds.includes('stable-anchor'),'reference existence is independent of its temporary PDF route');
});

test('incomplete reference responses cannot delete linked annotations or manual annotations',async()=>{
  let reads=0,writes=0;
  const h=functions({state:{readOnly:false,externalSourceConfirmed:true},isInputBusy:()=>false,
    collectKnownAnnotationDeletionTargets:()=>{reads++;return new Map()},applySidecarBulkDelete:()=>{writes++}});
  await h.reconcileLinkedHighlights({pdfPath:'book.pdf'},[],()=>true);
  assert.equal(reads,0);assert.equal(writes,0);
});

test('last-reference reconciliation deletes only owned highlights across loaded state, never manual marks',async()=>{
  const owned={uuid:'reader-link:a',kind:'Highlight',pageIndex:3,editorPayload:{readerLink:{version:1,anchorId:'a',pdfTarget:'Book.pdf#page=4&obreader=sel.a'}}};
  const manual={uuid:'manual',kind:'Highlight',pageIndex:3,editorPayload:{text:'manual'}};
  const writes=[],saves=[];
  const h=functions({state:{readOnly:false,externalSourceConfirmed:true,activeDocumentId:'doc',activeOpenRequest:1,app:{}},
    isInputBusy:()=>false,collectKnownAnnotationDeletionTargets:()=>new Map([['owned',owned],['manual',manual]]),
    applySidecarBulkDelete:(rows,deleted)=>writes.push({rows,deleted}),noteMutation:()=>{},requestSave:async origin=>saves.push(origin)});
  await h.reconcileLinkedHighlights({pdfPath:'Book.pdf',referencedSelectionIds:['a']},[],()=>true);
  assert.equal(writes.length,0,'another surviving Markdown reference keeps the highlight');
  await h.reconcileLinkedHighlights({pdfPath:'Book.pdf',referencedSelectionIds:[]},[],()=>true);
  assert.equal(writes.length,1);assert.equal(writes[0].deleted,true);
  assert.deepEqual(Array.from(writes[0].rows,row=>row.uuid),['reader-link:a']);
  assert.equal(saves.length,1,'reference cleanup goes through the ordinary durable save');
  await h.reconcileLinkedHighlights({pdfPath:'Book.pdf',referencedSelectionIds:[]},[],()=>false);
  assert.equal(writes.length,1,'stale requests cannot delete saved annotations');
});
