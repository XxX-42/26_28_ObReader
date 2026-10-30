import {readFile,writeFile,rename,stat,readdir,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url);
const {createSingleJsonlStore}=require('../plugin/storage/single-jsonl-store.cjs');
const {localDateSuffix}=require('../plugin/storage/jsonl-filename.cjs');
const vault=path.resolve(process.argv[2]||'');
if(!process.argv[2])throw Error('Explicit vault required');
const root='00_Archive/20_PDFData',absolute=p=>path.join(vault,...p.split('/'));
const adapter={async exists(p){try{await stat(absolute(p));return true}catch(e){if(e.code==='ENOENT')return false;throw e}},read:p=>readFile(absolute(p),'utf8'),write:(p,t)=>writeFile(absolute(p),t),mkdir:p=>mkdir(absolute(p)),rename:(a,b)=>rename(absolute(a),absolute(b)),async process(p,fn){throw Error('read-only validation')},async list(p){const rows=await readdir(absolute(p),{withFileTypes:true});return {files:rows.filter(e=>e.isFile()).map(e=>p+'/'+e.name),folders:rows.filter(e=>e.isDirectory()).map(e=>p+'/'+e.name)}}};
const store=createSingleJsonlStore({adapter});
const registryPath=absolute(root+'/_registry.json'),oldRegistry=await readFile(registryPath,'utf8'),registry=JSON.parse(oldRegistry);
if(registry.schemaVersion!==15)throw Error('v15 registry required');
const changes=[],hash=b=>createHash('sha256').update(b).digest('hex');
for(const row of Object.values(registry.entries)){
 const current=await store.readCurrent(row.sourcePath);if(!current||current.document.documentId!==row.documentId)throw Error('Identity mismatch');
 await store.readHistory(row.sourcePath,current.pairId);
 const old=store.pathsFor(row.sourcePath),stem=row.sourcePath.slice(0,-4),legacy=`${root}/annotations/${stem}.jsonl`;
 if(old.current!==legacy)continue;
 const date=localDateSuffix(),target={current:`${root}/annotations/${stem}${date}.jsonl`,history:`${root}/history/${stem}${date}.jsonl`};
 for(const kind of ['current','history']){
  if(await adapter.exists(target[kind]))throw Error('Destination exists: '+target[kind]);
  const dir=old[kind].slice(0,old[kind].lastIndexOf('/'));
  if((await adapter.list(dir)).files.some(p=>p.startsWith(old[kind]+'.pending-')))throw Error('Pending save files require recovery');
  changes.push({from:old[kind],to:target[kind],sha256:hash(await readFile(absolute(old[kind])))});
 }
 row.jsonlPath=target.current;
}
if(!process.argv.includes('--apply')){console.log(JSON.stringify({dryRun:true,changes},null,2));process.exit(0)}
const moved=[];
try{
 for(const entry of changes){if(hash(await readFile(absolute(entry.from)))!==entry.sha256)throw Error('Source changed');await rename(absolute(entry.from),absolute(entry.to));moved.push(entry);if(hash(await readFile(absolute(entry.to)))!==entry.sha256)throw Error('Rename verification failed')}
 if(await readFile(registryPath,'utf8')!==oldRegistry)throw Error('Registry changed');
 const temp=registryPath+'.pending-'+randomUUID();await writeFile(temp,JSON.stringify(registry));await rename(temp,registryPath);
 const fresh=createSingleJsonlStore({adapter});for(const row of Object.values(registry.entries)){const current=await fresh.readCurrent(row.sourcePath);await fresh.readHistory(row.sourcePath,current.pairId)}
 console.log(JSON.stringify({migrated:changes.length,changes},null,2));
}catch(e){await writeFile(registryPath,oldRegistry);for(const entry of moved.reverse())await rename(absolute(entry.to),absolute(entry.from));throw e}
