import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { MemoryDataAdapter } from "./vocabulary-transaction-memory-adapter.mjs";
import { VocabularyMemoryAdapter } from "./vocabulary-v2-memory-adapter.mjs";

const require = createRequire(import.meta.url);
const { canonicalStringify, hashText, canonicalHash } = require("../plugin/vocabulary/canonical.cjs");
const { VocabularyTransactionCoordinator } = require("../plugin/vocabulary/transactions.cjs");

const ROOT = "00_Archive/21_VocabularyData";
const DEVICE = "device-local-01";
const SESSION = "session-local-01";

function coordinator(adapter, { deviceId = DEVICE, sessionId = SESSION, ids = [] } = {}) {
  let index = 0;
  return new VocabularyTransactionCoordinator({
    adapter,
    deviceId,
    sessionId,
    makeId: () => ids[index++] || `tx-${index}`,
  });
}

function documentText(revision, value) {
  return canonicalStringify({ revision, value });
}

async function seed(adapter, path, revision = 1, value = "base") {
  const text = documentText(revision, value);
  await adapter.write(path, text);
  return { path, text, hash: hashText(text), revision };
}

function write(path, storeId, base, revision, value) {
  const text = documentText(revision, value);
  return {
    path,
    storeId,
    expectedRevision: base.revision,
    expectedHash: base.hash,
    text,
  };
}

test("multi-store transaction preflights every store before installing the first write", async () => {
  const adapter = new MemoryDataAdapter();
  const firstPath = `${ROOT}/core-a.json`;
  const secondPath = `${ROOT}/core-b.json`;
  const first = await seed(adapter, firstPath);
  const second = await seed(adapter, secondPath);
  await adapter.write(secondPath, documentText(2, "external replacement"));
  const tx = coordinator(adapter);

  const result = await tx.commit({
    actionId: "two-store-change",
    writes: [write(firstPath, "core-a", first, 2, "must remain unapplied"), write(secondPath, "core-b", second, 2, "requested")],
  });

  assert.equal(result.status, "conflict");
  assert.equal((await tx.readSnapshot(firstPath)).text, first.text);
  assert.equal((await tx.readSnapshot(secondPath)).value.value, "external replacement");
  assert.deepEqual(tx.lastLockOrder, [...tx.lastLockOrder].sort());
});

test("same-adapter coordinator instances share local path locks and conflicting writes cannot race through", async () => {
  const adapter = new MemoryDataAdapter();
  const path = `${ROOT}/shared.json`;
  const base = await seed(adapter, path);
  const first = coordinator(adapter, { ids: ["tx-first"] });
  const second = coordinator(adapter, { ids: ["tx-second"] });

  const results = await Promise.all([
    first.commit({ actionId: "first", writes: [write(path, "shared", base, 2, "first result")] }),
    second.commit({ actionId: "second", writes: [write(path, "shared", base, 2, "second result")] }),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), ["committed", "conflict"]);
  assert.ok(["first result", "second result"].includes((await first.readSnapshot(path)).value.value));
});

