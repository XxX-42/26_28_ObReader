import assert from 'node:assert/strict';import test from 'node:test';import{readFile}from'node:fs/promises';
const src=await readFile(new URL('../viewer-adapter/obsidian-bridge.js',import.meta.url),'utf8');
const extract=(a,b)=>src.slice(src.indexOf('  function '+a+'('),src.indexOf('\n  function '+b+'('));
test('underline evidence uses stored text and geometry recovery',()=>{
 const code=extract('getAnnotationSidebarTargetTextEvidence','resolveAnnotationSidebarTargetTextEvidence');const state={app:{}};
 const evidence=new Function('state','getLiveAnnotationSidebarTexts','normalizeSyncKind','getLegacyHighlightSidebarTargetText',`${code};return getAnnotationSidebarTargetTextEvidence`)(state,()=>new Map(),x=>x,()=> '恢复文字');
 const rows=new Map([['one',{uuid:'one',kind:'Underline',pageIndex:0,editorPayload:{quadPoints:[1,2,3,4,5,6,7,8]}}],['two',{uuid:'two',kind:'Underline',pageIndex:0,editorPayload:{text:'已保存文字'}}]]);
 assert.deepEqual(evidence(rows).get('one'),{text:'恢复文字',source:'recovered'});assert.deepEqual(evidence(rows).get('two'),{text:'已保存文字',source:'stored'});
});
test('offscreen cached glyphs recover exact text without a live page',()=>{
 const code=extract('recoverHighlightTextFromTextLayer','getLegacyHighlightSidebarTargetText');
 const recover=new Function('annotationSidebarTextGlyphs',`${code};return recoverHighlightTextFromTextLayer`)(()=>{throw Error('live layer should not be needed')});
 const glyphs=[{character:'文',rects:[{left:2,right:12,top:2,bottom:12}]},{character:'字',rects:[{left:12,right:22,top:2,bottom:12}]},{character:'外',rects:[{left:40,right:50,top:2,bottom:12}]}];
 const viewport={width:100,height:100,convertToViewportPoint:(x,y)=>[x,y]},cached={glyphs,bounds:{width:100,height:100}};
 assert.equal(recover(null,null,viewport,[0,0,25,0,0,15,25,15],cached),'文字');
});
