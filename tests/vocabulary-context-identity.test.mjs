import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { canonicalStringify, hashText } = require("../plugin/vocabulary/canonical.cjs");
const { createContextSourceVerifier } = require("../plugin/vocabulary/context-source.cjs");
const { CONTEXT_ROOT, createVocabularyContextService } = require("../plugin/vocabulary/context-service.cjs");
const { partitionRecords } = require("../plugin/vocabulary/sharded-store.cjs");
const { createVocabularyRuntime } = require("../plugin/vocabulary/runtime.cjs");
const { VOCABULARY_PATH } = require("../plugin/vocabulary/service.cjs");

const FAMILY_WALK = 'en-family:v1:word:["walk"]';
const FAMILY_RUN = 'en-family:v1:word:["run"]';
const SOURCE_HASH = `sha256-v1:${"a".repeat(64)}`;
const PAGE_DIGEST = `sha256-v1:${"b".repeat(64)}`;
const CORE_VALUE = {
  schema: "pdf-web-reader-vocabulary",
  schemaVersion: 2,
  language: "en",
  revision: 1,
  records: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeAnchor(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "obreader-selection-anchor",
    anchorId: "anchor_0001",
    docKey: "0123456789ab",
    documentId: "vault://novel.pdf",
    sourceHash: SOURCE_HASH,
    pageIdentity: "page-002",
    pageIndexHint: 1,
    textPosition: { start: 10, end: 14 },
    exactQuote: "walk",
    prefix: "she ",
    suffix: " home",
    orderedPageIdentityDigest: PAGE_DIGEST,
    pageCount: 3,
    geometry: null,
    ...overrides,
  };
}

function snapshot(value) {
  const text = canonicalStringify(value);
  return { exists: true, text, value: JSON.parse(text), revision: value.revision, hash: hashText(text) };
}

class MemoryTransactions {
  constructor() {
    this.files = new Map([[VOCABULARY_PATH, snapshot(CORE_VALUE)]]);
    this.directories = new Set([""]);
    this.adapter = this;
    this.writeCount = 0;
  }

  async readSnapshot(path) {
    const saved = this.files.get(path);
    return saved ? clone(saved) : { exists: false, text: null, value: null, revision: 0, hash: null };
  }

  async exists(path) {
    return this.files.has(path) || this.directories.has(path) ||
      [...this.files.keys()].some((item) => item.startsWith(`${path}/`));
  }

  async read(path) {
    const saved = this.files.get(path);
    if (!saved) throw new Error(`missing file: ${path}`);
    return saved.text;
  }

  async write(path, text) {
    const value = JSON.parse(text);
    this.files.set(path, snapshot(value));
    this.writeCount += 1;
  }

  async rename(from, to) {
    const saved = this.files.get(from);
    if (!saved) throw new Error(`missing file: ${from}`);
    this.files.set(to, saved);
    this.files.delete(from);
  }

  async remove(path) {
    this.files.delete(path);
    this.directories.delete(path);
  }

  async mkdir(path) {
    this.directories.add(path);
  }

  async list(path) {
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/")).sort(),
      folders: [...this.directories].filter((item) => item.startsWith(prefix) && item !== path &&
        !item.slice(prefix.length).includes("/")).sort(),
    };
  }

  async commit({ writes = [], deletes = [], preconditions = [] } = {}) {
    for (const condition of preconditions) {
      const current = this.files.get(condition.path);
      if ((current?.revision || 0) !== condition.expectedRevision || (current?.hash || null) !== condition.expectedHash) {
        return { status: "conflict", conflicts: [{ storeId: condition.storeId, path: condition.path }] };
      }
    }
    for (const write of writes) {
      const current = this.files.get(write.path);
      if ((current?.revision || 0) !== write.expectedRevision || (current?.hash || null) !== write.expectedHash) {
        return { status: "conflict", conflicts: [{ storeId: write.storeId, path: write.path }] };
      }
    }
    for (const remove of deletes) {
      const current = this.files.get(remove.path);
      if ((current?.revision || 0) !== remove.expectedRevision || (current?.hash || null) !== remove.expectedHash) {
        return { status: "conflict", conflicts: [{ storeId: remove.storeId, path: remove.path }] };
      }
    }
    for (const write of writes) {
      const value = JSON.parse(write.text);
      this.files.set(write.path, snapshot(value));
      this.writeCount += 1;
    }
    for (const remove of deletes) this.files.delete(remove.path);
    return { status: "committed" };
  }
}

