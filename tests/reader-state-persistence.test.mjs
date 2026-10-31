import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../plugin/main.js',import.meta.url),'utf8');
const start=source.indexOf('function readerStateLocalKey('),end=source.indexOf('\nclass AnnotationDeviceReviewModal',start);
function setup(){
 const files=new Map(),writes=[],messages=[];
 const core={readCurrent:async()=>null,saveReaderState:async value=>writes.push(value)};
 const view={documentFile:{path:'book.pdf'},app:{vault:{getName:()=> 'test'}},plugin:{annotationHost:{store:{core}}},annotationDocument:{documentId:'doc'},documentId:'viewer',openRequest:1,token:'token',postToViewer:m=>messages.push(m)};
 const context=vm.createContext({localAnnotationDeviceId:()=> 'windows',CHANNEL:'pdf-web-reader',localStorage:{getItem:k=>files.get(k),setItem:(k,v)=>files.set(k,v)}});
 vm.runInContext(source.slice(start,end)+'\n globalThis.api={persistReaderState,restoreReaderState};',context);
 return {view,core,writes,messages,files,...context.api};
}
test('unpaired PDF stores state locally then transfers it after pairing',async()=>{
 const h=setup();await h.persistReaderState(h.view,{pageNumber:8,annotationSidebar:{side:'left',width:500}});
 assert.equal(h.files.size,1);assert.equal(h.writes.length,0);
 h.core.readCurrent=async()=>({document:{documentId:'doc'},pairId:'pair',header:{}});
 await h.persistReaderState(h.view,h.view.latestReaderState);
 assert.equal(h.writes.length,1);assert.equal(h.writes[0].deviceId,'windows');assert.equal(h.writes[0].state.annotationSidebar.side,'left');
 await h.restoreReaderState(h.view,1);assert.equal(h.messages.at(-1).state.pageNumber,8);
});
test('source mismatch never writes JSONL and stale open cannot restore state',async()=>{
 const h=setup();h.view.annotationSourceMismatch=true;
 await h.persistReaderState(h.view,{pageNumber:5});assert.equal(h.writes.length,0);
 await h.restoreReaderState(h.view,0);assert.equal(h.messages.length,0);
});
