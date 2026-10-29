import assert from "node:assert/strict";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

// Standalone filesystem probe. This is not an Obsidian DataAdapter or Sync test.
const vault = process.env.OBREADER_TEST_VAULT;
assert.ok(vault && path.isAbsolute(vault), "OBREADER_TEST_VAULT must identify the isolated test vault");
const vaultRoot = await realpath(vault);
const parent = await realpath(path.join(vaultRoot, ".obsidian", "plugins", "pdf-web-reader"));
assert.ok(parent.startsWith(`${vaultRoot}${path.sep}`), "probe must stay inside the selected test vault");
const folder = await mkdtemp(path.join(parent, ".exclusive-copy-probe-"));
const target = path.join(folder, "target.json");
const inputs = Array.from({ length: 8 }, (_, index) => path.join(folder, `source-${index}.json`));
const staged = Array.from({ length: 8 }, (_, index) => path.join(folder, "data", `checkpoint.json.pending-writer-${index}`));
const checkpoint = path.join(folder, "data", "checkpoint.json");
let success = false;
try {
  await Promise.all(inputs.map((file, index) => writeFile(file, JSON.stringify({ writer: index }), { flag: "wx" })));
  const results = await Promise.allSettled(inputs.map((file) => copyFile(file, target, constants.COPYFILE_EXCL)));
  const wins = results.map((result, index) => ({ result, index })).filter(({ result }) => result.status === "fulfilled");
  assert.equal(wins.length, 1, "exactly one concurrent copy must create the destination");
  assert.ok(results.filter((result) => result.status === "rejected").every((result) => result.reason?.code === "EEXIST"));
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { writer: wins[0].index });
  for (let index = 0; index < inputs.length; index++) {
    assert.deepEqual(JSON.parse(await readFile(inputs[index], "utf8")), { writer: index });
  }
  await mkdir(path.join(folder, "data"));
  const local = (relative) => {
    const result = path.resolve(folder, relative);
    assert.ok(result.startsWith(`${folder}${path.sep}`), "adapter path must remain inside this probe");
    return result;
  };
  const adapter = {
    async exists(file) { try { await stat(local(file)); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } },
    async mkdir(file) { await mkdir(local(file)); },
    async read(file) { return readFile(local(file), "utf8"); },
    async write(file, value) { await writeFile(local(file), value); },
    async rename(from, to) { throw new Error(`create-only must not rename ${from} to ${to}`); },
    async copy(from, to) { await copyFile(local(from), local(to), constants.COPYFILE_EXCL); },
    async remove(file) { await unlink(local(file)); },
  };
  const { createStorageIo } = createRequire(import.meta.url)("../plugin/storage/io.cjs");
  const hash = (bytes) => `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
  const publications = await Promise.allSettled(inputs.map((_, index) =>
    createStorageIo({ adapter, hash, token: () => `writer-${index}` })
      .writeJsonAtomic("data/checkpoint.json", { writer: index }, { createOnly: true })));
  const published = publications.map((result, index) => ({ result, index })).filter(({ result }) => result.status === "fulfilled");
  assert.equal(published.length, 1, "exactly one actual store publication must succeed");
  assert.ok(publications.filter((result) => result.status === "rejected").every((result) => result.reason?.code === "EEXIST"));
  assert.equal(JSON.parse(await readFile(checkpoint, "utf8")).writer, published[0].index);
  for (let index = 0; index < staged.length; index++) {
    if (index === published[0].index) continue;
    assert.equal(JSON.parse(await readFile(staged[index], "utf8")).writer, index);
  }
  success = true;
  process.stdout.write(JSON.stringify({ platform: process.platform, writers: inputs.length, winners: wins.length,
    losingSourcesRetained: inputs.length - 1, storePublicationWinners: published.length,
    losingStagesRetained: staged.length - 1, scope: "node-filesystem-only" }) + "\n");
} finally {
  if (success) {
    for (const file of [...inputs, target]) await unlink(file);
    await unlink(checkpoint);
    for (const file of staged) {
      try { await unlink(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await rmdir(path.join(folder, "data"));
    await rmdir(folder);
  } else {
    process.stderr.write(`Probe failure evidence retained: ${folder}\n`);
  }
}