test("local recovery completes result/base states and preserves a third-state replacement with its pending intent", async () => {
  const adapter = new MemoryDataAdapter();
  const firstPath = `${ROOT}/recover-a.json`;
  const secondPath = `${ROOT}/recover-b.json`;
  const first = await seed(adapter, firstPath);
  const second = await seed(adapter, secondPath);
  const tx = coordinator(adapter, { ids: ["tx-recovery"] });
  let crash = true;
  adapter.renameHook = async (from, to) => {
    if (crash && to === secondPath && from.includes(".vocab-stage-")) {
      crash = false;
      throw new Error("injected crash before second install");
    }
  };

  await assert.rejects(tx.commit({
    actionId: "recover-two",
    writes: [write(firstPath, "core-a", first, 2, "first result"), write(secondPath, "core-b", second, 2, "second result")],
  }), /injected crash/);
  adapter.renameHook = null;
  assert.equal((await tx.readSnapshot(firstPath)).value.value, "first result");
  assert.equal((await tx.readSnapshot(secondPath)).exists, false, "the verified base is held aside while the staged result awaits recovery");
  assert.equal(adapter.filePaths(`${secondPath}.vocab-backup-`).length, 1);
  const recovered = await tx.recoverLocal();
  assert.equal(recovered.status, "recovered");
  assert.equal((await tx.readSnapshot(secondPath)).value.value, "second result");
  assert.equal(adapter.filePaths(`${ROOT}/transactions/${DEVICE}/${SESSION}/`).filter((path) => path.endsWith(".pending.json")).length, 0);

  const thirdPath = `${ROOT}/recover-third.json`;
  const fourthPath = `${ROOT}/recover-fourth.json`;
  const third = await seed(adapter, thirdPath);
  const fourth = await seed(adapter, fourthPath);
  let secondCrash = true;
  adapter.renameHook = async (from, to) => {
    if (secondCrash && to === fourthPath && from.includes(".vocab-stage-")) {
      secondCrash = false;
      throw new Error("injected second crash");
    }
  };
  await assert.rejects(tx.commit({
    actionId: "recover-third-state",
    writes: [write(thirdPath, "core-c", third, 2, "first applied"), write(fourthPath, "core-d", fourth, 2, "requested")],
  }), /injected second crash/);
  adapter.renameHook = null;
  await adapter.write(fourthPath, documentText(3, "external third state"));
  const conflict = await tx.recoverLocal();
  assert.equal(conflict.status, "conflict");
  assert.equal((await tx.readSnapshot(fourthPath)).value.value, "external third state");
  assert.equal((await tx.readSnapshot(thirdPath)).value.value, "first applied");
  assert.equal(adapter.filePaths(`${ROOT}/transactions/${DEVICE}/${SESSION}/`).filter((path) => path.endsWith(".pending.json")).length, 1);
});

test("foreign pending data is ignored and an unscoped malformed local intent does not block an unrelated store", async () => {
  const adapter = new MemoryDataAdapter();
  const localPath = `${ROOT}/unrelated.json`;
  const base = await seed(adapter, localPath);
  await adapter.write(`${ROOT}/transactions/device-foreign-01/session-foreign-01/foreign.pending.json`, "not local data");
  const tx = coordinator(adapter);
  await adapter.write(`${ROOT}/transactions/${DEVICE}/${SESSION}/malformed.pending.json`, "{broken");

  const result = await tx.commit({ actionId: "unrelated-commit", writes: [write(localPath, "unrelated", base, 2, "committed") ] });
  assert.equal(result.status, "committed");
  const recovery = await tx.recoverLocal();
  assert.equal(recovery.status, "conflict");
  assert.equal(recovery.conflicts.length, 1);
  assert.equal(recovery.conflicts[0].diagnosticOnly, true);
  assert.equal((await tx.readSnapshot(localPath)).value.value, "committed");
});

test("review actions append into bounded packed segments, retain ACKed prefixes across an interrupted replacement, and expose no one-file-per-action growth", async () => {
  const adapter = new MemoryDataAdapter();
  const tx = coordinator(adapter, { ids: ["tx-finalize"] });
  for (let index = 1; index <= 100; index += 1) {
    const result = await tx.appendJournalAction({ actionId: `action-${index}`, payload: { index, answer: "remembered" } });
    assert.equal(result.status, "committed");
  }
  let journal = await tx.readJournalActions();
  assert.equal(journal.actions.length, 100);
  assert.ok(journal.paths.length <= 2, `100 short actions used ${journal.paths.length} packed files`);
  assert.ok(journal.paths.every((path) => new TextEncoder().encode(adapter.files.get(path)).byteLength <= 64 * 1024));
  const duplicate = await tx.appendJournalAction({ actionId: "action-100", payload: { index: 100, answer: "remembered" } });
  assert.equal(duplicate.status, "unchanged");
  assert.equal(journal.paths.length, adapter.filePaths(`${ROOT}/transactions/${DEVICE}/${SESSION}/review-`).filter((path) => path.endsWith(".segment.json")).length);

  const activePath = journal.paths.at(-1);
  const backupPath = `${activePath}.backup`;
  let inject = true;
  adapter.renameHook = async (from, to) => {
    if (inject && from.endsWith(".stage") && to === activePath) {
      inject = false;
      throw new Error("injected journal replacement crash");
    }
  };
  await assert.rejects(tx.appendJournalAction({ actionId: "interrupted-action", payload: { index: 101 } }), /injected journal replacement crash/);
  adapter.renameHook = null;
  journal = await tx.readJournalActions();
  assert.equal(journal.actions.length, 100, "an interrupted append must leave every prior ACKed action readable");
  assert.ok(await adapter.exists(backupPath), "the old verified segment remains as recovery evidence");
  const retry = await tx.appendJournalAction({ actionId: "interrupted-action", payload: { index: 101 } });
  assert.equal(retry.status, "committed");
  journal = await tx.readJournalActions();
  assert.equal(journal.actions.length, 101);
  assert.deepEqual(journal.actions.at(-1), { sequence: 101, actionId: "interrupted-action", payload: { index: 101 } });
  assert.equal(await adapter.exists(backupPath), false);
});

