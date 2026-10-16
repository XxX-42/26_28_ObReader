import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  VocabularyService,
  VocabularyStoreError,
  normalizeTermKey,
  VOCABULARY_PATH,
} = require("../plugin/vocabulary/service.cjs");

class MemoryAdapter {
  constructor({ delayMs = 0 } = {}) {
    this.files = new Map();
    this.directories = new Set([""]);
    this.delayMs = delayMs;
    this.activeWrites = 0;
    this.maxActiveWrites = 0;
    this.writeCount = 0;
    this.failRename = null;
    this.failWrite = null;
    this.afterWrite = null;
    this.beforeRename = null;
    this.afterRename = null;
    this.overwriteRename = false;
    this.corruptRead = null;
  }

  async exists(path) {
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path) {
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent && !this.directories.has(parent)) throw new Error(`missing parent: ${parent}`);
    this.directories.add(path);
  }

  async read(path) {
    if (!this.files.has(path)) throw new Error(`missing file: ${path}`);
    if (this.corruptRead?.(path, this.files.get(path))) return `${this.files.get(path)} `;
    return this.files.get(path);
  }

  async write(path, text) {
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    this.writeCount += 1;
    try {
      if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      this.files.set(path, text);
      await this.afterWrite?.(path, text, this);
      if (this.failWrite?.(path)) throw new Error("simulated write failure after partial bytes");
    } finally {
      this.activeWrites -= 1;
    }
  }

  async rename(from, to) {
    if (this.failRename?.(from, to)) throw new Error("simulated rename failure");
    if (!this.files.has(from)) throw new Error(`missing source: ${from}`);
    if (this.files.has(to) && !this.overwriteRename) throw new Error(`target exists: ${to}`);
    await this.beforeRename?.(from, to, this);
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
    await this.afterRename?.(from, to, this);
  }

  async remove(path) {
    this.files.delete(path);
    this.directories.delete(path);
  }
}

function makeService(adapter, extra = {}) {
  let counter = 0;
  let now = 1000;
  return new VocabularyService({
    adapter,
    makeId: () => `test-${++counter}`,
    now: () => ++now,
    ...extra,
  });
}

function snapshot(adapter) {
  return JSON.parse(adapter.files.get(VOCABULARY_PATH));
}

test("surface key normalization is conservative and does not lemmatize", () => {
  assert.equal(normalizeTermKey("  Abandoned  "), "abandoned");
  assert.equal(normalizeTermKey("Take   care of"), "take care of");
  assert.equal(normalizeTermKey("ﬁnd ﬂow ﬃxture ﬄower"), "find flow ffixture fflower");
  assert.equal(normalizeTermKey("don’t"), "don't");
  assert.equal(normalizeTermKey("well-being"), "well-being");
  assert.equal(normalizeTermKey("found"), "found");
  assert.equal(normalizeTermKey("saw"), "saw");
  assert.equal(normalizeTermKey("你好"), "");
  assert.equal(normalizeTermKey("bad,term"), "");
  assert.equal(normalizeTermKey("'hello"), "");
  assert.equal(normalizeTermKey("well--being"), "");
});

test("undefined differs from KNOWN and statuses 1 through 5 persist", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.load();
  assert.equal(service.getRevision(), 0);
  assert.equal(await service.getTerm("abandoned"), undefined);
  for (const status of [1, 2, 3, 4, 5]) {
    const record = await service.setStatus("abandoned", status);
    assert.equal(record.status, status);
  }
  assert.equal(service.getRevision(), 5);
  const known = await service.getTerm("abandoned");
  assert.equal(known.status, 5);
  assert.equal(known.source, "user");
  assert.equal(snapshot(adapter).records.find((record) => record.key === "abandoned").status, 5);
  assert.equal((await service.queryLearningTerms()).length, 0);
});

