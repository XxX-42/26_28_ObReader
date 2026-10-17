import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { canonicalHash, canonicalStringify } = require("../plugin/vocabulary/canonical.cjs");
const { CONTEXT_ROOT, CONTEXT_STORE_ID, createVocabularyContextService } = require("../plugin/vocabulary/context-service.cjs");
const { createManifest, partitionRecords, VOCABULARY_DATA_ROOT } = require("../plugin/vocabulary/sharded-store.cjs");
const { VocabularyTransactionCoordinator } = require("../plugin/vocabulary/transactions.cjs");
const { VocabularyService, VOCABULARY_PATH } = require("../plugin/vocabulary/service.cjs");
const { VocabularyHistory } = require("../plugin/vocabulary/history.cjs");

const FAMILY = 'en-family:v1:word:["walk"]';
const FAMILY_2 = 'en-family:v1:word:["run"]';
const SHA = `sha256-v1:${"a".repeat(64)}`;
const sourceKey = (anchor) => `${anchor.anchorId}/${anchor.documentId}/${anchor.sourceHash}/${anchor.pageIdentity}`;

class MemoryTransactions {
  constructor() {
    this.files = new Map();
    this.directories = new Set([""]);
    this.adapter = this;
    const coreValue = {
      schema: "pdf-web-reader-vocabulary",
      schemaVersion: 2,
      language: "en",
      revision: 1,
      records: [],
    };
    const coreText = canonicalStringify(coreValue);
    this.files.set(VOCABULARY_PATH, {
      exists: true,
      text: coreText,
      value: coreValue,
      revision: coreValue.revision,
      hash: canonicalHash(coreValue),
    });
    this.actions = new Map();
    this.writeCount = 0;
    this.commits = [];
  }

  async readSnapshot(path) {
    const value = this.files.get(path);
    if (!value) return { exists: false, text: null, value: null, revision: 0, hash: null };
    return { ...value };
  }

  async exists(path) {
    return this.files.has(path) || this.directories.has(path) || [...this.files.keys()].some((item) => item.startsWith(`${path}/`));
  }

  async list(path) {
    const prefix = `${path}/`;
    const files = [...this.files.keys()].filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/"));
    const folders = [...this.directories].filter((item) => item.startsWith(prefix) && item !== path && !item.slice(prefix.length).includes("/"));
    return { files, folders };
  }

  async commit({ actionId, writes = [], deletes = [], historySummary = null, entities = [], preconditions = [] } = {}) {
    const fingerprint = canonicalStringify({ writes, deletes, historySummary, entities, preconditions });
    if (this.actions.has(actionId)) {
      assert.equal(this.actions.get(actionId), fingerprint, "a stable action ID cannot be reused for a different payload");
      return { status: "duplicate" };
    }
    for (const write of writes) {
      const current = this.files.get(write.path);
      const revision = current?.revision || 0;
      const hash = current?.hash || null;
      if (revision !== write.expectedRevision || hash !== write.expectedHash) {
        return { status: "conflict", conflicts: [{ storeId: write.storeId, path: write.path }] };
      }
    }
    for (const remove of deletes) {
      const current = this.files.get(remove.path);
      if ((current?.revision || 0) !== remove.expectedRevision || (current?.hash || null) !== remove.expectedHash) {
        return { status: "conflict", conflicts: [{ storeId: remove.storeId, path: remove.path }] };
      }
    }
    for (const condition of preconditions) {
      const current = this.files.get(condition.path);
      if ((current?.revision || 0) !== condition.expectedRevision || (current?.hash || null) !== condition.expectedHash) {
        return { status: "conflict", conflicts: [{ storeId: condition.storeId, path: condition.path }] };
      }
    }
    for (const write of writes) {
      const value = JSON.parse(write.text);
      assert.ok(value.revision > write.expectedRevision);
      assert.equal(canonicalStringify(value), write.text);
      this.files.set(write.path, {
        exists: true,
        text: write.text,
        value,
        revision: value.revision,
        hash: canonicalHash(value),
      });
      this.writeCount += 1;
    }
    for (const remove of deletes) this.files.delete(remove.path);
    this.actions.set(actionId, fingerprint);
    this.commits.push({ actionId, writes: writes.map((write) => write.path), historySummary });
    return { status: "committed", actionId };
  }
}

