import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nativeConfig, nativeEvalJson, nativeCdp, invokeNativeCli,
  assertNativeVaultIdentity } from "./native-config.mjs";

export async function verifyNativeWalColdReopen({ relativePdf, document, expectedLast, expectedCount, expectedStateHash, expectedOperationHash }) {
  const state = nativeEvalJson(`JSON.stringify((()=>{
    const readers=app.workspace.getLeavesOfType("pdf-web-reader-view");
    if(readers.some(l=>l.view.currentRevision!==l.view.confirmedRevision||l.view.pendingSaves>0))
      throw Error("Refusing to unload a dirty Reader");
    globalThis.__nativeWalOldStore=new WeakRef(app.plugins.plugins["pdf-web-reader"].annotationHost.store);
    for(const leaf of readers)leaf.detach();
    return {vault:app.vault.adapter.basePath,configDir:app.vault.configDir};
  })())`);
  assertNativeVaultIdentity(state);
  try {
    let remaining = 1;
    for (let attempt = 0; attempt < 100 && remaining; attempt++) {
      remaining = nativeEvalJson(`JSON.stringify(app.workspace.getLeavesOfType("pdf-web-reader-view").length)`);
      if (remaining) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(remaining, 0, "the original Reader must be fully detached");
    invokeNativeCli(["plugin:reload", "id=pdf-web-reader"]);
    nativeCdp("HeapProfiler.collectGarbage");
    const reopened = nativeEvalJson(`(async()=>{
      const store=app.plugins.plugins["pdf-web-reader"].annotationHost.store;
      if(store===globalThis.__nativeWalOldStore?.deref())throw Error("Store instance was reused");
      const file=app.vault.getAbstractFileByPath(${JSON.stringify(relativePdf)});
      await app.workspace.getLeaf(true).openFile(file);
      const view=app.workspace.activeLeaf.view;
      const snapshot=await store.readDocument(view.annotationDocument);
      const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==="object"?
        Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
      const stateHash=require("node:crypto").createHash("sha256").update(JSON.stringify(
        stable([...snapshot.annotations].sort((a,b)=>a.uuid.localeCompare(b.uuid))))).digest("hex");
      const effective=await store.readEffective(view.annotationDocument);
      const operationHash=require("node:crypto").createHash("sha256").update(JSON.stringify(
        stable(Object.values(effective.state.annotations).sort((a,b)=>a.uuid.localeCompare(b.uuid))))).digest("hex");
      return JSON.stringify({newStore:true,documentId:view.annotationDocument.documentId,
        count:snapshot.annotations.length,unique:new Set(snapshot.annotations.map(a=>a.uuid)).size,
        syncPending:snapshot.syncPending===true,stateHash,operationHash,
        last:snapshot.annotations.find(a=>a.uuid===${JSON.stringify(expectedLast.uuid)})});
    })()`, 120_000);
    assert.equal(reopened.documentId, document.documentId);
    assert.equal(reopened.count, expectedCount);
    assert.equal(reopened.unique, expectedCount);
    assert.equal(reopened.syncPending, false);
    assert.deepEqual(reopened.last, expectedLast);
    assert.equal(reopened.stateHash, expectedStateHash);
    assert.equal(reopened.operationHash, expectedOperationHash);
    // This child has no access to the Obsidian renderer or its old Store cache.
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("./wal-v32-cold-read-worker.mjs", import.meta.url))], {
      input: JSON.stringify({ vault: nativeConfig.vault, document, expectedLast, expectedCount, expectedStateHash, expectedOperationHash }),
      encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const independent = JSON.parse(child.stdout);
    assert.notEqual(independent.pid, process.pid);
    return { reopened, independent };
  } finally {
    nativeEvalJson(`JSON.stringify(delete globalThis.__nativeWalOldStore)`);
  }
}
