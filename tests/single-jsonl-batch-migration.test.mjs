import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createSingleJsonlBatchMigration}=require('../plugin/storage/single-jsonl-batch-migration.cjs');
const entries={'Books/a.pdf':{documentId:'a',docKey:'one'},'Books/b.pdf':{documentId:'b',docKey:'two'},'Books/c.pdf':{documentId:'c',docKey:'three'}};
function setup({pending=false,badRoute=false}={}){
 const raw=JSON.stringify({schemaVersion:1,entries}),published=[];
 const adapter={read:async()=>raw};let runs=0;
 const registry={path:'index',async rebuild({expectedRaw,validate}){assert.equal(expectedRaw,raw);const routes=Object.fromEntries(Object.entries(entries).map(([path,v])=>['pair-'+v.documentId,{sourcePath:path,...v}]));if(badRoute)delete routes['pair-b'];validate(routes);published.push(routes);return routes}};
 const runner={async migrate({document}){runs++;return {pairId:'pair-'+document.documentId,counts:{annotations:1},resumed:false}}};
 const readLegacy=async(path,identity)=>({document:{...identity,sourcePath:path},snapshot:{annotations:[],tombstones:[],syncPending:pending&&identity.documentId==='b'}});
 return {task:createSingleJsonlBatchMigration({adapter,registry,runner,readLegacy}),published,get runs(){return runs}};
}
test('migration switches the registry only after every legacy document is verified',async()=>{
 const x=setup();assert.equal((await x.task.migrate()).length,3);assert.equal(x.runs,3);assert.equal(x.published.length,1);
});
test('pending sync and missing migrated routes never publish the new registry',async()=>{
 const a=setup({pending:true});await assert.rejects(a.task.migrate(),error=>{assert.equal(error.code,'V15_LEGACY_UNVERIFIED');assert.deepEqual(error.results.map(row=>row.path),['Books/a.pdf','Books/c.pdf']);assert.equal(error.failures[0].path,'Books/b.pdf');return true});assert.equal(a.published.length,0);
 const b=setup({badRoute:true});await assert.rejects(b.task.migrate(),{code:'V15_MIGRATION_UNVERIFIED'});assert.equal(b.published.length,0);
});