class MemoryDataAdapter {
  constructor() {
    this.files = new Map();
    this.directories = new Set([""]);
    this.writeCount = 0;
  }

  async exists(path) {
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path) {
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent && !this.directories.has(parent)) throw new Error("missing parent: " + parent);
    this.directories.add(path);
  }

  async read(path) {
    if (!this.files.has(path)) throw new Error("missing file: " + path);
    return this.files.get(path);
  }

  async write(path, text) {
    this.writeCount += 1;
    this.files.set(path, text);
  }

  async rename(from, to) {
    if (!this.files.has(from)) throw new Error("missing source: " + from);
    if (this.files.has(to)) throw new Error("target exists: " + to);
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
  }

  async remove(path) {
    this.files.delete(path);
    this.directories.delete(path);
  }

  async list(path) {
    const prefix = path ? path + "/" : "";
    const files = [...this.files.keys()].filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/"));
    const folders = [...this.directories].filter((item) => item.startsWith(prefix) && item !== path &&
      !item.slice(prefix.length).includes("/"));
    return { files, folders };
  }
}

function makeAnchor(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "obreader-selection-anchor",
    anchorId: "anchor_0001",
    docKey: "0123456789ab",
    documentId: "vault://novel.pdf",
    sourceHash: SHA,
    pageIdentity: "page-identity-001",
    pageIndexHint: 0,
    textPosition: { start: 10, end: 15 },
    exactQuote: "walks",
    prefix: "she ",
    suffix: " home",
    orderedPageIdentityDigest: SHA,
    pageCount: 1,
    geometry: null,
    ...overrides,
  };
}

function makeService({ transaction = new MemoryTransactions(), anchors = new Map(), maxBytes, verifySource, now = () => "2026-10-18T10:00:00Z" } = {}) {
  const verifierCalls = [];
  const families = new Map([
    [FAMILY, { familyKey: FAMILY, type: "word", status: 2, records: [
      { key: "walk", surface: "walk" }, { key: "walks", surface: "walks" },
      { key: "walked", surface: "walked" }, { key: "walking", surface: "walking" },
    ] }],
    [FAMILY_2, { familyKey: FAMILY_2, type: "word", status: 2, records: [
      { key: "run", surface: "run" }, { key: "runs", surface: "runs" }, { key: "running", surface: "running" },
    ] }],
  ]);
  const vocabularyService = {
    async getFamilyByKey(familyKey, options) {
      assert.deepEqual(options, { includeRecords: false });
      const family = families.get(familyKey);
      if (!family) return undefined;
      const { records: _records, ...summary } = family;
      return summary;
    },
    async getFamily(surface) {
      return surface === "walk" || surface === "walks" || surface === "walked" || surface === "walking"
        ? families.get(FAMILY) : surface === "run" || surface === "runs" || surface === "running" ? families.get(FAMILY_2) : undefined;
    },
    async getFamilyEvidence(surface) {
      const family = surface === "walk" || surface === "walks" || surface === "walked" || surface === "walking"
        ? families.get(FAMILY) : surface === "run" || surface === "runs" || surface === "running" ? families.get(FAMILY_2) : undefined;
      const snapshot = await transaction.readSnapshot(VOCABULARY_PATH);
      return {
        family,
        identity: {
          storeId: "vocabulary-core",
          path: VOCABULARY_PATH,
          exists: snapshot.exists,
          revision: snapshot.revision,
          hash: snapshot.hash,
        },
      };
    },
  };
  const service = createVocabularyContextService({
    transaction,
    vocabularyService,
    verifySource: verifySource || (async ({ anchor }) => {
      verifierCalls.push(anchor);
      const verified = anchors.get(sourceKey(anchor)) || anchors.get(anchor.anchorId) || null;
      return verified ? { status: "verified", sourceCurrent: true, pageCurrent: true, anchor: verified } :
        { status: "missing", code: "VOCAB_CONTEXT_SOURCE_MISSING" };
    }),
    now,
    ...(maxBytes == null ? {} : { maxBytes }),
  });
  return { service, transaction, verifierCalls };
}

