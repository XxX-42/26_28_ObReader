import assert from 'node:assert/strict';import {test} from 'node:test';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createSingleJsonlStore}=require('../plugin/storage/single-jsonl-store.cjs');
const {createSingleJsonlRegistry}=require('../plugin/storage/single-jsonl-registry.cjs');
function fixture(){const files=new Map(),folders=new Set(),calls=[];let seq=0;const adapter={
 async exists(p){return files.has(p)||folders.has(p)},async mkdir(p){folders.add(p)},async read(p){calls.push(['read',p]);if(!files.has(p))throw Error('missing');return files.get(p)},async write(p,t){files.set(p,t)},async rename(a,b){if(files.has(b))throw Error('exists');files.set(b,files.get(a));files.delete(a)},async remove(p){files.delete(p)},async process(p,f){files.set(p,f(files.get(p)))},async list(p){calls.push(['list',p]);return {files:[...files.keys()].filter(x=>x.startsWith(p+'/')&&!x.slice(p.length+1).includes('/')),folders:[...folders].filter(x=>x.startsWith(p+'/')&&!x.slice(p.length+1).includes('/'))}}};
const store=createSingleJsonlStore({adapter,token:()=>`t-${++seq}`}),registry=createSingleJsonlRegistry({adapter,store});
const init=(sourcePath,pairId)=>store.initialize({document:{documentId:pairId,docKey:pairId.slice(0,12),sourcePath,source:{sourceHash:'sha256-v1:'+'1'.repeat(64)}},pairId});
return {files,calls,store,registry,init}}
test('registry hit validates exactly one current file without listing directories',async()=>{
 const w=fixture(),id='12'.repeat(16),current=await w.init('Books/a.pdf',id);await w.registry.remember(current);w.calls.length=0;
 assert.equal((await w.registry.lookup(id)).pairId,id);
 assert.equal(w.calls.filter(x=>x[0]==='list').length,0);
 assert.equal(w.calls.filter(x=>x[0]==='read').length,2);
});
test('same named PDFs in different directories remain separate and damaged registry repairs from verified current files',async()=>{
 const w=fixture(),a='12'.repeat(16),b='34'.repeat(16);await w.init('One/a.pdf',a);await w.init('Two/a.pdf',b);
 w.files.set(w.registry.path,'{bad');
 assert.equal((await w.registry.lookup(b)).document.sourcePath,'Two/a.pdf');
 assert.equal(Object.keys(JSON.parse(w.files.get(w.registry.path)).entries).length,2);
});
test('duplicate pair identity and damaged current file never replace a valid registry',async()=>{
 const w=fixture(),id='12'.repeat(16),current=await w.init('Books/a.pdf',id);await w.registry.remember(current);const before=w.files.get(w.registry.path);
 await w.init('Books/copy.pdf',id);
 await assert.rejects(w.registry.rebuild(),{code:'V15_PAIR_DUPLICATE'});assert.equal(w.files.get(w.registry.path),before);
 w.files.set(w.store.pathsFor('Books/copy.pdf').current,'{corrupt');
 await assert.rejects(w.registry.rebuild(),{code:'V15_REGISTRY_REBUILD_INCOMPLETE'});assert.equal(w.files.get(w.registry.path),before);
});

test('rename updates the cache and preserves the original document identity',async()=>{
 const w=fixture(),id='12'.repeat(16),current=await w.init('Books/a.pdf',id);await w.registry.remember(current);
 const moved=await w.registry.renameDocument({fromPath:'Books/a.pdf',toPath:'Other/renamed.pdf',pairId:id});
 assert.equal(moved.document.documentId,current.document.documentId);
 assert.equal((await w.registry.lookup(id)).document.sourcePath,'Other/renamed.pdf');
});
test('migration rebuild refuses changed registry and rejects invalid routes before publication',async()=>{
 const w=fixture(),id='12'.repeat(16),current=await w.init('Books/a.pdf',id);await w.registry.remember(current);
 const original=w.files.get(w.registry.path);
 await assert.rejects(w.registry.rebuild({expectedRaw:'stale'}),{code:'V15_STALE_WRITE'});
 assert.equal(w.files.get(w.registry.path),original);
 await assert.rejects(w.registry.rebuild({expectedRaw:original,validate(){throw Error('missing document')}}),/missing document/);
 assert.equal(w.files.get(w.registry.path),original);
});
test('ordinary lookup cannot replace a valid legacy registry with an empty v15 index',async()=>{
 const w=fixture(),id='12'.repeat(16),legacy=JSON.stringify({schemaVersion:1,entries:{'Books/old.pdf':{documentId:'old'}}});
 w.files.set(w.registry.path,legacy);
 await assert.rejects(w.registry.lookup(id),{code:'V15_REGISTRY_REBUILD_REQUIRED'});
 assert.equal(w.files.get(w.registry.path),legacy);
});
test('lookup during partial synchronization cannot drop routes whose current files are missing',async()=>{
 const w=fixture(),a='12'.repeat(16),b='34'.repeat(16);
 await w.registry.remember(await w.init('Books/a.pdf',a));await w.registry.remember(await w.init('Books/b.pdf',b));
 const before=w.files.get(w.registry.path),missing=w.store.pathsFor('Books/a.pdf').current,old=w.files.get(missing);
 w.files.delete(missing);
 await assert.rejects(w.registry.lookup(a),{code:'V15_REGISTRY_REBUILD_INCOMPLETE'});
 assert.equal(w.files.get(w.registry.path),before,'a missing synced file cannot remove either route');
 assert.equal((await w.registry.lookup(b)).pairId,b,'a known available document remains usable');
 w.files.set(missing,old);assert.equal((await w.registry.lookup(a)).pairId,a);
});
