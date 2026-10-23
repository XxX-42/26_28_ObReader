import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { VocabularyMemoryAdapter } from "./vocabulary-v2-memory-adapter.mjs";

const require = createRequire(import.meta.url);
const { VocabularyTransactionCoordinator } = require("../plugin/vocabulary/transactions.cjs");
const { VocabularyHistory } = require("../plugin/vocabulary/history.cjs");
const { createMarkdownRouting, MARKDOWN_ROUTE_ROOT, MARKDOWN_OWNER_ROOT, MARKDOWN_BINDING_ROOT } =
  require("../plugin/learning/markdown-routing.cjs");

function makeRuntime(adapter, deviceId = "route-device", sessionId = `${deviceId}-session`) {
  let sequence = 0;
  const coordinator = new VocabularyTransactionCoordinator({ adapter, deviceId, sessionId,
    makeId: () => `route-tx-${deviceId}-${++sequence}`, now: () => 1 });
  const history = new VocabularyHistory({ coordinator });
  return { coordinator, history, routing: createMarkdownRouting({ transaction: coordinator }) };
}

const proof = (fromPath, toPath) => ({ kind: "vault-rename", fromPath, toPath });

test("captured Markdown owners bind idempotently and write external immutable route facts only", async () => {
  const adapter = new VocabularyMemoryAdapter();
  const { routing } = makeRuntime(adapter);
  const owner = { ownerKind: "learning-item", ownerId: "learning:v1:item-one" };
  const first = await routing.bindCaptured({ ...owner, currentPath: "Notes/A.md" });
  assert.equal(first.status, "bound");
  assert.equal((await routing.resolve(owner)).currentPath, "Notes/A.md");
  assert.equal((await routing.bindCaptured({ ...owner, currentPath: "Notes/A.md" })).status, "duplicate");
  assert.ok([...adapter.files.keys()].some(path => path.startsWith(`${MARKDOWN_OWNER_ROOT}/`)));
  assert.ok([...adapter.files.keys()].some(path => path.startsWith(`${MARKDOWN_BINDING_ROOT}/`)));
  assert.equal([...adapter.files.keys()].some(path => path.includes("/history/")), false,
    "route commits pass historySummary:null and do not create ReviewHistory batches");
  assert.equal([...adapter.files.values()].every(text => !text.includes('"historySummary":')), true);
  assert.ok([...adapter.files.keys()].filter(path => path.startsWith(`${MARKDOWN_ROUTE_ROOT}/`)).length >= 2);
});

test("aliases follow rename chains, while path reuse receives a new binding and same-path forks fail closed", async () => {
  const adapter = new VocabularyMemoryAdapter();
  const { routing } = makeRuntime(adapter);
  const one = { ownerKind: "learning-item", ownerId: "item-one" };
  const alias = { ownerKind: "learning-item", ownerId: "item-alias" };
  await routing.bindCaptured({ ...one, currentPath: "Notes/A.md" });
  await routing.bindCaptured({ ...alias, currentPath: "Notes/A.md" });
  const originalBinding = (await routing.resolve(one)).bindingId;
  await routing.recordRename({ fromPath: "Notes/A.md", toPath: "Archive/B.md", eventProof: proof("Notes/A.md", "Archive/B.md") });
  await routing.recordRename({ fromPath: "Archive/B.md", toPath: "Archive/C.md", eventProof: proof("Archive/B.md", "Archive/C.md") });
  assert.equal((await routing.resolve(one)).currentPath, "Archive/C.md");
  assert.equal((await routing.resolve(alias)).currentPath, "Archive/C.md");
  await routing.bindManual({ ...one, currentPath: "Recovered/Manual.md" });
  assert.equal((await routing.resolve(one)).currentPath, "Recovered/Manual.md");
  assert.equal((await routing.resolve(alias)).currentPath, "Recovered/Manual.md", "path correction keeps aliases on their stable binding");
  await routing.bindCaptured({ ownerKind: "learning-item", ownerId: "new-file-at-old-path", currentPath: "Notes/A.md" });
  const reused = await routing.resolve({ ownerKind: "learning-item", ownerId: "new-file-at-old-path" });
  assert.equal(reused.currentPath, "Notes/A.md");
  assert.notEqual(reused.bindingId, originalBinding, "a retired path does not resurrect the old binding");
  await assert.rejects(routing.bindCaptured({ ownerKind: "learning-item", ownerId: "forced-fork",
    currentPath: "Notes/A.md", bindingId: "markdown-binding-v1:forced" }), { code: "MARKDOWN_ROUTE_PATH_CONFLICT" });
  await routing.bindManual({ ...one, currentPath: "Notes/A.md" });
  const manuallyRebound = await routing.resolve(one);
  assert.equal(manuallyRebound.currentPath, "Notes/A.md");
  assert.equal(manuallyRebound.bindingId, reused.bindingId, "explicit manual binding may rebind a selected owner to the existing path binding");
  assert.equal((await routing.resolve(alias)).currentPath, "Recovered/Manual.md");
});