function rewriteContextRecords(transaction, transform) {
  const manifestPath = `${CONTEXT_ROOT}/manifest.json`;
  const savedManifest = transaction.files.get(manifestPath);
  assert.ok(savedManifest, "the Context fixture has a manifest");
  const records = [];
  for (const entry of savedManifest.value.shards) {
    const saved = transaction.files.get(entry.path);
    assert.ok(saved, "the Context fixture has each active shard");
    records.push(...Object.values(saved.value.records).map((record) => transform(structuredClone(record))));
  }
  const partitions = partitionRecords({
    records, storeId: CONTEXT_STORE_ID, root: CONTEXT_ROOT, kind: "context", idOf: (record) => record.contextId,
  });
  const manifest = createManifest({
    storeId: CONTEXT_STORE_ID, kind: "context", revision: savedManifest.revision + 1, shards: partitions,
  });
  for (const part of partitions) {
    transaction.files.set(part.path, {
      exists: true, text: part.text, value: part.value, revision: part.value.revision, hash: canonicalHash(part.value),
    });
  }
  const text = canonicalStringify(manifest);
  transaction.files.set(manifestPath, {
    exists: true, text, value: manifest, revision: manifest.revision, hash: canonicalHash(manifest),
  });
}

test("Context save verifies a complete existing Anchor, deduplicates its stable tuple, and writes under the vocabulary data root", async () => {
  const anchor = makeAnchor();
  const { service, transaction, verifierCalls } = makeService({ anchors: new Map([[anchor.anchorId, anchor]]) });

  const first = await service.saveContext({ familyKey: FAMILY, surface: "walk", sentence: " She walks home. ", anchor });
  assert.equal(first.status, "committed");
  assert.equal(first.context.sentence, "She walks home.");
  assert.equal(first.context.createdAt, "2026-10-18T10:00:00.000Z");
  assert.equal(first.context.identity.familyKey, FAMILY);
  assert.equal(first.context.identity.sourceIdentity.sourceHash, SHA);
  assert.equal(first.context.identity.sourceIdentity.pageIdentity, anchor.pageIdentity);
  assert.equal(first.context.identity.anchorId, anchor.anchorId);
  assert.equal(first.context.surface, "walk");
  assert.equal(first.context.docKey, anchor.docKey);
  assert.equal(first.context.pageNumberHint, 1);
  assert.equal(first.context.sourceFingerprint, SHA);
  assert.equal(verifierCalls.length, 1);
  assert.ok(transaction.commits[0].writes.every((path) => path.startsWith(`${VOCABULARY_DATA_ROOT}/contexts/`)));
  assert.ok(!transaction.commits[0].writes.some((path) => path.includes("en.vocab.json")));

  const writesBefore = transaction.writeCount;
  const repeated = await service.saveContext({ familyKey: FAMILY, surface: "walk", sentence: "She walks home again.", anchor });
  assert.equal(repeated.status, "existing");
  assert.equal(repeated.context.contextId, first.context.contextId);
  assert.equal(repeated.sentenceMatches, false);
  assert.equal(repeated.requiresUserEdit, true, "a preview-text difference is surfaced for explicit user editing");
  assert.equal(transaction.writeCount, writesBefore, "deduplication performs zero writes");
});

test("Context IDs hash only family, document, and Anchor IDs; full source tuple collisions fail closed", async () => {
  const anchor = makeAnchor();
  const differentAnchor = makeAnchor({ anchorId: "anchor_0002" });
  const differentDocument = makeAnchor({ documentId: "vault://other.pdf" });
  const changedSource = makeAnchor({ sourceHash: `sha256-v1:${"b".repeat(64)}` });
  const changedPage = makeAnchor({ pageIdentity: "page-identity-002" });
  const { service } = makeService({ anchors: new Map([
    [sourceKey(anchor), anchor],
    [sourceKey(differentAnchor), differentAnchor],
    [sourceKey(differentDocument), differentDocument],
    [sourceKey(changedSource), changedSource],
    [sourceKey(changedPage), changedPage],
  ]) });
  const a = await service.saveContext({ familyKey: FAMILY, surface: "walk", sentence: "She walks home.", anchor });
  const b = await service.saveContext({ familyKey: FAMILY, surface: "walk", sentence: "She walks home.", anchor: differentAnchor });
  const c = await service.saveContext({ familyKey: FAMILY, surface: "walk", sentence: "She walks home.", anchor: differentDocument });
  const d = await service.saveContext({ familyKey: FAMILY_2, surface: "run", sentence: "I run home.", anchor });
  assert.equal(new Set([a.context.contextId, b.context.contextId, c.context.contextId, d.context.contextId]).size, 4);
  await assert.rejects(service.saveContext({ familyKey: FAMILY, surface: "walk", sentence: "She walks home.", anchor: changedSource }),
    { code: "VOCAB_CONTEXT_ID_COLLISION" });
  await assert.rejects(service.saveContext({ familyKey: FAMILY, surface: "walk", sentence: "She walks home.", anchor: changedPage }),
    { code: "VOCAB_CONTEXT_ID_COLLISION" });
  await assert.rejects(service.saveContext({ familyKey: 'en-family:v1:word:["missing"]', surface: "walk", sentence: "x", anchor }),
    { code: "VOCAB_CONTEXT_SURFACE_FAMILY_MISMATCH" });
});

