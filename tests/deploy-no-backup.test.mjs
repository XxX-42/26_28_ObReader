import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {replaceReleaseFiles} from '../scripts/deploy-no-backup.mjs';

test('no-backup deployment replaces only release files and preserves plugin data',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'v15-deploy-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=path.join(root,'release'),target=path.join(root,'plugin');await mkdir(source);await mkdir(target);
 for(const [dir,version] of [[source,'new'],[target,'old']]){
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify({id:'pdf-web-reader',version}));
  await writeFile(path.join(dir,'main.js'),version+' main');await writeFile(path.join(dir,'styles.css'),version+' styles');
 }
 await writeFile(path.join(target,'data.json'),'preserve settings');
 const hashes=await replaceReleaseFiles(source,target);
 assert.equal(await readFile(path.join(target,'main.js'),'utf8'),'new main');
 assert.equal(await readFile(path.join(target,'data.json'),'utf8'),'preserve settings');
 assert.deepEqual((await readdir(target)).sort(),['data.json','main.js','manifest.json','styles.css']);
 assert.deepEqual(Object.keys(hashes).sort(),['main.js','manifest.json','styles.css']);
 assert.deepEqual((await readdir(root)).sort(),['plugin','release']);
});

test('no-backup deployment refuses an unrelated plugin before replacing files',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'v15-deploy-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=path.join(root,'release'),target=path.join(root,'plugin');await mkdir(source);await mkdir(target);
 await writeFile(path.join(source,'manifest.json'),JSON.stringify({id:'pdf-web-reader'}));
 await writeFile(path.join(target,'manifest.json'),JSON.stringify({id:'unrelated'}));
 await assert.rejects(replaceReleaseFiles(source,target));
 assert.equal(JSON.parse(await readFile(path.join(target,'manifest.json'),'utf8')).id,'unrelated');
});