test("KNOWN remains a durable tombstone and ordinary imports cannot resurrect it", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.setStatus("abandoned", 5);
  const csv = await service.importCsv("term,status\nabandoned,1\nnewcomer,1");
  assert.deepEqual(csv, {
    total: 2,
    imported: 1,
    updated: 0,
    skippedExisting: 0,
    skippedKnown: 1,
    invalid: 0,
  });
  const json = await service.importJson([{ surface: "abandoned", type: "word", status: 1 }]);
  assert.equal(json.skippedKnown, 1);
  assert.equal((await service.getTerm("abandoned")).status, 5);
  assert.ok(snapshot(adapter).records.some((record) => record.key === "abandoned" && record.status === 5));
  assert.ok(await service.exportJson());
});

test("CSV parser preserves quoted commas, escaped quotes, and CRLF rows", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  const result = await service.importCsv(
    'term,status,translation,note\r\nbook,2,"a comma, inside","He said ""hello"""\r\n',
  );
  assert.equal(result.total, 1);
  assert.equal(result.imported, 1);
  const record = await service.getTerm("book");
  assert.equal(record.status, 2);
  assert.equal(record.translation, "a comma, inside");
  assert.equal(record.note, 'He said "hello"');
});

test("CSV parser rejects quotes inside unquoted fields and text after a closing quote", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  const malformed = await service.importCsv('term,note\nbook,not"quoted\n');
  assert.deepEqual(malformed, { total: 1, imported: 0, updated: 0, skippedExisting: 0, skippedKnown: 0, invalid: 1 });
  const trailing = await service.importCsv('term,note\nbook,"quoted"suffix\n');
  assert.deepEqual(trailing, { total: 1, imported: 0, updated: 0, skippedExisting: 0, skippedKnown: 0, invalid: 1 });
  assert.equal(await service.getTerm("book"), undefined);
});

test("headerless one-column CSV preserves first terms named word, key, and term", async () => {
  const service = makeService(new MemoryAdapter());
  const result = await service.importCsv("word\nkey\nterm\nbook\n");
  assert.equal(result.imported, 4);
  for (const word of ["word", "key", "term", "book"]) assert.ok(await service.getTerm(word));
});

test("import policies preserve local records unless their explicit override is enabled", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.setStatus("familiar", 4);
  await service.setNote("familiar", "local note");
  const skipped = await service.importJson([{ surface: "familiar", status: 1, note: "imported" }]);
  assert.equal(skipped.skippedExisting, 1);
  assert.equal((await service.getTerm("familiar")).note, "local note");
  const updated = await service.importJson(
    [{ surface: "familiar", status: 2, note: "imported" }],
    { overwriteExisting: true },
  );
  assert.equal(updated.updated, 1);
  assert.equal((await service.getTerm("familiar")).status, 2);
  assert.equal((await service.getTerm("familiar")).source, "import");
  await service.setStatus("familiar", 5);
  const knownSkipped = await service.importJson(
    [{ surface: "familiar", status: 1 }],
    { overwriteExisting: true },
  );
  assert.equal(knownSkipped.skippedKnown, 1);
  const knownUpdated = await service.importJson(
    [{ surface: "familiar", status: 2 }],
    { overwriteKnown: true },
  );
  assert.equal(knownUpdated.updated, 1);
  assert.equal((await service.getTerm("familiar")).status, 2);
});

test("CSV and JSON import report invalid rows instead of silently normalizing them", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  const overlongPhrase = Array(13).fill("long").join(" ");
  const result = await service.importCsv(`term,status\nvalid,1\ninvalid!,2\nother,6\n${overlongPhrase},1\n`);
  assert.deepEqual(result, {
    total: 4,
    imported: 1,
    updated: 0,
    skippedExisting: 0,
    skippedKnown: 0,
    invalid: 3,
  });
  const malformed = await service.importCsv('term,note\n"unfinished');
  assert.equal(malformed.invalid, 1);
  const malformedJson = await service.importJson("{");
  assert.equal(malformedJson.invalid, 1);
});

test("export/import JSON round-trips term status and annotations", async () => {
  const firstAdapter = new MemoryAdapter();
  const first = makeService(firstAdapter);
  await first.setStatus("take care of", 3);
  await first.setTranslation("take care of", "look after");
  await first.setNote("take care of", "phrase");
  const exported = await first.exportJson();
  const second = makeService(new MemoryAdapter());
  const result = await second.importJson(exported);
  assert.equal(result.imported, 1);
  const restored = await second.getTerm("take care of");
  assert.equal(restored.type, "phrase");
  assert.equal(restored.status, 3);
  assert.equal(restored.translation, "look after");
  assert.equal(restored.note, "phrase");
});