test("adapters with native append write 100 actions as bounded JSONL appends instead of rewriting prior actions", async () => {
  const adapter = new VocabularyMemoryAdapter();
  const tx = coordinator(adapter);
  for (let index = 1; index <= 100; index += 1) {
    const result = await tx.appendJournalAction({ actionId: `native-${index}`, payload: { index, answer: "remembered" } });
    assert.equal(result.status, "committed");
  }

  const journal = await tx.readJournalActions();
  const measured = adapter.measured();
  assert.equal(journal.actions.length, 100);
  assert.equal(journal.actions.at(-1).sequence, 100);
  assert.equal(measured.appends, 100, "each action is written through DataAdapter.append");
  assert.equal(measured.writes, 1, "the only write initializes the empty append target");
  assert.ok(journal.paths.length <= 2, `100 short actions used ${journal.paths.length} bounded files`);
  assert.equal(measured.fileCount, journal.paths.length);
  assert.ok(journal.paths.every((path) => path.endsWith(".jsonl")));
  assert.ok(journal.paths.every((path) => new TextEncoder().encode(adapter.files.get(path)).byteLength <= 64 * 1024));
  const totalPersistedBytes = journal.paths.reduce((total, path) => total + new TextEncoder().encode(adapter.files.get(path)).byteLength, 0);
  assert.equal(measured.writtenBytes, totalPersistedBytes, "write volume is the appended action lines, not repeated prefixes");
  assert.ok(totalPersistedBytes < 32 * 1024, `100 small actions wrote ${totalPersistedBytes} bytes`);
});

test("expected journal sequences reject stale writers before append while exact action retries stay idempotent", async () => {
  const adapter = new VocabularyMemoryAdapter();
  const tx = coordinator(adapter);
  const first = await tx.appendJournalAction({ actionId: "sequence-one", payload: { index: 1 }, expectedSequence: 1 });
  assert.equal(first.status, "committed");
  const beforeStaleAttempt = adapter.measured();

  const duplicate = await tx.appendJournalAction({ actionId: "sequence-one", payload: { index: 1 }, expectedSequence: 99 });
  assert.equal(duplicate.status, "unchanged", "exact duplicate identity is resolved before checking the expected next sequence");
  const stale = await tx.appendJournalAction({ actionId: "stale-before-state", payload: { index: 2 }, expectedSequence: 1 });
  assert.equal(stale.status, "conflict");
  assert.equal(stale.conflicts[0].phase, "action-sequence-mismatch");
  assert.equal(stale.conflicts[0].expectedSequence, 1);
  assert.equal(stale.conflicts[0].actualSequence, 2);
  assert.equal(adapter.measured().appends, beforeStaleAttempt.appends, "a stale action cannot be durably appended");
  assert.equal((await tx.readJournalActions()).actions.length, 1);
});

