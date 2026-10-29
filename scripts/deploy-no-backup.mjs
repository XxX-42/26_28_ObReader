import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {copyFile, lstat, readFile, realpath, rename, unlink} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {assertSafeDeploymentPreflight, nativeConfig, nativeEvalJson, nativeIdentityExpression} from '../tests/native-config.mjs';

const releaseFiles=['main.js','manifest.json','styles.css'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

// Replaces only the three requested files. Temporary files contain the new
// release, not a copy of the old installation; no backup is created.
export async function replaceReleaseFiles(source,target,expectedId='pdf-web-reader') {
  const folder=await lstat(target);
  assert.ok(folder.isDirectory()&&!folder.isSymbolicLink(),'Plugin directory must be a real directory');
  const oldManifest=JSON.parse(await readFile(path.join(target,'manifest.json'),'utf8'));
  const manifest=JSON.parse(await readFile(path.join(source,'manifest.json'),'utf8'));
  assert.equal(oldManifest.id,expectedId);assert.equal(manifest.id,expectedId);
  const expected=new Map();
  for(const name of releaseFiles){
    const info=await lstat(path.join(source,name));assert.ok(info.isFile()&&!info.isSymbolicLink());
    const old=await lstat(path.join(target,name));assert.ok(old.isFile()&&!old.isSymbolicLink());
    expected.set(name,digest(await readFile(path.join(source,name))));
  }
  const temps=[];
  try {
    for(const name of releaseFiles){
      const temp=path.join(target,`.v15-release-${randomUUID()}-${name}.tmp`);
      await copyFile(path.join(source,name),temp,constants.COPYFILE_EXCL);temps.push(temp);
      assert.equal(digest(await readFile(temp)),expected.get(name));
    }
    for(let i=0;i<releaseFiles.length;i++){
      await rename(temps[i],path.join(target,releaseFiles[i]));temps[i]=null;
      assert.equal(digest(await readFile(path.join(target,releaseFiles[i]))),expected.get(releaseFiles[i]));
    }
  } finally {for(const temp of temps)if(temp)await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error});}
  return Object.fromEntries(expected);
}

async function main(){
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const source=path.join(root,'dist','pdf-web-reader');
  const vault=path.resolve(nativeConfig.vault), config=path.join(vault,nativeConfig.configDir);
  const target=path.join(config,'plugins',nativeConfig.pluginId);
  assert.equal(await realpath(vault),vault,'Test Vault must not resolve through a symlink');
  const configInfo=await lstat(config);assert.ok(configInfo.isDirectory()&&!configInfo.isSymbolicLink());
  const plugins=path.join(config,'plugins'),pluginsInfo=await lstat(plugins);
  assert.ok(pluginsInfo.isDirectory()&&!pluginsInfo.isSymbolicLink());
  assert.equal(await realpath(target),target,'Plugin path must not resolve through a symlink');
  const preflight=nativeEvalJson(nativeIdentityExpression(`pluginEnabled: app.plugins.enabledPlugins.has(${JSON.stringify(nativeConfig.pluginId)}), readerViews: (() => { const rows=[]; app.workspace.iterateAllLeaves(leaf => { if (leaf.view?.getViewType?.() === 'pdf-web-reader-view') rows.push({path:leaf.view.requestedPath || leaf.view.file?.path || null,saving:!!leaf.view.saving,pending:!!leaf.view.pendingBytes}); }); return rows; })(),`));
  assertSafeDeploymentPreflight(preflight);
  const hashes=await replaceReleaseFiles(source,target,nativeConfig.pluginId);
  console.log(JSON.stringify({vault,target,hashes,backupCreated:false}));
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)await main();
