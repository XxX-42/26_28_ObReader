/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const fail=(code,message)=>Object.assign(new Error(message),{code});

// Explicit operation only: the caller owns the migration window, and must
// supply a read-only legacy reader. No PDF data or former index is backed up.
function createSingleJsonlBatchMigration({adapter,registry,runner,readLegacy,deferred=null}){
  if(typeof readLegacy!=='function')throw TypeError('A verified legacy reader is required.');
  async function migrate(){
    const original=await adapter.read(registry.path);
    let index;
    try{index=JSON.parse(original)}catch{throw fail('V15_REGISTRY_INVALID','The legacy registry is unreadable.')}
    if(!index||index.schemaVersion===15||!index.entries||typeof index.entries!=='object'||Array.isArray(index.entries))
      throw fail('V15_REGISTRY_INVALID','A legacy document registry is required.');
    const entries=Object.entries(index.entries).sort(([a],[b])=>a.localeCompare(b));
    const results=[],failures=[];
    for(const [path,identity] of entries){
      try {
        if(!identity||!identity.documentId||!identity.docKey)throw fail('V15_REGISTRY_INVALID',`Invalid document route: ${path}`);
        const legacy=await readLegacy(path,identity);
        if(!legacy?.document||!legacy?.snapshot||legacy.snapshot.syncPending||legacy.document.documentId!==identity.documentId||legacy.document.docKey!==identity.docKey||legacy.document.sourcePath!==path)
          throw fail('V15_LEGACY_UNVERIFIED',`Cannot verify legacy state: ${path}`);
        if(deferred&&!(legacy.snapshot.annotations||[]).length&&!(legacy.snapshot.tombstones||[]).length&&
          !(legacy.snapshot.deletionGuards||[]).length&&!(legacy.document.legacyIdentities||[]).length){
          await deferred.remember(legacy.document);
          results.push({path,documentId:identity.documentId,docKey:identity.docKey,status:'deferred',pairId:null,
            counts:{annotations:0,tombstones:0,deletionGuards:0},annotationPath:null,historyPath:null,receiptPath:null,
            originalSha256:null,pairedSha256:null});
          continue;
        }
        const result=await runner.migrate(legacy);
        const root=registry.path.slice(0,-'/_registry.json'.length),stem=path.replace(/\.pdf$/i,'');
        results.push({path,documentId:identity.documentId,docKey:identity.docKey,status:'migrated',pairId:result.pairId,counts:result.counts,resumed:result.resumed,
          annotationPath:`${root}/annotations/${stem}.jsonl`,historyPath:`${root}/history/${stem}.jsonl`,receiptPath:result.receiptPath||null,
          originalSha256:result.document?.pairing?.originalSha256||null,pairedSha256:result.document?.pairing?.pairedSha256||null});
      } catch(error) { failures.push({path,code:error?.code||'V15_MIGRATION_FAILED',message:String(error?.message||error)}); }
    }
    if(failures.length){const error=fail(failures[0].code,'Some PDFs could not be migrated; the legacy registry remains unchanged.');error.failures=failures;error.results=results;throw error;}
    // rebuild validates each v15 current file; it must not replace a registry
    // changed since this migration started, even if all PDFs were paired.
    await registry.rebuild({expectedRaw:original,validate(routes){
      for(const result of results){if(result.status==='deferred')continue;const route=routes[result.pairId];if(!route||route.sourcePath!==result.path||route.documentId!==result.documentId||route.docKey!==result.docKey)
        throw fail('V15_MIGRATION_UNVERIFIED',`Migrated route does not match: ${result.path}`)}
    }});
    return results;
  }
  return {migrate};
}
module.exports={createSingleJsonlBatchMigration};
