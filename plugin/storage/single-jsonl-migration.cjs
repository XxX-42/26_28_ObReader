/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { sha256 } = require('@noble/hashes/sha256');
const { canonicalJson } = require('./canonical.cjs');
const { ensurePairId } = require('../pdf-pair-id.cjs');
const digest = bytes => 'sha256-v1:'+Array.from(sha256(bytes),b=>b.toString(16).padStart(2,'0')).join('');
// Preserve the exact SHA-256 protocol while allowing the host's native
// implementation to hash large PDFs off the JavaScript hot path.
async function digestMigrationBytes(bytes,subtle=globalThis.crypto?.subtle){
  if(!subtle?.digest)return digest(bytes);
  const hash=await subtle.digest('SHA-256',bytes);
  return 'sha256-v1:'+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}
const fail = message => Object.assign(new Error(message), { code:'V15_MIGRATION_UNVERIFIED' });

// Pure preparation: callers journal and verify before publishing either
// artifact. Old logs are read only and are never removed by this module.
async function prepareSingleJsonlMigration({ sourceBytes, document, snapshot, pairId, verifySource, clock=Date.now }) {
  if(!document?.documentId||!document.docKey||!document.source?.sourceHash||!document.sourcePath||
    !snapshot||snapshot.syncPending||!Array.isArray(snapshot.annotations)||!Array.isArray(snapshot.tombstones))throw fail('Only a fully verified current state can be migrated.');
  const snapshotId=snapshot.document?.documentId||snapshot.document?.id;
  if(snapshotId&&snapshotId!==document.documentId)throw fail('Snapshot document identity differs.');
  if(snapshot.source?.sourceHash&&snapshot.source.sourceHash!==document.source.sourceHash)throw fail('Snapshot source identity differs.');
  const bytes=sourceBytes instanceof Uint8Array?sourceBytes:new Uint8Array(sourceBytes);
  const expectedSource=document.pairing?.pairedSha256||document.source.sourceHash;
  const sourceVerified=typeof verifySource==='function'?await verifySource(bytes,expectedSource):await digestMigrationBytes(bytes)===expectedSource;
  if(!sourceVerified)throw fail('PDF bytes do not match the verified legacy source.');
  const result=await ensurePairId(bytes,pairId),id=result.pairId;
  const state=JSON.parse(canonicalJson({annotations:snapshot.annotations,tombstones:snapshot.tombstones,deletionGuards:snapshot.deletionGuards||[]}));
  const seen=new Set();
  for(const row of [...state.annotations,...state.tombstones,...state.deletionGuards]){
    if(typeof row.uuid!=='string'||!row.uuid||seen.has(row.uuid))throw fail('Duplicate annotation identities prevent migration.');seen.add(row.uuid);
  }
  const originalSha256=await digestMigrationBytes(bytes),pairedSha256=await digestMigrationBytes(result.bytes);
  const nextDocument=JSON.parse(canonicalJson({...document,pairId:id,pairing:{originalSha256,pairedSha256,originalSize:bytes.byteLength,pairedSize:result.bytes.byteLength,createdAt:clock()}}));
  return {pairId:id,pdf:{bytes:result.bytes,changed:result.changed,originalSha256,pairedSha256},
    current:{document:nextDocument,pairId:id,...state},
    counts:{annotations:state.annotations.length,tombstones:state.tombstones.length,deletionGuards:state.deletionGuards.length}};
}
module.exports={prepareSingleJsonlMigration,digestMigrationBytes};