test("quoted CSV export round-trips commas, quotes, line breaks, and statuses", async () => {
  const first = makeService(new MemoryAdapter());
  await first.upsertTerm("take care of", {
    type: "phrase", status: 3, translation: "watch, \"look after\"", note: "line one\nline two",
  });
  const csv = await first.exportCsv();
  const second = makeService(new MemoryAdapter());
  const stats = await second.importCsv(csv);
  assert.equal(stats.imported, 1);
  const restored = await second.getTerm("take care of");
  assert.equal(restored.type, "phrase");
  assert.equal(restored.status, 3);
  assert.equal(restored.translation, "watch, \"look after\"");
  assert.equal(restored.note, "line one\nline two");
});

test("CSV export neutralizes formula-leading text and preserves it on a local round-trip", async () => {
  const source = makeService(new MemoryAdapter());
  await source.upsertTerm("equation", {
    translation: '=HYPERLINK("https://example.invalid","click")',
    note: " @SUM(1,2)",
  });
  await source.upsertTerm("apostrophe", { note: "'=literal text" });
  await source.upsertTerm("apostrophes", { note: "''=two literal marks" });
  const csv = await source.exportCsv();
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes("' @SUM"));

  const destination = makeService(new MemoryAdapter());
  await destination.importCsv(csv);
  const record = await destination.getTerm("equation");
  assert.equal(record.translation, '=HYPERLINK("https://example.invalid","click")');
  assert.equal(record.note, " @SUM(1,2)");
  assert.equal((await destination.getTerm("apostrophe")).note, "'=literal text");
  assert.equal((await destination.getTerm("apostrophes")).note, "''=two literal marks");
});

test("imports and vocabulary fields have explicit size limits", async () => {
  const service = makeService(new MemoryAdapter());
  await assert.rejects(service.importJson("x".repeat(8 * 1024 * 1024 + 1)), /supported input size/);
  await assert.rejects(service.upsertTerm("bounded", { note: "x".repeat(4097) }), /supported field size/);
  const tooManyRows = `term\n${"book\n".repeat(25001)}`;
  const result = await service.importCsv(tooManyRows);
  assert.equal(result.imported, 0);
  assert.equal(result.invalid, 1, "oversized imports fail closed without partial rows");
  assert.equal(await service.getTerm("book"), undefined);
});

test("mutations serialize staging and commit; ACK waits for verified durable rename", async () => {
  const adapter = new MemoryAdapter({ delayMs: 2 });
  const service = makeService(adapter);
  const revisions = [];
  const unsubscribe = service.subscribe((event) => revisions.push(event.revision));
  await Promise.all([
    service.setStatus("first", 1),
    service.setStatus("second", 2),
    service.setStatus("third", 3),
  ]);
  assert.equal(adapter.maxActiveWrites, 1);
  assert.equal(service.getRevision(), 3);
  assert.deepEqual(revisions, [1, 2, 3]);
  assert.equal(await service.flush(), 3);
  unsubscribe();

  const failingAdapter = new MemoryAdapter();
  failingAdapter.failRename = (from, to) => from.includes(".tmp-") && to === VOCABULARY_PATH;
  const failing = makeService(failingAdapter);
  await assert.rejects(failing.setStatus("lost", 1), /simulated rename failure/);
  assert.equal(failing.getRevision(), 0);
  assert.equal(await failingAdapter.exists(VOCABULARY_PATH), false);
});

test("a second stale service cannot overwrite a newer snapshot", async () => {
  const adapter = new MemoryAdapter();
  const first = makeService(adapter);
  const stale = makeService(adapter);
  await first.load();
  await stale.load();
  await first.setStatus("first", 1);
  await assert.rejects(stale.setStatus("stale", 1), (error) => {
    assert.equal(error.code, "vocabulary-external-change");
    return true;
  });
  assert.deepEqual(snapshot(adapter).records.map((record) => record.key), ["first"]);
  assert.equal(await first.getTerm("stale"), undefined);
  await assert.rejects(stale.queryTerms(["first"]), (error) => error.code === "vocabulary-external-change");
});

