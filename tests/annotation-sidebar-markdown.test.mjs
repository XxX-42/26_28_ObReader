import assert from 'node:assert/strict';import test from 'node:test';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../viewer-adapter/obsidian-bridge.js',import.meta.url),'utf8');
const part=source.slice(source.indexOf('  function annotationSentenceMarkdown('),source.indexOf('  function buildAnnotationSidebarViewModels('));
const render=new Function(`${part};return annotationSentenceMarkdown`)();
test('copy text preserves distinct highlight and rectangle colors and escapes HTML',()=>{
 const item={targetText:'文字',targetTextSource:'stored',sentenceChars:[{character:'原',owner:null},{character:'<',owner:0},{character:'&',owner:0},{character:'框',owner:1}],sentenceStyles:[{kind:'Highlight',color:'rgb(254, 240, 138)'},{kind:'Square',color:'#ff0000'}]};
 assert.equal(render(item),'原<mark style="background-color: rgb(254, 240, 138);">&lt;&amp;</mark><span style="border: 2px solid #ff0000; padding: 0px 1.2px;">框</span>');
});
test('copy rejects unavailable text and unsafe color',()=>{assert.equal(render({targetTextSource:'unavailable'}),'');assert.equal(render({targetText:'x',sentenceChars:[{character:'x',owner:0}],sentenceStyles:[{kind:'Square',color:'red; display:none'}]}),'<span style="border: 2px solid #d33b30; padding: 0px 1.2px;">x</span>')});
