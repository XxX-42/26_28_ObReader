import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import { createRequire } from 'node:module';
const { formatSelectionCopy } = createRequire(import.meta.url)('../plugin/selection-copy-format.cjs');
const s=readFileSync(new URL('../plugin/main.js',import.meta.url),'utf8');
const a=s.indexOf('  async copySelectionLinks('),b=s.indexOf('\n  async handleReaderAnchorCapture(',a);
const copy=vm.runInNewContext('({'+s.slice(a,b)+'}).copySelectionLinks',{formatSelectionCopy,makeToken:(()=>{let i=0;return()=>String(++i)})()});
function setup(){const clipboard=[];const view={autoCopySelectionSequence:1,pendingReaderAnchorCaptures:new Map(),isCurrentReaderAnchorIdentity:()=>true};const host={settings:{},async handleReaderAnchorCapture(v,m){v.pendingReaderAnchorCaptures.get(m.requestId).collectLink('link'+m.capture.pageIndex);v.pendingReaderAnchorCaptures.delete(m.requestId)},async copyReaderText(t){clipboard.push(t)}};const message={sequence:1,captures:[{kind:'selection',pageIndex:0},{kind:'selection',pageIndex:1}]};return{clipboard,view,host,message}}
test('batch copies all per-page links once',async()=>{const h=setup();await copy.call(h.host,h.view,h.message);assert.deepEqual(h.clipboard,['link0\nlink1'])});
test('failed page and superseded selection preserve clipboard',async()=>{const h=setup();h.host.handleReaderAnchorCapture=async()=>{};await copy.call(h.host,h.view,h.message);assert.deepEqual(h.clipboard,[]);h.view.autoCopySelectionSequence=2;await copy.call(h.host,h.view,h.message);assert.deepEqual(h.clipboard,[])});
test('missing middle page is rejected',async()=>{const h=setup();h.message.captures[1].pageIndex=2;await assert.rejects(copy.call(h.host,h.view,h.message),/不完整/);assert.deepEqual(h.clipboard,[])});

const bridge=readFileSync(new URL('../viewer-adapter/obsidian-bridge.js',import.meta.url),'utf8');
function pointerHarness() {
  const state={editorMode:0,autoCopySequence:0,activeDocumentId:'doc',activeOpenRequest:1,
    textSelectionController:{resolveTarget:()=>({})}};
  const timers=[],copies=[];
  const context={state,postToHost(){},cancelManualMomentum(){},invalidatePendingPenHighlight(){},
    dismissToolbarParameterPopups(){},deletePenPolicyPointer(){},runAnnotationObserver(){},finishTrackedPointer(){},
    setDeferredTimeout(fn){timers.push(fn)},autoCopySelectedLinks(){copies.push('copy')}};
  for(const name of ['onBridgePointerDown','onBridgePointerEnd']) {
    const start=bridge.indexOf('  function '+name+'(');
    vm.runInNewContext(bridge.slice(start,bridge.indexOf('\n  function ',start+1)),context);
  }
  const down=(extra={})=>context.onBridgePointerDown({pointerType:'mouse',button:0,targetRole:'text-layer',pointerId:7,...extra},{});
  const end=(extra={})=>context.onBridgePointerEnd({type:'pointerup',pointerId:7,...extra},{});
  return {state,timers,copies,down,end,flush(){while(timers.length)timers.shift()()}};
}
test('native arrow-mode selection copies after routed pointerup without a tracked annotation pointer',()=>{
  const h=pointerHarness();h.down();h.end();assert.equal(h.copies.length,0);h.flush();assert.deepEqual(h.copies,['copy']);
  h.end();h.flush();assert.equal(h.copies.length,1,'duplicate pointerup cannot copy twice');
});
test('cancelled, stale-session, tool, pen and panel gestures cannot auto-copy',()=>{
  for(const extra of [{pointerType:'pen'},{button:2},{targetRole:'ui'}]){
    const h=pointerHarness();h.down(extra);h.end();h.flush();assert.equal(h.copies.length,0);
  }
  const tool=pointerHarness();tool.state.editorMode=15;tool.down();tool.end();tool.flush();assert.equal(tool.copies.length,0);
  const cancel=pointerHarness();cancel.down();cancel.end({type:'pointercancel'});cancel.flush();assert.equal(cancel.copies.length,0);
  const stale=pointerHarness();stale.down();stale.end();stale.state.activeOpenRequest++;stale.flush();assert.equal(stale.copies.length,0);
});
