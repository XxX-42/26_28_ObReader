import assert from 'node:assert/strict';import test from 'node:test';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../viewer-adapter/obsidian-bridge.js',import.meta.url),'utf8');
const part=source.slice(source.indexOf('  function annotationSentenceMarkdown('),source.indexOf('  function buildAnnotationSidebarViewModels('));
const render=new Function(`${part};return annotationSentenceMarkdown`)();
test('copy text preserves distinct highlight and rectangle colors and escapes HTML',()=>{
 const item={targetText:'文字',targetTextSource:'stored',sentenceChars:[{character:'原',owner:null},{character:'<',owner:0},{character:'&',owner:0},{character:'框',owner:1}],sentenceStyles:[{kind:'Highlight',color:'rgb(254, 240, 138)'},{kind:'Square',color:'#ff0000'}]};
 assert.equal(render(item),'原<mark style="background-color: rgb(254, 240, 138);">&lt;&amp;</mark><span style="border: 2px solid #ff0000; padding: 0px 1.2px;">框</span>');
});
test('copy rejects unavailable text and unsafe color',()=>{assert.equal(render({targetTextSource:'unavailable'}),'');assert.equal(render({targetText:'x',sentenceChars:[{character:'x',owner:0}],sentenceStyles:[{kind:'Square',color:'red; display:none'}]}),'<span style="border: 2px solid #d33b30; padding: 0px 1.2px;">x</span>')});
test('copies recovered sentence even if the original rectangle has no stored target text',()=>{
 const item={targetText:null,targetTextSource:'unavailable',displayText:'一般而言，出现前',sentenceChars:[{character:'一',owner:null},{character:'般',owner:null},{character:'出',owner:0},{character:'现',owner:0}],sentenceStyles:[{kind:'Square',color:'#f00'}]};
 assert.equal(render(item),'一般<span style="border: 2px solid #f00; padding: 0px 1.2px;">出现</span>');
});

test('card default template preserves annotated HTML and links to the annotation',async()=>{
 const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);const {formatSelectionCopy}=require('../plugin/selection-copy-format.cjs');
 const text='<mark style="background-color: #fef08a;">原文</mark>';
 const context={path:'书.pdf',page:30,text,linktext:'书.pdf#page=30&obreader=ann.uuid'};
 assert.equal(formatSelectionCopy(context,{selectionCopyTemplate:'{{text}}[[{{link}}|p{{page}}]]'}),`${text}[[书.pdf#page=30&obreader=ann.uuid|p30]]`);
 assert.equal(formatSelectionCopy(context,{selectionCopyTemplate:'{{link}} / {{text}}'}),`书.pdf#page=30&obreader=ann.uuid / ${text}`);
});

test('drag uses prepared markdown only for the current exact sentence and copies rather than moves',async()=>{
 const source=await readFile(new URL('../viewer-adapter/obsidian-bridge.js',import.meta.url),'utf8');
 const start=source.indexOf('    function onListDragStart('),end=source.indexOf('\n    function onListContextMenu(',start);
 const code=source.slice(start,end),item={uuid:'u1',pageIndex:2,displayText:'原文',targetText:'原文'};
 const prepare=new Map([['u1',{pageIndex:2,sourceText:'original',output:'原文[[书.pdf#page=3|p3]]'}]]);
 const fn=new Function('visibleItems','dragPrepared','annotationSentenceMarkdown','showStatus',`${code};return onListDragStart`)([item],prepare,()=> 'original',()=>{});
 const sent={},dataTransfer={setData:(type,value)=>sent[type]=value};let blocked=false;
 fn({target:{closest:()=>({dataset:{uuid:'u1'}})},dataTransfer,preventDefault:()=>{blocked=true}});
 assert.equal(blocked,false);assert.equal(sent['text/plain'],'原文[[书.pdf#page=3|p3]]');assert.equal(dataTransfer.effectAllowed,'copy');
 item.pageIndex=3;fn({target:{closest:()=>({dataset:{uuid:'u1'}})},dataTransfer,preventDefault:()=>{blocked=true}});assert.equal(blocked,true);
});