function makeVocabularyService(transaction, surfaceFamilies = { walk: FAMILY_WALK, walked: FAMILY_WALK,
  walking: FAMILY_WALK, run: FAMILY_RUN, comparable: FAMILY_RUN }) {
  const familyByKey = new Map([
    [FAMILY_WALK, { familyKey: FAMILY_WALK, type: "word", status: 2, records: [
      { key: "walk", surface: "walk" }, { key: "walks", surface: "walks" },
      { key: "walked", surface: "walked" }, { key: "walking", surface: "walking" },
    ] }],
    [FAMILY_RUN, { familyKey: FAMILY_RUN, type: "word", status: 2, records: [
      { key: "run", surface: "run" }, { key: "comparable", surface: "comparable" },
    ] }],
  ]);
  const familyForSurface = (surface) => {
    const familyKey = surfaceFamilies[surface];
    return familyKey ? familyByKey.get(familyKey) : undefined;
  };
  return {
    async getFamilyByKey(familyKey) { return familyByKey.get(familyKey); },
    async getFamily(surface) { return familyForSurface(surface); },
    async getFamilyEvidence(surface) {
      const identity = await transaction.readSnapshot(VOCABULARY_PATH);
      return {
        family: familyForSurface(surface),
        identity: {
          storeId: "vocabulary-core",
          path: VOCABULARY_PATH,
          exists: identity.exists,
          revision: identity.revision,
          hash: identity.hash,
        },
      };
    },
  };
}

function makeContextService({ transaction = new MemoryTransactions(), verifySource, maxBytes, now = () => "2026-10-18T10:00:00.000Z" } = {}) {
  const service = createVocabularyContextService({
    transaction,
    vocabularyService: makeVocabularyService(transaction),
    verifySource: verifySource || (async ({ anchor }) => ({
      status: "verified",
      sourceCurrent: true,
      pageCurrent: true,
      anchor: clone(anchor),
    })),
    now,
    ...(maxBytes == null ? {} : { maxBytes }),
  });
  return { service, transaction };
}

function makePageEvidence(anchor) {
  const orderedPageIdentities = ["page-001", "page-002", "page-003"];
  return {
    documentId: anchor.documentId,
    docKey: anchor.docKey,
    sourceHash: anchor.sourceHash,
    sourcePath: "Books/Novel.pdf",
    verified: true,
    orderedPageIdentities,
  };
}

function makeSourceFixture() {
  const anchor = makeAnchor();
  const state = {
    storedAnchor: clone(anchor),
    route: {
      documentId: anchor.documentId,
      docKey: anchor.docKey,
      source: { sourceHash: anchor.sourceHash },
      sourcePath: "Books/Novel.pdf",
    },
    evidence: makePageEvidence(anchor),
    existingFiles: new Set(["Books/Novel.pdf"]),
    responses: null,
    pageHashCalls: 0,
    fileLookups: [],
  };
  const verify = createContextSourceVerifier({
    anchorStore: { get: async () => clone(state.storedAnchor) },
    documentStore: { documentForIdentity: async () => clone(state.route) },
    getFileByPath: (path) => {
      state.fileLookups.push(path);
      return state.existingFiles.has(path) ? { path } : null;
    },
    getVerifiedSource: async () => {
      if (state.responses?.length) return clone(state.responses.shift());
      return clone(state.evidence);
    },
    hashOrderedPages: async () => {
      state.pageHashCalls += 1;
      return PAGE_DIGEST;
    },
  });
  return { anchor, state, verify };
}

