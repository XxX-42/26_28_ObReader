import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import xxhash from 'xxhash-wasm';
import { readNativeSidecarTree } from './native-sidecar-isolation.mjs';
import { readNativeWalEvidence } from './native-wal-evidence.mjs';
const vault='D:/Documents/Obsidian/测试插件';
const evidence='D:/Documents/Codes/2026_7_PdfWebReader/windows-native-014-evidence';
const stage=process.argv[2];
const runId=process.env.NATIVE_WINDOWS_RUN_ID||'windows-native-014-20261023-1433';
assert.match(runId,/^windows-native-014-20261023-(1433|1515)$/);
assert.match(stage,/^[a-z0-9-]+$/);
const expression=`(()=>{if(app.vault.adapter.basePath.replaceAll('\\\\','/')!==${JSON.stringify(vault)})throw Error('vault mismatch');const v=app.workspace.getLeavesOfType('pdf-web-reader-view')[0]?.view;return JSON.stringify({version:app.plugins.plugins['pdf-web-reader']?.manifest.version,isolation:window.__nativeLearningLoopIsolation?.runId,calls:window.__nativeLearningLoopIsolation?.calls,sourceEvidence:window.__nativeSourceEvidence,last:v?.lastReaderNavigationResult,documentId:v?.documentId,openRequest:v?.openRequest,rendererGeneration:v?.rendererGeneration,current:v?.currentRevision,confirmed:v?.confirmedRevision,snapshot:v?.annotationSnapshot,selection:v?.iframe?.contentWindow?.getSelection().toString()})})()`;
const raw=execFileSync('D:/Applications/Obsidian/Obsidian.com',['vault=测试插件','eval',`code=${expression}`],{encoding:'utf8',maxBuffer:128*1024*1024});
const runtime=JSON.parse(raw.slice(raw.indexOf('=> ')+3).trim());
assert.equal(runtime.version,'0.14.0');
assert.equal(runtime.isolation,runId);
if(runtime.last){
  assert.equal(runtime.last.documentId,runtime.documentId);
  assert.equal(runtime.last.openRequest,runtime.openRequest);
  assert.equal(runtime.last.rendererGeneration,runtime.rendererGeneration);
  assert.equal(runtime.last.ok,true);
}
if(stage==='latest-old-context-source'){
  assert.equal(runtime.last.requestId,'reader-nav-1-2');
  assert.equal(runtime.last.targetId,'context-d11edd6f2dbe2e5f5b58467646eaade71ae320c90d7b544c566b9e8e623c67a9');
}
if(stage.startsWith('queued-')&&runtime.sourceEvidence){
  assert.equal(runtime.sourceEvidence.result,true);
  assert.equal(runtime.sourceEvidence.selection,'Windows Native queued Markdown routes preserve this exact source.');
  assert.deepEqual(runtime.sourceEvidence.from,{line:0,ch:0});
  assert.deepEqual(runtime.sourceEvidence.to,{line:0,ch:65});
}
const hashes=[];
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())await walk(p);else{const bytes=await readFile(p);hashes.push({path:p,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}}}
await walk(vault+'/.obsidian/plugins/pdf-web-reader/.native-learning-loop/'+runId);
const baseline=JSON.parse(await readFile(evidence+'/two-ui-chains.json','utf8'));
const snapshot=baseline.runtime.snapshot;
const isolatedRoot=vault+'/.obsidian/plugins/pdf-web-reader/.native-learning-loop/windows-native-014-20261023-1433/PDFData';
const files=await readNativeSidecarTree(isolatedRoot);
const {h64Raw}=await xxhash();
const replay=await readNativeWalEvidence({files,isolatedRoot,virtualRoot:'00_Archive/20_PDFData',docKey:snapshot.docKey,documentId:snapshot.documentId,sourceHash:snapshot.source.sourceHash,viewerRevision:baseline.runtime.current,confirmedViewerRevision:baseline.runtime.confirmed,hash:bytes=>`xxh64-v1:${h64Raw(bytes).toString(16).padStart(16,'0')}`});
assert.equal(replay.annotations.length,1);
assert.equal(replay.annotations[0].uuid,'a2d1ef04-6750-4d3a-97a4-c67a0ed0b148');
await mkdir(evidence,{recursive:true});
await writeFile(evidence+'/'+stage+'.json',JSON.stringify({stage,runtime,hashes,replay},null,2));
console.log(JSON.stringify({stage,files:hashes.length,last:runtime.last}));
