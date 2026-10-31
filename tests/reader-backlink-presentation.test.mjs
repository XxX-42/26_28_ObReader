import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../viewer-adapter/obsidian-bridge.js',import.meta.url),'utf8');
function harness(){
  const timers=new Map(),highlights=new Map(),state={};let id=0;
  const ctx={state,window:{Highlight:class{constructor(range){this.range=range}},CSS:{highlights}},
    setTimeout(fn,ms){const key=++id;timers.set(key,{fn,ms});return key},clearTimeout(key){timers.delete(key)}};
  for(const name of ['clearTemporaryReaderAnchorFocus','showTemporaryReaderAnchorFocus']){
    const a=source.indexOf('  function '+name+'('),b=source.indexOf('\n  function ',a+1);
    vm.runInNewContext(source.slice(a,b),ctx);
  }
  return{...ctx,timers,highlights};
}
test('exact selection focus blinks for three seconds and releases its timer and range',()=>{
  const h=harness();const page={};const range={cloneRange(){return this}};
  assert.equal(h.showTemporaryReaderAnchorFocus(page,range),true);
  let elapsed=0;
  for(let step=1;step<=6;step++){
    const [key,timer]=h.timers.entries().next().value;
    assert.equal(timer.ms,500);elapsed+=timer.ms;h.timers.delete(key);timer.fn();
    assert.equal(h.highlights.has('pdfReaderAnchorFocusText'),step<6&&step%2===0);
  }
  assert.equal(elapsed,3000);assert.equal(h.timers.size,0);assert.equal(h.state.readerAnchorFocusTimer,null);
  h.showTemporaryReaderAnchorFocus(page,range);h.clearTemporaryReaderAnchorFocus();
  assert.equal(h.timers.size,0);assert.equal(h.highlights.size,0);
});
test('temporary focus never mutates or resurrects persistent reference presentation',()=>{
  const h=harness(),range={compareBoundaryPoints(){return 0},cloneRange(){return this},startContainer:{isConnected:true}};
  const reference=new Set([range]);h.highlights.set('pdfReaderMarkdownBacklinks',reference);
  h.showTemporaryReaderAnchorFocus({},range);
  assert.equal(reference.size,1,'temporary focus does not own persistent annotation state');
  h.clearTemporaryReaderAnchorFocus();assert.equal(reference.size,1);
  h.showTemporaryReaderAnchorFocus({},range);
  const replacement=new Set();h.highlights.set('pdfReaderMarkdownBacklinks',replacement);
  h.clearTemporaryReaderAnchorFocus();assert.equal(replacement.size,0,'deleted or refreshed results remain authoritative');
});
