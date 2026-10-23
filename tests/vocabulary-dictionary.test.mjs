import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID, webcrypto } from "node:crypto";
import test from "node:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { build as buildDictionaryResource } from "../scripts/build-dictionary-resource.mjs";

const require = createRequire(import.meta.url);
const { DictionaryQueryCache } = require("../plugin/vocabulary/dictionary-cache.cjs");
const {
  VocabularyDictionary,
  VocabularyDictionaryError,
  normalizeDictionaryKey,
} = require("../plugin/vocabulary/dictionary.cjs");
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const ROOT = "fixture/dictionaries/ECDICT/resource-v2";
const CSV = [
  "word,phonetic,definition,translation",
  '"on","ɒn","","prep. 在...之上\nadv. ...上去\na. 正起作用的\n[计] 打开"',
  '"On","ɒn","","prep. 在...之上"',
  '"mostly","\'mәustli","","adv. 大概, 大部分, 主要\n[经] 大部份"',
  '"with newline","","an English definition","释义第一行\n释义第二行"',
  '"blank-translation","","fallback definition",""',
  '"sparse","","",""',
  '" éclair ","","","法语词条"',
].join("\r\n") + "\r\n";

class MemoryAdapter {
  constructor(files = new Map()) {
    this.files = files;
    this.readBinaryCount = new Map();
  }
  async read(file) {
    const value = this.files.get(file);
    if (value === undefined) throw Object.assign(new Error(`missing: ${file}`), { code: "ENOENT" });
    return Buffer.isBuffer(value) ? value.toString("utf8") : value;
  }
  async readBinary(file) {
    this.readBinaryCount.set(file, (this.readBinaryCount.get(file) || 0) + 1);
    const value = this.files.get(file);
    if (value === undefined) throw Object.assign(new Error(`missing: ${file}`), { code: "ENOENT" });
    return value;
  }
}

function makeCache() {
  return new DictionaryQueryCache({
    name: `vocabulary-dictionary-${randomUUID()}`,
    indexedDB,
    IDBKeyRange,
    batchSize: 2,
  });
}

function dictionaryFor(t, adapter, options = {}) {
  const dictionary = new VocabularyDictionary({ adapter, root: ROOT, cache: makeCache(), ...options });
  t.after(() => dictionary.dispose());
  return dictionary;
}

async function makeDictionaryFixture(t, csv = CSV) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "obreader-ecdict-resource-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "ecdict.csv.gz");
  const output = path.join(directory, "resource-v2");
  await writeFile(input, gzipSync(Buffer.from(csv, "utf8"), { mtime: 0 }));
  const generated = await buildDictionaryResource({ input, output });
  const manifestText = await readFile(path.join(output, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const files = new Map([
    [`${ROOT}/manifest.json`, manifestText],
    [`${ROOT}/${manifest.resourceFile}`, await readFile(path.join(output, manifest.resourceFile))],
  ]);
  return { directory, output, generated, files, manifest };
}

function readErrorCode(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof VocabularyDictionaryError);
    assert.equal(error.code, code);
    return true;
  });
}

test("dictionary lookup returns ECDICT translation and phonetic without personal learning state", async (t) => {
  const fixture = await makeDictionaryFixture(t);
  const adapter = new MemoryAdapter(fixture.files);
  const dictionary = dictionaryFor(t, adapter);
  await dictionary.ensureReady(); // Explicit v2 compatibility preparation; lookup itself never builds it.
  assert.deepEqual(await dictionary.lookup(" ON "), {
    key: "on",
    translation: "prep. 在...之上\nadv. ...上去\na. 正起作用的\n[计] 打开",
    phonetic: "ɒn",
    source: "ECDICT",
  });
  assert.deepEqual(await dictionary.lookup("mostly"), {
    key: "mostly",
    translation: "adv. 大概, 大部分, 主要\n[经] 大部份",
    phonetic: "'mәustli",
    source: "ECDICT",
  });
  assert.equal(await dictionary.lookup("not-in-ecdict"), null);
  assert.equal(await dictionary.lookup(""), null);
  assert.equal(fixture.generated.entryCount, 6,
    "case-insensitive duplicate ECDICT rows collapse to one stable key");
});

