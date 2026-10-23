import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,cp,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import puppeteer from 'puppeteer-core';
const root='D:/Documents/Codes/2026_7_PdfWebReader/windows-native-014-evidence';
const profile=root+'/owned-profile-20261023-1546';
const vault='D:/Documents/Obsidian/测试插件';
const pid=Number(process.env.NATIVE_OWNED_PID);
const runId=process.env.NATIVE_WINDOWS_RUN_ID||'windows-native-014-20261023-1433';
const stage=process.env.NATIVE_STAGE||'continuation';assert.match(stage,/^[a-z0-9-]+$/);
assert.match(runId,/^windows-native-014-20261023-(1433|1515)$/);
assert.ok(Number.isSafeInteger(pid)&&pid>0);
const command=execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],{encoding:'utf8'}).trim();
assert.ok(command.replaceAll('\\','/').includes('--user-data-dir='+profile));
assert.ok(command.includes('--remote-debugging-port=0')&&!command.includes('--type='));
const marker=JSON.parse(await readFile(profile+'/.codex-native-profile.json','utf8'));
assert.equal(marker.allowedVault.replaceAll('\\','/'),vault);
const [port]=String(await readFile(profile+'/DevToolsActivePort')).trim().split(/\r?\n/);
const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});
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
}else if(mode==='close-readers'){
  result=await page.evaluate(async()=>{for(const l of app.workspace.getLeavesOfType('pdf-web-reader-view'))await l.detach();return app.workspace.getLeavesOfType('pdf-web-reader-view').length;});assert.equal(result,0);
}else if(mode==='cleanup-markdown'){
  result=await page.evaluate(async()=>{const prefix='PDF迁移测试/native-learning-loop-windows-014-20261023-1433/';const closed=[];for(const l of app.workspace.getLeavesOfType('markdown')){if(l.view.file?.path?.startsWith(prefix)){closed.push(l.view.file.path);await l.detach();}}await app.workspace.saveLayout?.();return {closed};});
}else if(mode==='transition'){
  const from=process.env.NATIVE_FROM,to=process.env.NATIVE_TO;
  for(const p of [from,to])assert.ok(typeof p==='string'&&p.startsWith('PDF迁移测试/native-learning-loop-windows-014-20261023-1433/')&&!p.includes('..'));
  result=await page.evaluate(async({from,to})=>{const f=app.vault.getAbstractFileByPath(from);if(!f||app.vault.getAbstractFileByPath(to))throw Error('Unsafe transition');const parent=to.slice(0,to.lastIndexOf('/'));if(!app.vault.getAbstractFileByPath(parent))await app.vault.createFolder(parent);await app.fileManager.renameFile(f,to);return {from,to,path:f.path};},{from,to});
}else if(mode==='workbench'){
  result=await page.evaluate(()=>app.commands.executeCommandById('pdf-web-reader:manage-local-english-vocabulary'));
}else if(mode==='release-isolation'){
  result=await page.evaluate(()=>{if(app.plugins.plugins['pdf-web-reader'])throw Error('Plugin must be unloaded');window.__nativeLearningLoopIsolation?.restore();return !window.__nativeLearningLoopIsolation;});
}else if(mode==='source-probe'){
  result=await page.evaluate(()=>{const h=app.plugins.plugins['pdf-web-reader'];if(h.__nativeBacklinkProbeInstalled)throw Error('Already installed');const original=h.openReaderBacklinkSource;h.__nativeBacklinkProbeInstalled=true;h.openReaderBacklinkSource=async function(...args){const result=await original.apply(this,args);const view=app.workspace.activeLeaf?.view;window.__nativeSourceEvidence={result,args,selection:view?.editor?.getSelection(),from:view?.editor?.getCursor('from'),to:view?.editor?.getCursor('to'),path:view?.file?.path};return result;};return true;});
}else if(mode==='source-evidence'){
  result=await page.evaluate(()=>window.__nativeSourceEvidence);
}else if(mode==='inspect-views'){
  result=await page.evaluate(()=>({active:app.workspace.activeLeaf?.view?.file?.path,views:app.workspace.getLeavesOfType('pdf-web-reader-view').map(l=>({path:l.view.file?.path,renderer:l.view.rendererGeneration,iframeConnected:l.view.iframe?.isConnected,url:l.view.iframe?.contentDocument?.URL,badges:[...(l.view.iframe?.contentDocument?.querySelectorAll('[class*="Backlink"]')||[])].map(n=>({tag:n.tagName,cls:n.className,text:n.textContent})),rect:l.view.containerEl.getBoundingClientRect().toJSON()}))}));
}else if(mode==='viewer-evidence'){
  result=await page.evaluate(()=>{const active=app.workspace.activeLeaf?.view;const views=app.workspace.getLeavesOfType('pdf-web-reader-view').map(l=>l.view);const v=active?.getViewType?.()==='pdf-web-reader-view'?active:views.length===1?views[0]:null;if(!v)throw Error('No unambiguous active Reader');const d=v?.iframe?.contentDocument;return {path:v.file?.path||v.requestedPath,last:v?.lastReaderNavigationResult,documentId:v?.documentId,openRequest:v?.openRequest,rendererGeneration:v?.rendererGeneration,rows:[...(d?.querySelectorAll('.sidebarComment')||[])].map(n=>({uuid:n.dataset.uuid,className:n.className,text:n.textContent})),editors:[...(d?.querySelectorAll('.annotationEditorLayer .highlightEditor')||[])].map(n=>({id:n.id,uuid:n.dataset.annotationUuid,className:n.className})),badges:[...(d?.querySelectorAll('.pdfReaderBacklinkPageBadge')||[])].map(n=>({text:n.textContent,hidden:n.hidden}))};});
}else if(mode==='deploy'){
  const safe=await page.evaluate(()=>({loaded:!!app.plugins.plugins['pdf-web-reader'],enabled:app.plugins.enabledPlugins.has('pdf-web-reader'),readers:app.workspace.getLeavesOfType('pdf-web-reader-view').length}));
  assert.deepEqual(safe,{loaded:false,enabled:false,readers:0});
  const target=vault+'/.obsidian/plugins/pdf-web-reader';
  const hashes=async()=>{const rows=[];const walk=async dir=>{for(const e of await readdir(dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())await walk(p);else if(!['main.js','manifest.json','styles.css'].includes(p.slice(target.length+1))){const b=await readFile(p);rows.push([p.slice(target.length+1),createHash('sha256').update(b).digest('hex')]);}}};await walk(target);return rows.sort((a,b)=>a[0].localeCompare(b[0]));};
  const before=await hashes();
  const backup=root+'/owned-deploy-'+new Date().toISOString().replaceAll(':','-');
  await mkdir(backup);await cp(target,backup+'/pdf-web-reader',{recursive:true,errorOnExist:true,force:false});
  const source=fileURLToPath(new URL('../dist/pdf-web-reader/',import.meta.url));
  const assets={};for(const name of ['main.js','manifest.json','styles.css']){await cp(source+name,target+'/'+name);assets[name]=createHash('sha256').update(await readFile(target+'/'+name)).digest('hex');}
  assert.deepEqual(await hashes(),before,'Non-release plugin data changed during deploy');
  result={backup,preservedFiles:before.length,assets};
}else{
  assert.equal(mode,'identity');
  result=await page.evaluate(()=>{const v=app.workspace.getLeavesOfType('pdf-web-reader-view')[0]?.view;return {registry:app.plugins.manifests['pdf-web-reader']?.version,enabled:app.plugins.enabledPlugins.has('pdf-web-reader'),loaded:!!app.plugins.plugins['pdf-web-reader'],isolation:window.__nativeLearningLoopIsolation?.runId,trustPrompt:document.body.innerText.includes('你是否信任这个仓库的作者'),last:v?.lastReaderNavigationResult,documentId:v?.documentId,openRequest:v?.openRequest,rendererGeneration:v?.rendererGeneration,snapshot:v?.annotationSnapshot}});
}
const report={pid,command,profile,port,identity,mode,result,at:new Date().toISOString()};
await writeFile(root+`/owned-${pid}-${mode}.json`,JSON.stringify(report,null,2));
await writeFile(root+`/${stage}-${pid}-${mode}.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
}finally{await browser.disconnect();}
