import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build as buildV2 } from "../scripts/build-dictionary-resource.mjs";
import { build as buildV3 } from "../scripts/build-dictionary-resource-v3.mjs";

const CSV = [
  "word,phonetic,definition,translation",
  '"alpha","æ","","第一释义"',
  '"BETA","ˈbeɪtə","","第二释义"',
  '"éclair","","","法语释义"',
  '"gamma","ɡ","","多行\n中文释义"',
  '"Ωmega","","","希腊字母"',
].join("\r\n") + "\r\n";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "obreader-ecdict-v3-build-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "ecdict.csv.gz");
  const v2 = path.join(directory, "resource-v2");
  await writeFile(input, gzipSync(Buffer.from(CSV, "utf8"), { mtime: 0 }));
  await buildV2({ input, output: v2 });
  return { directory, v2 };
}

async function readV3(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const entries = [];
  for (const block of manifest.blocks) {
    const compressed = await readFile(path.join(root, block.resourceFile));
    assert.equal(compressed.length, block.compressedBytes);
    assert.equal(createHash("sha256").update(compressed).digest("hex"), block.sha256);
    const raw = gunzipSync(compressed);
    assert.equal(raw.length, block.uncompressedBytes);
    const lines = raw.toString("utf8").trimEnd().split("\n");
    assert.equal(lines.length, block.entryCount);
    assert.equal(JSON.parse(lines[0]).key, block.firstKey);
    assert.equal(JSON.parse(lines.at(-1)).key, block.lastKey);
    entries.push(...lines.map(line => JSON.parse(line)));
  }
  return { manifest, entries };
}

test("resource-v3 conversion preserves every verified v2 row and source provenance", async (t) => {
  const { directory, v2 } = await fixture(t);
  const output = path.join(directory, "resource-v3");
  const firstManifest = await buildV3({ input: v2, output, rawTargetBytes: 40 });
  const first = await readV3(output);
  const v2Manifest = JSON.parse(await readFile(path.join(v2, "manifest.json"), "utf8"));
  const v2Raw = gunzipSync(await readFile(path.join(v2, v2Manifest.resourceFile)));
  const v2Entries = v2Raw.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));

  assert.deepEqual(first.entries, v2Entries);
  assert.deepEqual(firstManifest.source, {
    format: "resource-v2",
    sha256: v2Manifest.sha256,
    entryCount: v2Manifest.entryCount,
    compressedBytes: v2Manifest.compressedBytes,
    uncompressedBytes: v2Manifest.uncompressedBytes,
    source: v2Manifest.source,
  });
  assert.equal(first.manifest.schemaVersion, 3);
  assert.ok(first.manifest.blockCount >= 1);
  assert.equal(first.manifest.entryCount, v2Manifest.entryCount);
  assert.equal(first.manifest.blocks.reduce((sum, block) => sum + block.entryCount, 0), v2Manifest.entryCount);

  const repeat = await buildV3({ input: v2, output: path.join(directory, "repeat"), rawTargetBytes: 40 });
  assert.deepEqual(repeat, first.manifest, "identical input creates the same v3 index");
  const repeatFiles = await readdir(path.join(directory, "repeat", "blocks"));
  const firstFiles = await readdir(path.join(output, "blocks"));
  assert.deepEqual(repeatFiles, firstFiles);
});

test("resource-v3 conversion rejects damaged v2 bytes before publishing a manifest", async (t) => {
  const { directory, v2 } = await fixture(t);
  const manifest = JSON.parse(await readFile(path.join(v2, "manifest.json"), "utf8"));
  const resourcePath = path.join(v2, manifest.resourceFile);
  const damaged = Buffer.from(await readFile(resourcePath));
  damaged[damaged.length - 1] ^= 0xff;
  await writeFile(resourcePath, damaged);
  const output = path.join(directory, "resource-v3");
  await assert.rejects(buildV3({ input: v2, output }), /resource-v2 SHA-256/u);
  await assert.rejects(readFile(path.join(output, "manifest.json")), { code: "ENOENT" });
});

test("resource-v3 builder preserves a foreign manifest", async (t) => {
  const { directory, v2 } = await fixture(t);
  const output = path.join(directory, "resource-v3");
  await mkdir(output, { recursive: true });
  const foreign = '{"kind":"some-other-resource","marker":"keep"}\n';
  await writeFile(path.join(output, "manifest.json"), foreign);
  await assert.rejects(buildV3({ input: v2, output }), /Refusing to replace unrelated output manifest/u);
  assert.equal(await readFile(path.join(output, "manifest.json"), "utf8"), foreign);
});