test("generator parses quoted multiline CSV fields and uses definition when translation is empty", async (t) => {
  const fixture = await makeDictionaryFixture(t);
  const dictionary = dictionaryFor(t, new MemoryAdapter(fixture.files));
  await dictionary.ensureReady();
  assert.deepEqual(await dictionary.lookup("with newline"), {
    key: "with newline",
    translation: "释义第一行\n释义第二行",
    phonetic: "",
    source: "ECDICT",
  });
  assert.equal((await dictionary.lookup("blank-translation")).translation, "fallback definition");
  assert.equal((await dictionary.lookup("sparse")).translation, "");
  assert.deepEqual(await dictionary.lookup("ÉCLAIR"), {
    key: "éclair", translation: "法语词条", phonetic: "", source: "ECDICT",
  });
});

test("missing manifest, missing resource, and damaged resource have distinct stable errors", async (t) => {
  const fixture = await makeDictionaryFixture(t);
  await readErrorCode(dictionaryFor(t, new MemoryAdapter()).lookup("on"), "DICTIONARY_INDEX_MISSING");

  const missingResourceFiles = new Map(fixture.files);
  missingResourceFiles.delete(`${ROOT}/${fixture.manifest.resourceFile}`);
  await readErrorCode(dictionaryFor(t, new MemoryAdapter(missingResourceFiles)).ensureReady(),
    "DICTIONARY_RESOURCE_MISSING");

  const damagedFiles = new Map(fixture.files);
  const resourcePath = `${ROOT}/${fixture.manifest.resourceFile}`;
  const damaged = Buffer.from(damagedFiles.get(resourcePath));
  damaged[damaged.length - 1] ^= 0xff;
  damagedFiles.set(resourcePath, damaged);
  await readErrorCode(dictionaryFor(t, new MemoryAdapter(damagedFiles)).ensureReady(),
    "DICTIONARY_RESOURCE_CORRUPT");
});

test("explicit v2 preparation imports once; warm hits and misses stay local", async (t) => {
  const fixture = await makeDictionaryFixture(t);
  const adapter = new MemoryAdapter(fixture.files);
  const dictionary = dictionaryFor(t, adapter);
  await dictionary.ensureReady();
  const [first, second] = await Promise.all([dictionary.lookup("on"), dictionary.lookup("ON")]);
  assert.deepEqual(first, second);
  const resourcePath = `${ROOT}/${fixture.manifest.resourceFile}`;
  assert.equal(adapter.readBinaryCount.get(resourcePath), 1,
    "explicit v2 preparation reads the compressed source once");
  assert.deepEqual(await dictionary.lookup("mostly"), {
    key: "mostly", translation: "adv. 大概, 大部分, 主要\n[经] 大部份", phonetic: "'mәustli", source: "ECDICT",
  });
  assert.equal(await dictionary.lookup("missing"), null);
  assert.equal(adapter.readBinaryCount.get(resourcePath), 1,
    "warm positive and negative queries do not reread the resource");
});

test("gzip decoding uses the standard Web DecompressionStream API available to WebViews and Node", async (t) => {
  if (typeof globalThis.DecompressionStream !== "function" || typeof globalThis.Blob !== "function" ||
      typeof globalThis.Response !== "function" || !globalThis.crypto?.subtle) {
    t.skip("Runtime lacks standard gzip/Web Crypto APIs needed by the dictionary module.");
    return;
  }
  const fixture = await makeDictionaryFixture(t);
  const dictionary = dictionaryFor(t, new MemoryAdapter(fixture.files));
  await dictionary.ensureReady();
  assert.equal((await dictionary.lookup("on")).translation.includes("在...之上"), true);
});

test("dictionary key normalization is deterministic for whitespace, case, and Unicode", () => {
  assert.equal(normalizeDictionaryKey("  On\tLINE  "), "on line");
  assert.equal(normalizeDictionaryKey(" ÉCLAIR "), "éclair");
  assert.equal(normalizeDictionaryKey("\u00a0Mixed\u2003Space\u00a0"), "mixed space");
});