test("two same-session writers with the same expected sequence produce one append and one conflict", async () => {
  const adapter = new VocabularyMemoryAdapter();
  const first = coordinator(adapter, { ids: ["first-coordinator"] });
  const second = coordinator(adapter, { ids: ["second-coordinator"] });
  const results = await Promise.all([
    first.appendJournalAction({ actionId: "parallel-a", payload: { writer: "a" }, expectedSequence: 1 }),
    second.appendJournalAction({ actionId: "parallel-b", payload: { writer: "b" }, expectedSequence: 1 }),
  ]);

  assert.deepEqual(results.map(({ status }) => status).sort(), ["committed", "conflict"]);
  assert.equal(adapter.measured().appends, 1, "the losing writer does not append a stale before-state action");
  const journal = await first.readJournalActions();
  assert.equal(journal.actions.length, 1);
  assert.ok(["parallel-a", "parallel-b"].includes(journal.actions[0].actionId));
});

test("a torn native append preserves prior ACKs and raw suffix evidence, then retries at a new segment", async () => {
  class TornAppendAdapter extends VocabularyMemoryAdapter {
    constructor() {
      super();
      this.failNextAppend = false;
    }
    async append(path, text) {
      if (!this.failNextAppend) return super.append(path, text);
      this.failNextAppend = false;
      const torn = text.slice(0, Math.max(1, Math.floor(text.length / 2)));
      this.files.set(path, `${this.files.get(path) || ""}${torn}`);
      this.metrics.appends += 1;
      this.metrics.writtenBytes += new TextEncoder().encode(torn).byteLength;
      this.metrics.filesTouched.add(path);
      throw new Error("injected process interruption during append");
    }
  }

  const adapter = new TornAppendAdapter();
  const tx = coordinator(adapter);
  for (let index = 1; index <= 3; index += 1) {
    await tx.appendJournalAction({ actionId: `ack-${index}`, payload: { index } });
  }
  const original = await tx.readJournalActions();
  const damagedPath = original.paths[0];
  adapter.failNextAppend = true;
  await assert.rejects(
    tx.appendJournalAction({ actionId: "torn-action", payload: { index: 4, value: "not acknowledged" } }),
    /injected process interruption during append/,
  );

  let journal = await tx.readJournalActions();
  const damagedText = adapter.files.get(damagedPath);
  assert.equal(journal.actions.length, 3, "the incomplete line is not reported as a durable action");
  assert.deepEqual(journal.actions.map(({ actionId }) => actionId), ["ack-1", "ack-2", "ack-3"]);
  assert.ok(journal.recoveryEvidence.includes(damagedPath), "the torn file remains visible as recovery evidence");
  assert.ok(!journal.cleanupPaths.includes(damagedPath), "finalization cannot delete a file with an unverified suffix");
  assert.ok(!damagedText.endsWith("\n"), "the injected crash left a partial final line");

  const retry = await tx.appendJournalAction({ actionId: "torn-action", payload: { index: 4, value: "not acknowledged" } });
  assert.equal(retry.status, "committed");
  journal = await tx.readJournalActions();
  assert.equal(journal.actions.length, 4);
  assert.deepEqual(journal.actions.at(-1), { sequence: 4, actionId: "torn-action", payload: { index: 4, value: "not acknowledged" } });
  assert.equal(adapter.files.get(damagedPath), damagedText, "retry preserves the original damaged bytes unchanged");
  assert.ok(journal.recoveryEvidence.includes(damagedPath));
  assert.ok(journal.paths.some((path) => path.endsWith("review-000001.jsonl")), "retry uses a fresh segment after the torn suffix");
});

test("a complete newline-terminated journal row with a bad integrity hash fails closed", async () => {
  const adapter = new VocabularyMemoryAdapter();
  const tx = coordinator(adapter);
  await tx.appendJournalAction({ actionId: "verified-before-corruption", payload: { index: 1 } });
  const journal = await tx.readJournalActions();
  const path = journal.paths[0];
  const original = adapter.files.get(path);
  const corrupted = original.replace(/"payloadHash":"sha256-v1:[a-f0-9]{64}"/, `"payloadHash":"${"0".repeat(72)}"`);
  assert.notEqual(corrupted, original, "test fixture must alter the integrity hash");
  adapter.files.set(path, corrupted);

  await assert.rejects(tx.readJournalActions(), { code: "VOCAB_JOURNAL_INVALID" });
  assert.equal(adapter.files.get(path), corrupted, "integrity failure preserves the complete corrupt row for diagnosis");
});