test("family Context list is stable and paginated; get and verifySource use the stored Anchor without PDF scanning", async () => {
  const anchors = Array.from({ length: 3 }, (_, index) => makeAnchor({
    anchorId: `anchor_000${index + 1}`,
    textPosition: { start: 10 + index, end: 15 + index },
    exactQuote: `walks${index}`,
  }));
  const { service, verifierCalls } = makeService({ anchors: new Map(anchors.map((anchor) => [anchor.anchorId, anchor])) });
  const saved = [];
  for (const [index, anchor] of anchors.entries()) {
    saved.push(await service.saveContext({ familyKey: FAMILY, surface: "walk", sentence: `Sentence with walk ${index}.`, anchor }));
  }
  const first = await service.listFamily(FAMILY, { limit: 2 });
  assert.equal(first.total, 3);
  assert.equal(first.contexts.length, 2);
  assert.ok(first.nextCursor);
  const second = await service.listFamily(FAMILY, { limit: 2, cursor: first.nextCursor });
  assert.equal(second.contexts.length, 1);
  assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.contexts, ...second.contexts].map((item) => item.contextId).sort(),
    saved.map((item) => item.context.contextId).sort());
  const context = await service.getContext(saved[0].context.contextId);
  assert.equal(context.contextId, saved[0].context.contextId);
  assert.deepEqual(await service.verifySource(context.contextId), {
    status: "verified", valid: true, contextId: context.contextId,
  });
  assert.equal(verifierCalls.length, 4, "save and explicit revalidation call only the injected Anchor verifier");
  assert.ok(verifierCalls.every((item) => item.anchorId));
  await assert.rejects(service.listFamily(FAMILY, { limit: 101 }), { code: "VOCAB_CONTEXT_PAGE_SIZE_INVALID" });
  await assert.rejects(service.listFamily(FAMILY, { cursor: "not-a-cursor" }), { code: "VOCAB_CONTEXT_CURSOR_INVALID" });
});

test("missing or changed source identity is explicit, and an overlarge sentence is rejected without truncation", async () => {
  const anchor = makeAnchor();
  const changed = makeAnchor({ sourceHash: `sha256-v1:${"c".repeat(64)}` });
  const { service, transaction } = makeService({
    anchors: new Map([[anchor.anchorId, changed]]),
    maxBytes: 1024,
  });
  await assert.rejects(service.saveContext({ familyKey: FAMILY, surface: "walk", sentence: "She walks home.", anchor }),
    { code: "VOCAB_CONTEXT_SOURCE_MISMATCH" });
  assert.equal(transaction.writeCount, 0);

  const validService = makeService({ anchors: new Map([[anchor.anchorId, anchor]]), maxBytes: 1024 });
  await assert.rejects(validService.service.saveContext({
    familyKey: FAMILY, surface: "walk", sentence: `walk ${"x".repeat(4096)}`, anchor,
  }), { code: "VOCAB_SHARD_RECORD_TOO_LARGE" });
  assert.equal(validService.transaction.writeCount, 0);
  assert.equal((await validService.service.listFamily(FAMILY)).total, 0);
});

test("source revalidation reports missing Context and missing Anchor distinctly", async () => {
  const anchor = makeAnchor();
  const { service } = makeService({ anchors: new Map([[anchor.anchorId, anchor]]) });
  assert.deepEqual(await service.verifySource("context:v1:missing"), {
    status: "missing", valid: false, contextId: "context:v1:missing",
  });
});