test("an external snapshot change during staging is preserved before the rename window", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.setStatus("stable", 2);
  let externalSnapshot;
  adapter.afterWrite = async (path, text, store) => {
    if (path.includes(".tmp-")) {
      externalSnapshot = `${text}\nexternal-change`;
      store.files.set(VOCABULARY_PATH, externalSnapshot);
    }
  };

  await assert.rejects(service.setNote("stable", "do not overwrite"), (error) => error.code === "vocabulary-external-change");
  assert.equal(adapter.files.get(VOCABULARY_PATH), externalSnapshot);
  assert.equal([...adapter.files.keys()].some((path) => path.includes(".tmp-")), false);
  await assert.rejects(service.queryTerms(["stable"]), (error) => error.code === "vocabulary-external-change");
});

test("an external snapshot arriving in the rename window is restored instead of overwritten", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.setStatus("stable", 2);
  const external = snapshot(adapter);
  external.revision += 20;
  external.records[0].note = "Vault Sync update";
  const externalBytes = JSON.stringify(external);
  adapter.beforeRename = async (from, to, store) => {
    if (from === VOCABULARY_PATH && to === `${VOCABULARY_PATH}.previous`) {
      store.files.set(VOCABULARY_PATH, externalBytes);
    }
  };

  await assert.rejects(service.setNote("stable", "local edit"), (error) => error.code === "vocabulary-external-change");
  assert.equal(adapter.files.get(VOCABULARY_PATH), externalBytes);
  assert.equal(adapter.files.has(`${VOCABULARY_PATH}.previous`), false);
  await assert.rejects(service.queryTerms(["stable"]), (error) => error.code === "vocabulary-external-change");
});

test("an external canonical file recreated before install is kept beside the verified backup", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.setStatus("stable", 2);
  const previousBytes = adapter.files.get(VOCABULARY_PATH);
  const external = snapshot(adapter);
  external.revision += 1;
  external.records[0].note = "recreated by sync";
  const externalBytes = JSON.stringify(external);
  adapter.overwriteRename = true;
  adapter.afterRename = async (from, to, store) => {
    if (from === VOCABULARY_PATH && to === `${VOCABULARY_PATH}.previous`) {
      store.files.set(VOCABULARY_PATH, externalBytes);
    }
  };

  await assert.rejects(service.setNote("stable", "local edit"), (error) => error.code === "vocabulary-external-change");
  assert.equal(adapter.files.get(VOCABULARY_PATH), externalBytes, "an overwrite-capable adapter cannot replace a file observed by the pre-install guard");
  assert.equal(adapter.files.get(`${VOCABULARY_PATH}.previous`), previousBytes, "the verified previous snapshot remains available as a recovery copy");
  assert.equal([...adapter.files.keys()].some((path) => path.includes(".tmp-")), false);
  await assert.rejects(service.queryTerms(["stable"]), (error) => error.code === "vocabulary-external-change");
});

test("a replacement failure restores the previous canonical snapshot", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.setStatus("stable", 2);
  const previousBytes = adapter.files.get(VOCABULARY_PATH);
  adapter.failRename = (from, to) => from.includes(".tmp-") && to === VOCABULARY_PATH;

  await assert.rejects(service.setStatus("stable", 3), /simulated rename failure/);
  assert.equal(adapter.files.get(VOCABULARY_PATH), previousBytes);
  assert.equal(adapter.files.has(`${VOCABULARY_PATH}.previous`), false);
  assert.equal((await service.getTerm("stable")).status, 2);
});

test("a failed rollback poisons the service and preserves the backup for recovery", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.setStatus("stable", 2);
  adapter.failRename = (from, to) =>
    (from.includes(".tmp-") && to === VOCABULARY_PATH) ||
    (from === `${VOCABULARY_PATH}.previous` && to === VOCABULARY_PATH);

  await assert.rejects(service.setStatus("stable", 3), (error) => error.code === "vocabulary-rollback-failed");
  assert.equal(adapter.files.has(`${VOCABULARY_PATH}.previous`), true);
  await assert.rejects(service.queryTerms(["stable"]), (error) => error.code === "vocabulary-rollback-failed");
});

