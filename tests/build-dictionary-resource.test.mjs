import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import test from "node:test";
import { build as buildDictionaryResource } from "../scripts/build-dictionary-resource.mjs";

const CSV = [
  "word,phonetic,definition,translation",
  '"On","ɒn","","prep. 在...之上\nadv. ...上去\na. 正起作用的\n[计] 打开"',
  '"on","ɒn","","prep. 在...之上"',
  '"mostly","\'mәustli","","adv. 大概, 大部分, 主要\n[经] 大部份"',
  '"with newline","","an English definition","释义第一行\n释义第二行"',
  '"blank-translation","","fallback definition",""',
  '"sparse","","",""',
  '"two   words","","","词组释义"',
  '"TIE","z","","重复释义"',
  '"tie","a","","重复释义"',
  '" éclair ","","","法语词条"',
].join("\r\n") + "\r\n";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "obreader-dictionary-resource-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "ecdict.csv.gz");
  const sourceBytes = gzipSync(Buffer.from(CSV, "utf8"), { mtime: 0 });
  await writeFile(input, sourceBytes);
  return { directory, input, sourceBytes };
}

async function resourceAt(output) {
  const manifestText = await readFile(path.join(output, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const compressed = await readFile(path.join(output, manifest.resourceFile));
  return { manifestText, manifest, compressed, uncompressed: gunzipSync(compressed) };
}

test("resource bytes and manifest are canonical, content-addressed, and repeatable", async (t) => {
  const fixture = await makeFixture(t);
  const firstOutput = path.join(fixture.directory, "resource-a");
  const secondOutput = path.join(fixture.directory, "resource-b");
  await buildDictionaryResource({ input: fixture.input, output: firstOutput });
  await buildDictionaryResource({ input: fixture.input, output: secondOutput });

  const first = await resourceAt(firstOutput);
  const second = await resourceAt(secondOutput);
  const expectedLines = [
    { key: "blank-translation", translation: "fallback definition", phonetic: "" },
    { key: "mostly", translation: "adv. 大概, 大部分, 主要\n[经] 大部份", phonetic: "'mәustli" },
    { key: "on", translation: "prep. 在...之上\nadv. ...上去\na. 正起作用的\n[计] 打开", phonetic: "ɒn" },
    { key: "sparse", translation: "", phonetic: "" },
    { key: "tie", translation: "重复释义", phonetic: "a" },
    { key: "two words", translation: "词组释义", phonetic: "" },
    { key: "with newline", translation: "释义第一行\n释义第二行", phonetic: "" },
    { key: "éclair", translation: "法语词条", phonetic: "" },
  ];
  const canonicalPayload = Buffer.from(`${expectedLines.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  assert.deepEqual(first.uncompressed, canonicalPayload);
  assert.deepEqual(first.compressed, second.compressed);
  assert.equal(first.manifestText, second.manifestText);
  assert.deepEqual(first.manifest, {
    schemaVersion: 1,
    kind: "pdf-reader-dictionary-resource",
    dictionaryId: "ECDICT",
    normalization: "nfc-lower-space-v1",
    entryCount: expectedLines.length,
    compressedBytes: first.compressed.length,
    uncompressedBytes: canonicalPayload.length,
    sha256: sha256(first.compressed),
    resourceFile: `entries.${sha256(first.compressed)}.jsonl.gz`,
    source: { sha256: sha256(fixture.sourceBytes), rows: 10 },
  });
  assert.equal(first.manifest.resourceFile, `entries.${first.manifest.sha256}.jsonl.gz`);
});

test("duplicate scoring and tie-breaking are independent of source row order", async (t) => {
  const fixture = await makeFixture(t);
  const reorderedCsv = CSV
    .replace('"On","ɒn","","prep. 在...之上\nadv. ...上去\na. 正起作用的\n[计] 打开"\r\n"on","ɒn","","prep. 在...之上"',
      '"on","ɒn","","prep. 在...之上"\r\n"On","ɒn","","prep. 在...之上\nadv. ...上去\na. 正起作用的\n[计] 打开"')
    .replace('"TIE","z","","重复释义"\r\n"tie","a","","重复释义"',
      '"tie","a","","重复释义"\r\n"TIE","z","","重复释义"');
  assert.notEqual(reorderedCsv, CSV, "the fixture actually reorders both duplicate groups");
  const reorderedInput = path.join(fixture.directory, "reordered.csv.gz");
  await writeFile(reorderedInput, gzipSync(Buffer.from(reorderedCsv, "utf8"), { mtime: 0 }));
  const firstOutput = path.join(fixture.directory, "original-resource");
  const reorderedOutput = path.join(fixture.directory, "reordered-resource");
  await buildDictionaryResource({ input: fixture.input, output: firstOutput });
  await buildDictionaryResource({ input: reorderedInput, output: reorderedOutput });

  const original = await resourceAt(firstOutput);
  const reordered = await resourceAt(reorderedOutput);
  assert.deepEqual(reordered.uncompressed, original.uncompressed);
  assert.equal(reordered.manifest.entryCount, 8);
  assert.equal(reordered.manifest.source.rows, 10);
  assert.deepEqual(JSON.parse(reordered.uncompressed.toString("utf8").split("\n").find((line) => line.includes('"key":"on"'))), {
    key: "on",
    translation: "prep. 在...之上\nadv. ...上去\na. 正起作用的\n[计] 打开",
    phonetic: "ɒn",
  });
  assert.deepEqual(JSON.parse(reordered.uncompressed.toString("utf8").split("\n").find((line) => line.includes('"key":"tie"'))), {
    key: "tie", translation: "重复释义", phonetic: "a",
  });
});

test("foreign manifest is preserved and prevents writes", async (t) => {
  const fixture = await makeFixture(t);
  const output = path.join(fixture.directory, "foreign");
  await mkdir(output, { recursive: true });
  const foreignManifest = '{"kind":"some-other-resource","marker":"keep me"}\n';
  await writeFile(path.join(output, "manifest.json"), foreignManifest);

  await assert.rejects(buildDictionaryResource({ input: fixture.input, output }), /Refusing to replace unrelated output manifest/u);
  assert.equal(await readFile(path.join(output, "manifest.json"), "utf8"), foreignManifest);
  assert.deepEqual(await readdir(output), ["manifest.json"]);
});

test("orphan resources and stale temporary files survive an interrupted manifest update", async (t) => {
  const fixture = await makeFixture(t);
  const originalOutput = path.join(fixture.directory, "active-resource");
  await buildDictionaryResource({ input: fixture.input, output: originalOutput });
  const original = await resourceAt(originalOutput);

  const changedInput = path.join(fixture.directory, "changed.csv.gz");
  const changedSource = gzipSync(Buffer.from(CSV.replace("法语词条", "新版法语词条"), "utf8"), { mtime: 0 });
  await writeFile(changedInput, changedSource);
  const stagedOutput = path.join(fixture.directory, "staged-resource");
  await buildDictionaryResource({ input: changedInput, output: stagedOutput });
  const staged = await resourceAt(stagedOutput);

  const stagedPath = path.join(originalOutput, staged.manifest.resourceFile);
  await writeFile(stagedPath, staged.compressed);
  const staleTemporary = path.join(originalOutput, "manifest.json.tmp-interrupted");
  await writeFile(staleTemporary, "partial manifest from an interrupted run");
  assert.equal((await resourceAt(originalOutput)).manifestText, original.manifestText);

  await buildDictionaryResource({ input: changedInput, output: originalOutput });
  const committed = await resourceAt(originalOutput);
  assert.equal(committed.manifestText, staged.manifestText);
  assert.deepEqual(committed.compressed, staged.compressed);
  assert.deepEqual(await readFile(path.join(originalOutput, original.manifest.resourceFile)), original.compressed);
  assert.equal(await readFile(staleTemporary, "utf8"), "partial manifest from an interrupted run");
});

test("a corrupt file at the computed content address is never overwritten", async (t) => {
  const fixture = await makeFixture(t);
  const output = path.join(fixture.directory, "resource");
  await buildDictionaryResource({ input: fixture.input, output });
  const originalManifest = await readFile(path.join(output, "manifest.json"), "utf8");
  const original = JSON.parse(originalManifest);
  const conflictPath = path.join(output, original.resourceFile);
  const corrupt = Buffer.from("foreign bytes");
  await writeFile(conflictPath, corrupt);

  await assert.rejects(buildDictionaryResource({ input: fixture.input, output }), /wrong hash/u);
  assert.equal(await readFile(path.join(output, "manifest.json"), "utf8"), originalManifest);
  assert.deepEqual(await readFile(conflictPath), corrupt);
});