test("Context requires current route and page evidence, and reports renamed or expired source explicitly", async () => {
  const anchor = makeAnchor();
  let sourceState = "verified";
  const { service } = makeService({
    anchors: new Map([[anchor.anchorId, anchor]]),
    verifySource: async () => sourceState === "verified"
      ? { status: "verified", sourceCurrent: true, pageCurrent: true, anchor }
      : sourceState === "renamed"
        ? { status: "renamed", code: "VOCAB_CONTEXT_SOURCE_RENAMED" }
        : { status: "expired", code: "VOCAB_CONTEXT_SOURCE_EXPIRED" },
  });
  const saved = await service.saveContext({ familyKey: FAMILY, surface: "walk", sentence: "She walks home.", anchor });
  sourceState = "renamed";
  assert.deepEqual(await service.verifySource(saved.context.contextId), {
    status: "invalid", valid: false, contextId: saved.context.contextId, code: "VOCAB_CONTEXT_SOURCE_RENAMED",
  });
  sourceState = "expired";
  await assert.rejects(service.saveContext({ familyKey: FAMILY, surface: "walk", sentence: "She walks home.", anchor }),
    { code: "VOCAB_CONTEXT_SOURCE_EXPIRED" });
});

test("Context save, reopen, dedupe, and partial-manifest failure use the real transaction coordinator", async () => {
  const adapter = new MemoryDataAdapter();
  let transactionId = 0;
  const transaction = new VocabularyTransactionCoordinator({
    adapter,
    deviceId: "context-device",
    sessionId: "context-tx-session",
    makeId: () => "context-tx-" + (++transactionId),
  });
  new VocabularyHistory({ coordinator: transaction, makeId: () => "context-history-" + (++transactionId) });
  const anchor = makeAnchor();
  const vocabularyService = new VocabularyService({
    adapter,
    coordinator: transaction,
    makeId: () => "context-core-record",
    now: () => 1000,
  });
  await vocabularyService.upsertTerm("walk", { status: 2 });
  const makeRealService = () => createVocabularyContextService({
    transaction,
    vocabularyService,
    verifySource: async ({ anchor: supplied }) => ({
      status: "verified", sourceCurrent: true, pageCurrent: true, anchor: supplied,
    }),
    now: () => "2026-10-18T10:00:00.000Z",
  });

  const firstService = makeRealService();
  const first = await firstService.saveContext({ familyKey: FAMILY, surface: "walk", sentence: "I walk home.", anchor });
  assert.equal(first.status, "committed");
  const writesAfterFirstSave = adapter.writeCount;
  const reopenedService = makeRealService();
  assert.equal((await reopenedService.getContext(first.context.contextId)).contextId, first.context.contextId);
  const duplicate = await reopenedService.saveContext({
    familyKey: FAMILY, surface: "walk", sentence: "A changed walk preview sentence.", anchor,
  });
  assert.equal(duplicate.status, "existing");
  assert.equal(duplicate.requiresUserEdit, true);
  assert.equal(adapter.writeCount, writesAfterFirstSave, "a deduplicated save performs no DataAdapter writes");

  const manifestPath = "00_Archive/21_VocabularyData/contexts/manifest.json";
  const manifest = (await transaction.readSnapshot(manifestPath)).value;
  assert.ok(manifest.shards.length > 0);
  await adapter.remove(manifest.shards[0].path);
  await assert.rejects(reopenedService.listFamily(FAMILY), { code: "VOCAB_SHARD_MISSING" });
});

