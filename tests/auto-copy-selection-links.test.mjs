import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const s=readFileSync(new URL('../plugin/main.js',import.meta.url),'utf8');
const a=s.indexOf('  async copySelectionLinks('),b=s.indexOf('\n  async handleReaderAnchorCapture(',a);
const copy=vm.runInNewContext('({'+s.slice(a,b)+'}).copySelectionLinks',{makeToken:(()=>{let i=0;return()=>String(++i)})()});
function setup(){const clipboard=[];const view={autoCopySelectionSequence:1,pendingReaderAnchorCaptures:new Map(),isCurrentReaderAnchorIdentity:()=>true};const host={settings:{},async handleReaderAnchorCapture(v,m){v.pendingReaderAnchorCaptures.get(m.requestId).collectLink('link'+m.capture.pageIndex);v.pendingReaderAnchorCaptures.delete(m.requestId)},async copyReaderText(t){clipboard.push(t)}};const message={sequence:1,captures:[{kind:'selection',pageIndex:0},{kind:'selection',pageIndex:1}]};return{clipboard,view,host,message}}
test('batch copies all per-page links once',async()=>{const h=setup();await copy.call(h.host,h.view,h.message);assert.deepEqual(h.clipboard,['link0\nlink1'])});
test('failed page and superseded selection preserve clipboard',async()=>{const h=setup();h.host.handleReaderAnchorCapture=async()=>{};await copy.call(h.host,h.view,h.message);assert.deepEqual(h.clipboard,[]);h.view.autoCopySelectionSequence=2;await copy.call(h.host,h.view,h.message);assert.deepEqual(h.clipboard,[])});
test('missing middle page is rejected',async()=>{const h=setup();h.message.captures[1].pageIndex=2;await assert.rejects(copy.call(h.host,h.view,h.message),/不完整/);assert.deepEqual(h.clipboard,[])});