test("recovery from a verified previous snapshot is retained until the next primary commit", async () => {
  const adapter = new MemoryAdapter();
  const original = makeService(adapter);
  await original.setStatus("recovered", 2);
  adapter.files.set(`${VOCABULARY_PATH}.previous`, adapter.files.get(VOCABULARY_PATH));
  adapter.files.delete(VOCABULARY_PATH);

  const recovered = makeService(adapter);
  await recovered.load();
  assert.equal((await recovered.getTerm("recovered")).status, 2);
  await recovered.setNote("recovered", "recovered from backup");
  assert.equal(adapter.files.has(VOCABULARY_PATH), true);
  assert.equal(adapter.files.has(`${VOCABULARY_PATH}.previous`), false);
  assert.equal(snapshot(adapter).records[0].note, "recovered from backup");
});

test("a partial staging write is removed after the adapter fails", async () => {
  const adapter = new MemoryAdapter();
  adapter.failWrite = (path) => path.includes(".tmp-");
  const service = makeService(adapter);

  await assert.rejects(service.setStatus("partial", 1), /partial bytes/);
  assert.equal([...adapter.files.keys()].some((path) => path.includes(".tmp-")), false);
  assert.equal(adapter.files.has(VOCABULARY_PATH), false);
});

test("post-rename byte verification failure rolls back without acknowledging", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.setStatus("verified", 2);
  const previousBytes = adapter.files.get(VOCABULARY_PATH);
  let corruptedCommitRead = false;
  adapter.corruptRead = (path, bytes) => {
    if (path !== VOCABULARY_PATH || corruptedCommitRead) return false;
    const parsed = JSON.parse(bytes);
    if (parsed.records[0]?.status !== 3) return false;
    corruptedCommitRead = true;
    return true;
  };

  await assert.rejects(service.setStatus("verified", 3), (error) => error.code === "vocabulary-commit-verify");
  adapter.corruptRead = null;
  assert.equal(adapter.files.get(VOCABULARY_PATH), previousBytes);
  assert.equal((await service.getTerm("verified")).status, 2);
});

test("corrupt existing store fails closed and preserves original bytes", async () => {
  const adapter = new MemoryAdapter();
  const corrupt = "{ definitely not json";
  adapter.files.set(VOCABULARY_PATH, corrupt);
  const service = makeService(adapter);
  await assert.rejects(service.load(), (error) => {
    assert.ok(error instanceof VocabularyStoreError);
    assert.equal(error.code, "vocabulary-corrupt-json");
    return true;
  });
  assert.equal(adapter.files.get(VOCABULARY_PATH), corrupt);
  const writesBefore = adapter.writeCount;
  await assert.rejects(service.setStatus("abandoned", 1));
  assert.equal(adapter.writeCount, writesBefore);
  assert.equal(adapter.files.get(VOCABULARY_PATH), corrupt);
});

test("status mutation revisions are monotonic and subscribers cannot mutate records", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.setStatus("known", 5);
  const copy = await service.getTerm("known");
  copy.status = 1;
  assert.equal((await service.getTerm("known")).status, 5);
  assert.equal(service.getRevision(), snapshot(adapter).revision);
});

test("upsert writes a selected word or bounded phrase atomically", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  const word = await service.upsertTerm("Café", {
    type: "word", status: 2, translation: "coffee", note: "from selection",
  });
  assert.equal(word.key, "café");
  assert.equal(word.status, 2);
  assert.equal(word.translation, "coffee");
  const phrase = await service.upsertTerm("take care of", { type: "phrase", status: 3 });
  assert.equal(phrase.key, "take care of");
  assert.equal(phrase.type, "phrase");
  assert.equal(phrase.status, 3);
  await assert.rejects(service.upsertTerm(Array(13).fill("one").join(" "), { type: "phrase" }), /2 to 12/);
  assert.equal(snapshot(adapter).records.length, 2);
});