test("a torn first JSONL row is unacknowledged evidence and does not block a sequence-one retry", async () => {
  class FirstAppendTornAdapter extends VocabularyMemoryAdapter {
    constructor() {
      super();
      this.failNextAppend = true;
    }
    async append(path, text) {
      if (!this.failNextAppend) return super.append(path, text);
      this.failNextAppend = false;
      const torn = text.slice(0, Math.max(1, Math.floor(text.length / 2)));
      this.files.set(path, torn);
      throw new Error("injected first-row interruption");
    }
  }
  const adapter = new FirstAppendTornAdapter();
  const tx = coordinator(adapter);
  await assert.rejects(tx.appendJournalAction({ actionId: "first-row", payload: { index: 1 } }), /injected first-row interruption/);
  const interrupted = await tx.readJournalActions();
  assert.equal(interrupted.revision, 0);
  assert.deepEqual(interrupted.actions, []);
  assert.equal(interrupted.recoveryEvidence.length, 1);
  assert.deepEqual(interrupted.segments[0].actions, []);

  const retried = await tx.appendJournalAction({ actionId: "first-row", payload: { index: 1 } });
  assert.equal(retried.status, "committed");
  const complete = await tx.readJournalActions();
  assert.deepEqual(complete.actions, [{ sequence: 1, actionId: "first-row", payload: { index: 1 } }]);
  assert.ok(complete.recoveryEvidence.length === 1);
  assert.ok(complete.paths.some((path) => path.endsWith("review-000001.jsonl")));
});

test("finalization verifies and removes a native JSONL journal through its opaque content hash", async () => {
  const adapter = new VocabularyMemoryAdapter();
  const tx = coordinator(adapter);
  const canonicalPath = `${ROOT}/native-journal-finalize.json`;
  await tx._ensureParent(canonicalPath);
  const base = await seed(adapter, canonicalPath);
  await tx.appendJournalAction({ actionId: "native-finalize-action", payload: { kind: "remember" } });
  const journal = await tx.readJournalActions();
  assert.equal(journal.paths.length, 1);
  const final = await tx.flushReviewSession({
    actionId: "native-finalize",
    expectedJournalHash: journal.hash,
    expectedSummaryHash: null,
    finalize: true,
    preconditions: [{ storeId: "native-finalize-store", path: base.path, expectedRevision: base.revision, expectedHash: base.hash }],
  });

  assert.equal(final.status, "committed");
  assert.equal(await adapter.exists(journal.paths[0]), false);
  assert.deepEqual((await tx.readJournalActions()).actions, []);
  assert.equal((await tx.recoverLocal()).status, "clean");
});

test("journal action segment limit is enforced per packed file", async () => {
  const adapter = new MemoryDataAdapter();
  const tx = coordinator(adapter);
  await tx.appendJournalAction({ actionId: "large-a", payload: { content: "a".repeat(42 * 1024) } });
  await tx.appendJournalAction({ actionId: "large-b", payload: { content: "b".repeat(42 * 1024) } });
  const journal = await tx.readJournalActions();
  assert.equal(journal.actions.length, 2);
  assert.equal(journal.paths.length, 2);
  for (const path of journal.paths) {
    assert.ok(new TextEncoder().encode(await adapter.read(path)).byteLength <= 64 * 1024);
  }
  await assert.rejects(tx.appendJournalAction({ actionId: "too-large", payload: { content: "c".repeat(65 * 1024) } }),
    { code: "VOCAB_JOURNAL_SEGMENT_LIMIT" });
});

