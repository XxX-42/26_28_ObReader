import assert from "node:assert/strict";
import { nativeConfig, nativeEvalJson, assertNativeVaultIdentity } from "./native-config.mjs";

const identity = nativeEvalJson(`JSON.stringify({vault:app.vault.adapter.basePath,
  configDir:app.vault.configDir,
  protocol:app.plugins.plugins["pdf-web-reader"]?.annotationHost?.store?.sourceProtocol,
  path:app.workspace.activeLeaf?.view?.file?.path})`);
assertNativeVaultIdentity(identity, nativeConfig);
assert.equal(identity.protocol, "wal-sidecar-v3.2-jsonl");
assert.equal(identity.path, "PDF迁移测试/wal-v32-native-20261016-01.pdf");

const report = nativeEvalJson(`(async()=>{
  const adapter=app.vault.adapter;
  const descriptor=Object.getOwnPropertyDescriptor(adapter,"append");
  const original=adapter.append;
  const host=app.plugins.plugins["pdf-web-reader"].annotationHost;
  const document=app.workspace.activeLeaf.view.annotationDocument;
  const appendMs=[];
  const totalMs=[];
  const run="wal-v32-native-probe-20261016-01";
  adapter.append=async function(path,content){
    const started=performance.now();
    try{return await original.call(adapter,path,content)}
    finally{if(path.includes(document.docKey)&&path.endsWith(".jsonl"))appendMs.push(performance.now()-started)}
  };
  try{
    for(let index=0;index<200;index++){
      const uuid=run+"-"+index;
      const started=performance.now();
      await host.store.appendOperations({document,sourceHash:document.source.sourceHash,
        operations:[{uuid,kind:"Square",pageIndex:index%357,deleted:false,
          payload:{editor:{annotationType:5,rect:[100,100,200,200]}},
          clock:{timestamp:Date.now(),logical:index,deviceId:"native-probe",opId:uuid}}]});
      totalMs.push(performance.now()-started);
    }
  }finally{
    if(descriptor)Object.defineProperty(adapter,"append",descriptor);
    else delete adapter.append;
  }
  const summarize=(values)=>{const sorted=[...values].sort((a,b)=>a-b);
    return {count:values.length,p50:sorted[Math.ceil(.5*sorted.length)-1],
      p90:sorted[Math.ceil(.9*sorted.length)-1],p99:sorted[Math.ceil(.99*sorted.length)-1],
      max:sorted.at(-1),mean:values.reduce((a,b)=>a+b,0)/values.length}};
  return JSON.stringify({total:summarize(totalMs),adapterAppend:summarize(appendMs),
    combinedNonAppendMeanMs:(totalMs.reduce((a,b)=>a+b,0)-appendMs.reduce((a,b)=>a+b,0))/totalMs.length});
})()`, 90_000);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
