import assert from "node:assert/strict";
import { nativeConfig, nativeEvalJson, assertNativeVaultIdentity } from "./native-config.mjs";

const identity = nativeEvalJson(`JSON.stringify({vault:app.vault.adapter.basePath,
  configDir:app.vault.configDir})`);
assertNativeVaultIdentity(identity, nativeConfig);

const report = nativeEvalJson(`(async()=>{
  const adapter=app.vault.adapter;
  const dir="00_Archive/20_PDFData/wal/native-probe-20261016";
  const path=dir+"/append-probe-20261016-02.jsonl";
  if(await adapter.exists(path))throw new Error("Probe path already exists");
  if(!(await adapter.exists(dir)))await adapter.mkdir(dir);
  await adapter.write(path,"");
  const buckets=[];
  for(let group=0;group<10;group++){
    const samples=[];
    for(let offset=0;offset<100;offset++){
      const index=group*100+offset;
      const line=JSON.stringify({index,payload:"x".repeat(768)})+"\\n";
      const started=performance.now();
      await adapter.append(path,line);
      samples.push(performance.now()-started);
    }
    const sorted=samples.sort((a,b)=>a-b);
    buckets.push({ops:(group+1)*100,p50:sorted[49],p90:sorted[89],p99:sorted[98],max:sorted[99]});
  }
  const info=await adapter.stat(path);
  return JSON.stringify({path,bytes:info.size,buckets});
})()`, 120_000);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