test("a malformed but safely scoped local pending intent blocks only its own store", async () => {
  const adapter = new MemoryDataAdapter();
  const blockedPath = `${ROOT}/blocked.json`;
  const unrelatedPath = `${ROOT}/unblocked.json`;
  const blockedBase = await seed(adapter, blockedPath);
  const unrelatedBase = await seed(adapter, unrelatedPath);
  const tx = coordinator(adapter);
  const invalidPayload = {
    schemaVersion: 1,
    kind: "vocabulary-transaction",
    deviceId: DEVICE,
    sessionId: SESSION,
    txId: "bad-intent",
    actionId: "bad-action",
    mutations: [{ operation: "write", storeId: "blocked-store", path: blockedPath }],
  };
  await adapter.write(`${ROOT}/transactions/${DEVICE}/${SESSION}/bad-intent.pending.json`, canonicalStringify({
    payload: invalidPayload,
    payloadHash: canonicalHash(invalidPayload),
  }));

  const unrelated = await tx.commit({ actionId: "safe-other-store", writes: [write(unrelatedPath, "other-store", unrelatedBase, 2, "safe")] });
  assert.equal(unrelated.status, "committed");
  const blocked = await tx.commit({ actionId: "same-store", writes: [write(blockedPath, "blocked-store", blockedBase, 2, "must not apply")] });
  assert.equal(blocked.status, "conflict");
  assert.equal((await tx.readSnapshot(blockedPath)).text, blockedBase.text);
});

test("review summary checkpoints segment large payloads, atomically advance sequence with canonical writes, and finalize after exact preconditions", async () => {
  const adapter = new MemoryDataAdapter();
  const tx = coordinator(adapter);
  const path = `${ROOT}/review-checkpoint.json`;
  const base = await seed(adapter, path);
  await tx.appendJournalAction({ actionId: "checkpoint-action", payload: { kind: "remember", sequence: 1 } });
  const largeSummary = {
    schemaVersion: 1,
    sessionId: SESSION,
    flushedThroughSequence: 0,
    note: "vocabulary state ".repeat(7000),
  };
  const created = await tx.writeSessionSummary({ actionId: "summary-large", summary: largeSummary, expectedHash: null });
  assert.equal(created.status, "committed");
  const firstSummary = await tx.readSessionSummary();
  assert.equal(firstSummary.summary.note, largeSummary.note);
  assert.ok(firstSummary.paths.filter((item) => item.endsWith(".segment.json")).length >= 2);
  assert.equal((await tx.recoverLocal()).status, "clean", "summary.pending.json is not a transaction intent");
  await assert.rejects(tx.flushReviewSession({
    actionId: "invalid-checkpoint-no-store-write",
    expectedJournalHash: (await tx.readJournalActions()).hash,
    expectedSummaryHash: firstSummary.hash,
    updatedSummary: { schemaVersion: 1, sessionId: SESSION, flushedThroughSequence: 1, note: "no canonical write" },
  }), { code: "VOCAB_SUMMARY_CHECKPOINT_WITHOUT_CANONICAL_WRITES" });

  const current = await tx.readSnapshot(path);
  const canonicalWrite = write(path, "review-store", current, 2, "checkpointed");
  const checkpoint = await tx.flushReviewSession({
    actionId: "summary-checkpoint-1",
    writes: [canonicalWrite],
    expectedJournalHash: (await tx.readJournalActions()).hash,
    expectedSummaryHash: firstSummary.hash,
    updatedSummary: { schemaVersion: 1, sessionId: SESSION, flushedThroughSequence: 1, note: "compact checkpoint" },
  });
  assert.equal(checkpoint.status, "committed");
  const secondSummary = await tx.readSessionSummary();
  assert.equal(secondSummary.summary.flushedThroughSequence, 1);
  assert.equal(secondSummary.summary.note, "compact checkpoint");
  assert.ok(firstSummary.paths.filter((item) => item.endsWith(".segment.json")).every((item) => !adapter.files.has(item)),
    "old summary segments are deleted in the same verified checkpoint transaction");
  assert.equal((await tx.recoverLocal()).status, "clean");

  const canonical = await tx.readSnapshot(path);
  const finalized = await tx.flushReviewSession({
    actionId: "summary-finalize",
    expectedJournalHash: (await tx.readJournalActions()).hash,
    expectedSummaryHash: secondSummary.hash,
    finalize: true,
    preconditions: [{ storeId: "review-store", path, expectedRevision: canonical.revision, expectedHash: canonical.hash }],
  });
  assert.equal(finalized.status, "committed");
  assert.deepEqual((await tx.readJournalActions()).actions, []);
  assert.equal((await tx.readSessionSummary()).exists, false);
  assert.equal((await tx.recoverLocal()).status, "clean");
});