test("legacy owners bind only with a matching observed rename event", async () => {
  const adapter = new VocabularyMemoryAdapter();
  const { routing } = makeRuntime(adapter);
  const legacy = { ownerKind: "learning-item", ownerId: "legacy-item", sourcePath: "Notes/old.md" };
  await assert.rejects(routing.recordRename({ fromPath: "Notes/old.md", toPath: "Moved/new.md", legacyOwners: [legacy] }),
    { code: "MARKDOWN_ROUTE_EVENT_PROOF_REQUIRED" });
  await routing.recordRename({ fromPath: "Notes/old.md", toPath: "Moved/new.md", eventProof: proof("Notes/old.md", "Moved/new.md"),
    legacyOwners: [legacy] });
  const resolved = await routing.resolve({ ownerKind: legacy.ownerKind, ownerId: legacy.ownerId });
  assert.equal(resolved.status, "verified");
  assert.equal(resolved.currentPath, "Moved/new.md");
});

test("independent device contributions union, but concurrent same-path aliases are unresolved", async () => {
  const adapter = new VocabularyMemoryAdapter();
  const left = makeRuntime(adapter, "route-device-left");
  const right = makeRuntime(adapter, "route-device-right");
  await Promise.all([
    left.routing.bindCaptured({ ownerKind: "learning-item", ownerId: "left-owner", currentPath: "Left/A.md" }),
    right.routing.bindCaptured({ ownerKind: "learning-item", ownerId: "right-owner", currentPath: "Right/B.md" }),
  ]);
  assert.equal((await left.routing.resolve({ ownerKind: "learning-item", ownerId: "left-owner" })).currentPath, "Left/A.md");
  assert.equal((await right.routing.resolve({ ownerKind: "learning-item", ownerId: "right-owner" })).currentPath, "Right/B.md");
  assert.equal((await left.routing.listBindings()).length, 2, "independent owner facts survive sync as a union");

  const collisionAdapter = new VocabularyMemoryAdapter();
  const deviceA = makeRuntime(collisionAdapter, "route-alias-device-a");
  const deviceB = makeRuntime(collisionAdapter, "route-alias-device-b");
  await Promise.all([
    deviceA.routing.bindCaptured({ ownerKind: "learning-item", ownerId: "alias-a", currentPath: "Shared/Note.md" }),
    deviceB.routing.bindCaptured({ ownerKind: "learning-item", ownerId: "alias-b", currentPath: "Shared/Note.md" }),
  ]);
  const a = await deviceA.routing.resolve({ ownerKind: "learning-item", ownerId: "alias-a" });
  const b = await deviceB.routing.resolve({ ownerKind: "learning-item", ownerId: "alias-b" });
  assert.equal(a.status, "unresolved");
  assert.equal(a.reason, "path-binding-conflict");
  assert.equal(b.status, "unresolved");

  const firstDevice = new VocabularyMemoryAdapter();
  const secondDevice = new VocabularyMemoryAdapter();
  const first = makeRuntime(firstDevice, "same-owner-device-a");
  const second = makeRuntime(secondDevice, "same-owner-device-b");
  const sameOwner = { ownerKind: "learning-item", ownerId: "same-owner-concurrent-confirm" };
  await first.routing.bindCaptured({ ...sameOwner, currentPath: "DeviceA/Note.md" });
  await second.routing.bindCaptured({ ...sameOwner, currentPath: "DeviceB/Note.md" });
  for (const [path, text] of secondDevice.files) firstDevice.files.set(path, text);
  for (const directory of secondDevice.directories) firstDevice.directories.add(directory);
  for (const [path, text] of firstDevice.files) secondDevice.files.set(path, text);
  for (const directory of firstDevice.directories) secondDevice.directories.add(directory);
  const syncedFirst = createMarkdownRouting({ transaction: first.coordinator });
  const syncedSecond = createMarkdownRouting({ transaction: second.coordinator });
  assert.equal((await syncedFirst.resolve(sameOwner)).status, "unresolved",
    "two device-specific first confirmations cannot pick a wall-clock winner");
  assert.equal((await syncedSecond.resolve(sameOwner)).status, "unresolved");
});