test("real core snapshot preconditions reject a Context save when the family is deleted or replaced after lookup", async (t) => {
  for (const race of ["delete", "replace"]) {
    await t.test(race, async () => {
      const adapter = new MemoryDataAdapter();
      let transactionId = 0;
      const coordinator = new VocabularyTransactionCoordinator({
        adapter,
        deviceId: `context-race-${race}`,
        sessionId: `context-race-session-${race}`,
        makeId: () => `context-race-tx-${++transactionId}`,
      });
      new VocabularyHistory({ coordinator, makeId: () => `context-race-history-${++transactionId}` });
      const vocabularyService = new VocabularyService({
        adapter,
        coordinator,
        makeId: () => `context-race-core-${++transactionId}`,
        now: () => 1000 + transactionId,
      });
      await vocabularyService.upsertTerm("walk", { status: 2 });
      const anchor = makeAnchor();
      const realTransaction = {
        adapter,
        readSnapshot: (path) => coordinator.readSnapshot(path),
        commit: async (input) => {
          assert.equal(input.preconditions?.length, 1, "Context save carries the paired core snapshot precondition");
          assert.equal(input.preconditions[0].path, VOCABULARY_PATH);
          if (race === "delete") adapter.files.delete(VOCABULARY_PATH);
          else adapter.files.set(VOCABULARY_PATH, `${adapter.files.get(VOCABULARY_PATH)} `);
          return coordinator.commit(input);
        },
      };
      const contextService = createVocabularyContextService({
        transaction: realTransaction,
        vocabularyService,
        verifySource: async ({ anchor: supplied }) => ({
          status: "verified", sourceCurrent: true, pageCurrent: true, anchor: supplied,
        }),
        now: () => "2026-10-18T10:00:00.000Z",
      });

      const result = await contextService.saveContext({
        familyKey: FAMILY, surface: "walk", sentence: "I walk home.", anchor,
      });
      assert.equal(result.status, "conflict");
      assert.ok(result.conflicts.some((conflict) => conflict.storeId === "vocabulary-core" && conflict.path === VOCABULARY_PATH));
      assert.deepEqual([...adapter.files.keys()].filter((path) => path.startsWith(`${CONTEXT_ROOT}/`)), [],
        "a raced core deletion/replacement cannot leave an orphan Context shard or manifest");
    });
  }
});

test("Context reads reject malformed domain records and missing family references even when shard hashes are valid", async () => {
  const anchor = makeAnchor();
  const malformed = makeService({ anchors: new Map([[anchor.anchorId, anchor]]) });
  const savedMalformed = await malformed.service.saveContext({
    familyKey: FAMILY, surface: "walk", sentence: "She walks home.", anchor,
  });
  rewriteContextRecords(malformed.transaction, (record) => ({ ...record, pageIdentity: "another-page" }));
  await assert.rejects(malformed.service.getContext(savedMalformed.context.contextId), {
    code: "VOCAB_CONTEXT_IDENTITY_MISMATCH",
  });
  await assert.rejects(malformed.service.listFamily(FAMILY), {
    code: "VOCAB_CONTEXT_IDENTITY_MISMATCH",
  });

  const missing = makeService({ anchors: new Map([[anchor.anchorId, anchor]]) });
  const savedMissing = await missing.service.saveContext({
    familyKey: FAMILY, surface: "walk", sentence: "She walks home.", anchor,
  });
  rewriteContextRecords(missing.transaction, (record) => {
    const familyKey = 'en-family:v1:word:["not-present"]';
    const identity = { ...record.identity, familyKey };
    const contextId = `context:v1:${canonicalHash({ familyKey, documentId: record.documentId, anchorId: record.anchorId }).slice("sha256-v1:".length)}`;
    return { ...record, familyKey, identity, contextId };
  });
  await assert.rejects(missing.service.getContext(savedMissing.context.contextId), {
    code: "VOCAB_CONTEXT_FAMILY_MISSING",
  });
});

test("Context save refuses to overwrite orphan shard files after its manifest disappears", async () => {
  const firstAnchor = makeAnchor();
  const secondAnchor = makeAnchor({
    anchorId: "anchor_after_manifest_loss",
    textPosition: { start: 21, end: 26 },
    exactQuote: "walks",
  });
  const transaction = new MemoryTransactions();
  const { service } = makeService({
    transaction,
    anchors: new Map([[firstAnchor.anchorId, firstAnchor], [secondAnchor.anchorId, secondAnchor]]),
  });
  const first = await service.saveContext({ familyKey: FAMILY, surface: "walk", sentence: "She walks home.", anchor: firstAnchor });
  assert.equal(first.status, "committed");
  const manifestPath = `${CONTEXT_ROOT}/manifest.json`;
  const manifest = transaction.files.get(manifestPath);
  assert.ok(manifest?.exists);
  transaction.files.delete(manifestPath);
  const writesBefore = transaction.writeCount;

  await assert.rejects(service.saveContext({
    familyKey: FAMILY, surface: "walk", sentence: "She walks home again.", anchor: secondAnchor,
  }), { code: "VOCAB_SHARD_MANIFEST_MISSING" });
  assert.equal(transaction.writeCount, writesBefore, "a save does not replace unindexed shard data with a new manifest");
  assert.equal(transaction.files.has(manifestPath), false);
});
