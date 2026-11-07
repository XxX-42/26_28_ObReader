import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {wrapApp}=require('../plugin/mobile-learning-storage.cjs');
test('mobile learning adapter reads compressed records and refuses mutations', async()=>{
 const data=Buffer.from(JSON.stringify({path:'00_Archive/5_VocabularyData/history/a.json',text:'original'})+'\n');
 const bytes=gzipSync(data); let writes=0;
 const adapter={async stat(){return {type:'file',size:bytes.length,mtime:1}},async readBinary(){return bytes},async write(){writes++}};
 const a=wrapApp({vault:{adapter}}).vault.adapter;
 assert.equal(await a.read('00_Archive/5_VocabularyData/history/a.json'),'original');
 assert.deepEqual(await a.list('00_Archive/5_VocabularyData/history'),{files:['00_Archive/5_VocabularyData/history/a.json'],folders:[]});
 await assert.rejects(a.write('00_Archive/5_VocabularyData/history/a.json','replacement'),/只读/);
 assert.equal(writes,0);
});
test('mobile learning adapter fails closed for a missing compressed store',async()=>{
 const a=wrapApp({vault:{adapter:{async stat(){return null}}}}).vault.adapter;
 await assert.rejects(a.exists('00_Archive/5_VocabularyData/review/x'),/不会创建空记录/);
});