test("missing parents and corrupt route resources fail closed", async () => {
  const adapter = new VocabularyMemoryAdapter();
  const { coordinator, routing } = makeRuntime(adapter);
  const owner = { ownerKind: "learning-item", ownerId: "chain-owner" };
  await routing.bindCaptured({ ...owner, currentPath: "Chain/A.md" });
  await routing.recordRename({ fromPath: "Chain/A.md", toPath: "Chain/B.md", eventProof: proof("Chain/A.md", "Chain/B.md") });
  const routeFiles = [...adapter.files.keys()].filter(path => path.startsWith(`${MARKDOWN_BINDING_ROOT}/`));
  const parsed = routeFiles.map(path => [path, JSON.parse(adapter.files.get(path))]);
  const parentPath = parsed.find(([, fact]) => fact.operation === "bind")[0];
  adapter.files.delete(parentPath);
  const missing = await routing.resolve(owner);
  assert.equal(missing.status, "unresolved");
  assert.match(missing.reason, /parent-missing/);

  const remainingPath = routeFiles.find(path => adapter.files.has(path));
  adapter.files.set(remainingPath, "{corrupt route json");
  const reopened = createMarkdownRouting({ transaction: coordinator });
  await assert.rejects(reopened.resolve(owner), { code: "VOCAB_TX_JSON_INVALID" });
});

test("a partial coordinator commit is recovered before the route can verify", async () => {
  let injected = false;
  const adapter = new VocabularyMemoryAdapter({ hook: async event => {
    if (!injected && event.phase === "after" && event.operation === "rename" &&
        event.to.startsWith(`${MARKDOWN_ROUTE_ROOT}/`) && event.to.endsWith(".json")) {
      injected = true;
      throw new Error("injected route transaction interruption");
    }
  } });
  const { coordinator, routing } = makeRuntime(adapter, "route-recovery-device");
  const owner = { ownerKind: "learning-item", ownerId: "recovery-owner" };
  await assert.rejects(routing.bindCaptured({ ...owner, currentPath: "Notes/Recover.md" }), /interruption/);
  adapter.hook = null;
  const beforeRecovery = await routing.resolve(owner);
  assert.equal(beforeRecovery.status, "unresolved", "a partial route is never reported as verified");
  const recovery = await coordinator.recoverLocal();
  assert.equal(recovery.status, "recovered");
  const afterRecovery = await createMarkdownRouting({ transaction: coordinator }).resolve(owner);
  assert.equal(afterRecovery.status, "verified");
  assert.equal(afterRecovery.currentPath, "Notes/Recover.md");
});