test("Context IDs are stable for family, document, and Anchor identity, with duplicates and other sources handled explicitly", async () => {
  const { service, transaction } = makeContextService();
  const anchor = makeAnchor();
  const first = await service.saveContext({ familyKey: FAMILY_WALK, surface: "walk", sentence: "She walks home.", anchor });
  assert.equal(first.status, "committed");
  assert.equal(first.context.identity.familyKey, FAMILY_WALK);
  assert.equal(first.context.identity.documentId, anchor.documentId);
  assert.equal(first.context.identity.anchorId, anchor.anchorId);
  assert.equal(first.context.pageNumberHint, 2, "the page hint comes from Anchor.pageIndexHint + 1, not a guessed current page");

  const writesAfterFirst = transaction.writeCount;
  const repeated = await service.saveContext({ familyKey: FAMILY_WALK, surface: "walked", sentence: "A changed walked preview.", anchor });
  assert.equal(repeated.status, "existing");
  assert.equal(repeated.context.contextId, first.context.contextId);
  assert.equal(repeated.requiresUserEdit, true);
  assert.equal(transaction.writeCount, writesAfterFirst, "saving the same Anchor again creates no duplicate or write");

  const otherAnchor = makeAnchor({ anchorId: "anchor_0002", pageIdentity: "page-003", pageIndexHint: 2 });
  const otherDocument = makeAnchor({ documentId: "vault://other.pdf", docKey: "abcdef123456" });
  const otherFamily = await service.saveContext({ familyKey: FAMILY_RUN, surface: "run", sentence: "I run home.", anchor });
  const secondSource = await service.saveContext({ familyKey: FAMILY_WALK, surface: "walk", sentence: "She walks there.", anchor: otherAnchor });
  const secondDocument = await service.saveContext({ familyKey: FAMILY_WALK, surface: "walk", sentence: "She walks elsewhere.", anchor: otherDocument });
  assert.equal(new Set([
    first.context.contextId,
    otherFamily.context.contextId,
    secondSource.context.contextId,
    secondDocument.context.contextId,
  ]).size, 4, "changing any member of the family/document/Anchor tuple produces a distinct ID");

  const familyContexts = await service.listFamily(FAMILY_WALK);
  assert.equal(familyContexts.total, 3, "different Anchor IDs remain separate citations in one family");
  assert.deepEqual(new Set(familyContexts.contexts.map((item) => item.anchorId)), new Set(["anchor_0001", "anchor_0002"]));

  const changedSource = makeAnchor({ sourceHash: `sha256-v1:${"d".repeat(64)}` });
  await assert.rejects(
    service.saveContext({ familyKey: FAMILY_WALK, surface: "walk", sentence: "A stale walk source.", anchor: changedSource }),
    { code: "VOCAB_CONTEXT_ID_COLLISION" },
    "a changed source tuple cannot take over the same family/document/Anchor ID",
  );
  assert.equal((await service.listFamily(FAMILY_WALK)).total, 3);
});

test("Context sentence validation requires a whole family token and handles a PDF line-end hyphen", async () => {
  const { service } = makeContextService();
  assert.equal((await service.validateSentence({ familyKey: FAMILY_WALK, surface: "walk", sentence: "She is walking home." })).familyKey, FAMILY_WALK,
    "a saved inflected family surface is valid context for its canonical family");
  await assert.rejects(service.validateSentence({ familyKey: FAMILY_WALK, surface: "walk", sentence: "A nearby walkway is closed." }),
    (error) => error.code === "VOCAB_CONTEXT_SURFACE_NOT_IN_SENTENCE",
    "substring matches inside unrelated words are rejected");
  assert.equal((await service.validateSentence({ familyKey: FAMILY_RUN, surface: "comparable", sentence: "A compa-\nrable result." })).surface, "comparable",
    "PDF visual line-end hyphenation is rejoined before matching the selected vocabulary surface");
});

test("Context refuses missing, unverified, renamed, stale-page, and changed-Anchor evidence without writing", async () => {
  const anchor = makeAnchor();
  let result = { status: "missing", code: "VOCAB_CONTEXT_SOURCE_MISSING" };
  const { service, transaction } = makeContextService({ verifySource: async () => clone(result) });
  const input = { familyKey: FAMILY_WALK, surface: "walk", sentence: "I walk home.", anchor };

  await assert.rejects(service.saveContext(input), { code: "VOCAB_CONTEXT_SOURCE_MISSING" });
  result = { status: "unverified", sourceCurrent: false, pageCurrent: false };
  await assert.rejects(service.saveContext(input), { code: "VOCAB_CONTEXT_SOURCE_UNVERIFIED" });
  result = { status: "renamed", sourceCurrent: false, pageCurrent: false };
  await assert.rejects(service.saveContext(input), { code: "VOCAB_CONTEXT_SOURCE_RENAMED" });
  result = { status: "verified", sourceCurrent: true, pageCurrent: false, anchor };
  await assert.rejects(service.saveContext(input), { code: "VOCAB_CONTEXT_SOURCE_UNVERIFIED" });
  result = {
    status: "verified",
    sourceCurrent: true,
    pageCurrent: true,
    anchor: makeAnchor({ pageIdentity: "page-replaced" }),
  };
  await assert.rejects(service.saveContext(input), { code: "VOCAB_CONTEXT_SOURCE_MISMATCH" });
  assert.equal(transaction.writeCount, 0, "none of the rejected evidence states writes a Context shard");
});

