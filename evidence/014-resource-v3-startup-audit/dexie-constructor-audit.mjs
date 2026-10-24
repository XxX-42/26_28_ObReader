import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import fs from 'node:fs/promises';
const require=createRequire(import.meta.url);
const load=performance.now();
const {VocabularyDictionary}=require('../../plugin/vocabulary/dictionary.cjs');
const moduleRequireMs=performance.now()-load;
const adapter={read(){throw Error('I/O forbidden')},readBinary(){throw Error('I/O forbidden')}};
const samples={defaultDexie:[],injectedStub:[]};
for(let i=0;i<500;i++)for(const kind of ['defaultDexie','injectedStub']){
 const before=performance.now();
 const d=new VocabularyDictionary({adapter,...(kind==='injectedStub'?{cache:{close(){}}}:{})});
 samples[kind].push(performance.now()-before);d.dispose();
}
const stats=a=>{const s=[...a].sort((x,y)=>x-y);return{first:a[0],p50:s[Math.ceil(s.length*.5)-1],p95:s[Math.ceil(s.length*.95)-1],max:s.at(-1)}};
await fs.writeFile(new URL('./dexie-constructor-audit.json',import.meta.url),JSON.stringify({scope:'NON_NATIVE_NODE_SYNC_CONSTRUCTOR_ONLY',node:process.version,moduleRequireMs,results:Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,stats(v)])),samples,limitations:['No Native startup claim','No IndexedDB factory available in Node; no database opened','Default constructs actual Dexie/schema; injected stub provides diagnostic contrast only','Module load includes dependencies, cannot attribute all require time to Dexie']},null,2)+'\n');
