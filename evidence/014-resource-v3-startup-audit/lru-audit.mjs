import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require=createRequire(import.meta.url);
const {VocabularyDictionary}=require('../../plugin/vocabulary/dictionary.cjs');
const root='/private/tmp/obreader-v3-generated-with-license';
const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
if(manifest.blocks.length!==67) throw Error('Expected 67 blocks');
const workloads=[
 {name:'resident-six',indexes:Array.from({length:24},(_,i)=>i%6)},
 {name:'cyclic-twelve',indexes:Array.from({length:36},(_,i)=>i%12)},
 {name:'cyclic-twentyfour',indexes:Array.from({length:72},(_,i)=>i%24)},
 {name:'full-scan-twice',indexes:Array.from({length:134},(_,i)=>i%67)},
];
const trace=workloads.map(w=>({...w,keys:w.indexes.map(i=>manifest.blocks[i].firstKey)}));
const results=[];
const quant=(a,p)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1];
for(const maxBytes of [8*1024*1024,128*1024*1024]) for(const w of trace) for(const cap of [8,16,32]){
 let reads=0,bytesRead=0,decodes=0,hits=0,misses=0,peakBytes=0,peakBlocks=0;
 const adapter={read:p=>fs.readFile(p,'utf8'),readBinary:async p=>{const b=await fs.readFile(p);reads++;bytesRead+=b.length;return b;}};
 const before=performance.now();
 const d=new VocabularyDictionary({adapter,root,WorkerClass:null,blockCacheMaxBlocks:cap,blockCacheMaxBytes:maxBytes});
 const constructorMs=performance.now()-before;
 const orig=d.getCachedBlock.bind(d);d.getCachedBlock=k=>{const r=orig(k);r?hits++:misses++;return r;};
 const decode=d.decodeBlock.bind(d);d.decodeBlock=(...a)=>{decodes++;return decode(...a);};
 const remember=d.rememberBlock.bind(d);d.rememberBlock=(...a)=>{const r=remember(...a);const s=d.getBlockCacheStats();peakBytes=Math.max(peakBytes,s.estimatedBytes);peakBlocks=Math.max(peakBlocks,s.blocks);return r;};
 const lat=[];let first;
 try{for(const key of w.keys){const t=performance.now();const entry=await d.lookup(key);if(entry?.key!==key)throw Error('lookup mismatch');lat.push(performance.now()-t);first??=lat[0];}}
 finally{d.dispose();}
 results.push({workload:w.name,cap,maxBytes,lookups:w.keys.length,hits:w.keys.length-reads,misses:reads,rawCacheProbeHits:hits,rawCacheProbeMisses:misses,decodes,reads,bytesRead,peakResidentEstimatedBytes:peakBytes,peakResidentBlocks:peakBlocks,constructorMs,latencyMs:{first,p50:quant(lat,.5),p95:quant(lat,.95),max:Math.max(...lat)},samplesMs:lat});
 console.log(JSON.stringify(results.at(-1),(_,v)=>v===lat?undefined:v));
}
const report={scope:'NON_NATIVE_NODE_REAL_FILESYSTEM_COOPERATIVE_DECODE',createdAt:new Date().toISOString(),resourceRoot:root,manifestSha256:crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),node:process.version,limitations:['No Native app or Vault accessed','Same exact trace for capacities; fresh instance per cell, OS cache retained; single trial, fixed order','8MiB is product budget;128MiB is diagnostic only to expose count-limit sensitivity','Peak is resident runtime estimate, excludes transient decode buffers, entries, Dexie, total heap and RSS','Worker disabled: real integrity/gzip/JSON decode uses product cooperative fallback; latency is not Native/Worker latency','Synthetic range-first keys, not observed user trace; no production capacity acceptance'],trace,results};
await fs.writeFile(new URL('./lru-audit.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