test("Context source verification follows only current stored identity and rejects a stale rename route or changed page identity", async () => {
  const { anchor, state, verify } = makeSourceFixture();
  const verified = await verify(anchor);
  assert.equal(verified.status, "verified");
  assert.equal(verified.anchor.pageIndexHint, 1);
  assert.equal(state.pageHashCalls, 1, "verification hashes the existing ordered page identities only");

  state.route.sourcePath = "Books/Old-Name.pdf";
  assert.equal((await verify(anchor)).code, "VOCAB_CONTEXT_SOURCE_MISMATCH", "a stale path after a rename is refused");
  state.route.sourcePath = "Books/Novel.pdf";

  state.evidence.orderedPageIdentities[1] = "replacement-page";
  assert.equal((await verify(anchor)).code, "VOCAB_CONTEXT_CURRENT_SOURCE_NOT_VERIFIED");
  state.evidence = makePageEvidence(anchor);

  state.evidence.verified = false;
  assert.equal((await verify(anchor)).code, "VOCAB_CONTEXT_CURRENT_SOURCE_NOT_VERIFIED");
  state.evidence = makePageEvidence(anchor);

  state.responses = [
    makePageEvidence(anchor),
    { ...makePageEvidence(anchor), sourceHash: `sha256-v1:${"e".repeat(64)}` },
  ];
  assert.equal((await verify(anchor)).code, "VOCAB_CONTEXT_SOURCE_SESSION_CHANGED");
  assert.ok(state.fileLookups.every((path) => path === "Books/Novel.pdf" || path === "Books/Old-Name.pdf"));
});

test("an oversized Context record is rejected with an explicit shard-limit error", async () => {
  const { service, transaction } = makeContextService({ maxBytes: 512 });
  await assert.rejects(
    service.saveContext({
      familyKey: FAMILY_WALK,
      surface: "walk",
      sentence: `walk ${"x".repeat(2048)}`,
      anchor: makeAnchor(),
    }),
    { code: "VOCAB_SHARD_RECORD_TOO_LARGE" },
  );
  assert.equal(transaction.writeCount, 0, "an oversized record is rejected before any shard or manifest is committed");
});

test("shard partitioning and serialized contents do not depend on record insertion order", () => {
  const records = Array.from({ length: 36 }, (_, index) => ({
    id: `context:v1:${String(index).padStart(64, "0")}`,
    familyKey: FAMILY_WALK,
    sentence: `A citation sentence ${index}.`,
  }));
  const options = {
    storeId: "vocabulary-contexts-v1",
    root: CONTEXT_ROOT,
    kind: "context",
    idOf: (record) => record.id,
    maxRecords: 2,
    maxBytes: 2048,
  };
  const forward = partitionRecords({ ...options, records });
  const reverse = partitionRecords({ ...options, records: records.slice().reverse() });
  assert.deepEqual(
    forward.map(({ prefix, text }) => ({ prefix, text })),
    reverse.map(({ prefix, text }) => ({ prefix, text })),
  );
});

test("runtime wiring rejects Context saves when no verified-source adapter was supplied", async () => {
  const adapter = new MemoryTransactions();
  const personalService = {
    attachCoordinator: async () => {},
    async getFamilyByKey(familyKey) {
      return familyKey === FAMILY_WALK ? { familyKey, type: "word", status: 2 } : undefined;
    },
    async getFamilyEvidence(surface) {
      const identity = await runtime.coordinator.readSnapshot(VOCABULARY_PATH);
      return {
        family: surface === "walk" ? { familyKey: FAMILY_WALK, type: "word", status: 2 } : undefined,
        identity: {
          storeId: "vocabulary-core",
          path: VOCABULARY_PATH,
          exists: identity.exists,
          revision: identity.revision,
          hash: identity.hash,
        },
      };
    },
  };
  const runtime = createVocabularyRuntime({ adapter, personalService, deviceId: "test-device", sessionId: "test-session" });
  await assert.rejects(
    runtime.contexts.saveContext({
      familyKey: FAMILY_WALK,
      surface: "walk",
      sentence: "I walk home.",
      anchor: makeAnchor(),
    }),
    { code: "VOCAB_CONTEXT_SOURCE_UNVERIFIED" },
  );
  assert.equal(adapter.writeCount, 0, "runtime's default verifier fails closed before persistence");
});
