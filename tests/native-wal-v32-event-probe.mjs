import assert from "node:assert/strict";
import { nativeConfig, nativeEvalJson, assertNativeVaultIdentity } from "./native-config.mjs";

const identity = nativeEvalJson(`JSON.stringify({vault:app.vault.adapter.basePath,
  configDir:app.vault.configDir,path:app.workspace.activeLeaf?.view?.file?.path})`);
assertNativeVaultIdentity(identity, nativeConfig);
assert.equal(identity.path, "PDF迁移测试/wal-v32-native-20261016-01.pdf");

const result = nativeEvalJson(`(async()=>{
  const host=app.plugins.plugins["pdf-web-reader"].annotationHost;
  const document=app.workspace.activeLeaf.view.annotationDocument;
  const wal=host.store.pathsFor(document).jsonlWal;
  const original=host.handleSidecarChange;
  let suppressedOwnEvents=0;
  host.handleSidecarChange=async function(file){
    if(file?.path===wal){suppressedOwnEvents++;return true}
    return original.call(host,file);
  };
  const samples=[];
  try{
    for(let index=0;index<200;index++){
      const uuid="wal-v32-event-probe-20261016-01-"+index;
      const started=performance.now();
      await host.store.appendOperations({document,sourceHash:document.source.sourceHash,
        operations:[{uuid,kind:"Square",pageIndex:index%357,deleted:false,
          payload:{editor:{annotationType:5,rect:[100,100,200,200]}},
          clock:{timestamp:Date.now(),logical:index,deviceId:"native-event-probe",opId:uuid}}]});
      samples.push(performance.now()-started);
    }
  }finally{
    host.handleSidecarChange=original;
    await original.call(host,{path:wal});
  }
  const sorted=samples.sort((a,b)=>a-b);
  return JSON.stringify({count:samples.length,suppressedOwnEvents,p50:sorted[99],p90:sorted[179],
    p99:sorted[197],max:sorted[199]});
})()`, 90_000);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
