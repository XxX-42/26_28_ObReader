import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import puppeteer from 'puppeteer-core';
const root='D:/Documents/Codes/2026_7_PdfWebReader/windows-native-014-evidence';
const profile=root+'/owned-profile-20261023-1546';
const vault='D:/Documents/Obsidian/测试插件';
const pid=Number(process.env.NATIVE_OWNED_PID);
const runId=process.env.NATIVE_WINDOWS_RUN_ID||'windows-native-014-20261023-1433';
assert.match(runId,/^windows-native-014-20261023-(1433|1515)$/);
assert.ok(Number.isSafeInteger(pid)&&pid>0);
const command=execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],{encoding:'utf8'}).trim();
assert.ok(command.replaceAll('\\','/').includes('--user-data-dir='+profile));
assert.ok(command.includes('--remote-debugging-port=0')&&!command.includes('--type='));
const marker=JSON.parse(await readFile(profile+'/.codex-native-profile.json','utf8'));
assert.equal(marker.allowedVault.replaceAll('\\','/'),vault);
const [port]=String(await readFile(profile+'/DevToolsActivePort')).trim().split(/\r?\n/);
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port});
try{
const matches=[];
for(const page of await browser.pages()){
  if(page.url()!=='app://obsidian.md/index.html')continue;
  const identity=await page.evaluate(()=>({vault:window.app?.vault?.adapter?.basePath,pid:process.pid,title:document.title}));
  if(identity.vault?.replaceAll('\\','/')===vault)matches.push({page,identity});
  else if(identity.vault)throw Error('Owned profile opened an unexpected Vault');
}
assert.equal(matches.length,1);
const {page,identity}=matches[0];
const mode=process.argv[2]||'identity';
let result;
if(mode==='install'){
  const source=await readFile(root+(runId.endsWith('1515')?'/isolation-installer-1515.js':'/isolation-installer.js'),'utf8');
  result=await page.evaluate(source=>{if(app.plugins.plugins['pdf-web-reader'])throw Error('Plugin initialized before isolation');return new Function(source)()},source);
}else if(mode==='enable'){
  result=await page.evaluate(async runId=>{if(window.__nativeLearningLoopIsolation?.runId!==runId)throw Error('Missing isolation');await app.plugins.enablePluginAndSave('pdf-web-reader');return app.plugins.plugins['pdf-web-reader']?.manifest.version},runId);
}else if(mode==='disable'){
  result=await page.evaluate(async()=>{for(const l of app.workspace.getLeavesOfType('pdf-web-reader-view'))await l.detach();await app.plugins.disablePluginAndSave('pdf-web-reader');return !app.plugins.plugins['pdf-web-reader']});
}else if(mode==='workbench'){
  result=await page.evaluate(()=>app.commands.executeCommandById('pdf-web-reader:manage-local-english-vocabulary'));
}else if(mode==='release-isolation'){
  result=await page.evaluate(()=>{if(app.plugins.plugins['pdf-web-reader'])throw Error('Plugin must be unloaded');window.__nativeLearningLoopIsolation?.restore();return !window.__nativeLearningLoopIsolation;});
}else if(mode==='source-probe'){
  result=await page.evaluate(()=>{const h=app.plugins.plugins['pdf-web-reader'];if(window.__nativeBacklinkProbeInstalled)throw Error('Already installed');const original=h.openReaderBacklinkSource;window.__nativeBacklinkProbeInstalled=true;h.openReaderBacklinkSource=async function(...args){const result=await original.apply(this,args);const view=app.workspace.activeLeaf?.view;window.__nativeSourceEvidence={result,args,selection:view?.editor?.getSelection(),from:view?.editor?.getCursor('from'),to:view?.editor?.getCursor('to'),path:view?.file?.path};return result;};return true;});
}else if(mode==='source-evidence'){
  result=await page.evaluate(()=>window.__nativeSourceEvidence);
}else{
  assert.equal(mode,'identity');
  result=await page.evaluate(()=>{const v=app.workspace.getLeavesOfType('pdf-web-reader-view')[0]?.view;return {registry:app.plugins.manifests['pdf-web-reader']?.version,enabled:app.plugins.enabledPlugins.has('pdf-web-reader'),loaded:!!app.plugins.plugins['pdf-web-reader'],isolation:window.__nativeLearningLoopIsolation?.runId,trustPrompt:document.body.innerText.includes('你是否信任这个仓库的作者'),last:v?.lastReaderNavigationResult,documentId:v?.documentId,openRequest:v?.openRequest,rendererGeneration:v?.rendererGeneration,snapshot:v?.annotationSnapshot}});
}
const report={pid,command,profile,port,identity,mode,result,at:new Date().toISOString()};
await writeFile(root+`/owned-${pid}-${mode}.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
}finally{await browser.disconnect();}
