import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

// Isolated Obsidian profile and empty vault; never attaches to a user vault.
const testVault = process.env.OBREADER_TEST_VAULT;
assert.ok(testVault && path.isAbsolute(testVault), "OBREADER_TEST_VAULT is required");
const vaultRoot = await realpath(testVault);
const parent = await realpath(path.join(vaultRoot, ".obsidian", "plugins", "pdf-web-reader"));
assert.ok(parent.startsWith(`${vaultRoot}${path.sep}`), "probe must be inside the test vault");
const root = await mkdtemp(path.join(parent, ".obsidian-copy-probe-"));
const profile = path.join(root, "profile"), fixture = path.join(root, "fixture-vault");
await mkdir(profile); await mkdir(fixture); await mkdir(path.join(fixture, ".obsidian"));
const id = randomUUID().replaceAll("-", "").slice(0, 16);
await writeFile(path.join(profile, "obsidian.json"), JSON.stringify({ vaults: { [id]: { path: fixture, ts: Date.now(), open: true } } }), { flag: "wx" });
const exe = "D:\\Applications\\Obsidian\\Obsidian.exe";
const child = spawn(exe, [`--user-data-dir=${profile}`, "--remote-debugging-port=0"], { windowsHide: true, stdio: "ignore" });
let browser, ok = false;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  let port;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !port) {
    if (child.exitCode !== null) throw new Error(`Isolated Obsidian exited: ${child.exitCode}`);
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch { /* app still starting */ }
    if (!port) await pause(100);
  }
  assert.ok(Number.isInteger(port) && port > 0, "isolated DevTools endpoint did not start");
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  let page;
  while (Date.now() < deadline && !page) {
    for (const candidate of await browser.pages()) {
      try {
        if (await candidate.evaluate(() => globalThis.app?.vault?.getName?.() === "fixture-vault")) { page = candidate; break; }
      } catch { /* renderer not ready */ }
    }
    if (!page) await pause(100);
  }
  assert.ok(page, "the isolated fixture vault was not loaded");
  const result = await page.evaluate(async () => {
    const adapter = globalThis.app.vault.adapter;
    const root = "copy-probe";
    await adapter.mkdir(root);
    const files = Array.from({ length: 8 }, (_, i) => `${root}/source-${i}.json`);
    await Promise.all(files.map((file, index) => adapter.write(file, JSON.stringify({ writer: index }))));
    const target = `${root}/target.json`;
    const outcomes = await Promise.allSettled(files.map((file) => adapter.copy(file, target)));
    const winners = outcomes.map((value, index) => ({ value, index })).filter(({ value }) => value.status === "fulfilled");
    const targetValue = JSON.parse(await adapter.read(target));
    const sources = await Promise.all(files.map((file) => adapter.read(file)));
    return { winners: winners.map((row) => row.index), rejected: outcomes.filter((row) => row.status === "rejected").length,
      targetValue, sourcesIntact: sources.every((value, index) => JSON.parse(value).writer === index), vault: globalThis.app.vault.getName() };
  });
  assert.equal(result.vault, "fixture-vault");
  assert.equal(result.winners.length, 1);
  assert.equal(result.rejected, 7);
  assert.equal(result.targetValue.writer, result.winners[0]);
  assert.equal(result.sourcesIntact, true);
  const modulePath = path.resolve("plugin/storage/io.cjs");
  const publication = await page.evaluate(async (file) => {
    if (typeof globalThis.require !== "function") throw new Error("Obsidian renderer cannot load the storage module");
    const { createStorageIo } = globalThis.require(file);
    const { createHash } = globalThis.require("node:crypto");
    const hash = (bytes) => `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
    const adapter = globalThis.app.vault.adapter;
    const destination = "copy-probe/storage/checkpoint.json";
    const jobs = Array.from({ length: 8 }, (_, index) => createStorageIo({ adapter, hash, token: () => `writer-${index}` })
      .writeJsonAtomic(destination, { writer: index }, { createOnly: true }));
    const outcomes = await Promise.allSettled(jobs);
    const winners = outcomes.map((value, index) => ({ value, index })).filter(({ value }) => value.status === "fulfilled");
    const target = JSON.parse(await adapter.read(destination));
    const staged = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const file = `${destination}.pending-writer-${index}`;
      return await adapter.exists(file) ? JSON.parse(await adapter.read(file)).writer : null;
    }));
    return { winners: winners.map((row) => row.index), rejected: outcomes.filter((row) => row.status === "rejected").length,
      targetWriter: target.writer, staged };
  }, modulePath);
  assert.equal(publication.winners.length, 1);
  assert.equal(publication.rejected, 7);
  assert.equal(publication.targetWriter, publication.winners[0]);
  for (let index = 0; index < 8; index++) {
    assert.equal(publication.staged[index], index === publication.winners[0] ? null : index);
  }
  const snapshotModules = [path.resolve("plugin/storage/main-snapshot-store.cjs"),
    path.resolve("plugin/storage/main-snapshot-candidate.cjs")];
  const snapshots = await page.evaluate(async ([storePath, candidatePath]) => {
    const { createMainSnapshotStore } = globalThis.require(storePath);
    const { makeMainSnapshotCandidate } = globalThis.require(candidatePath);
    const { createHash } = globalThis.require("node:crypto");
    const hash = (bytes) => `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
    const adapter = globalThis.app.vault.adapter;
    const document = { docKey: "123456abcdef", documentId: "native-fixture", source: { sourceHash: hash(new TextEncoder().encode("fixture")) } };
    const operation = { type: "ANNOTATION_SET", uuid: "native-annotation", kind: "Highlight", pageIndex: 0,
      seq: 1, opId: "device-1", version: { deviceId: "device", rev: 1, seq: 1 }, payload: { text: "fixture" } };
    const candidate = await makeMainSnapshotCandidate({ document, operations: [operation], hash });
    const stores = Array.from({ length: 8 }, (_, index) => createMainSnapshotStore({ adapter, root: "copy-probe/snapshots", hash,
      token: () => `writer-${index}` }));
    const outcomes = await Promise.allSettled(stores.map((store) => store.publish(document, candidate)));
    const verified = await stores[0].read(document, candidate.snapshotId);
    const listing = await adapter.list(`copy-probe/snapshots/main-snapshots/${document.docKey}`);
    return { fulfilled: outcomes.filter((entry) => entry.status === "fulfilled").length,
      rejected: outcomes.filter((entry) => entry.status === "rejected").map((entry) => entry.reason?.code || entry.reason?.message),
      verified: verified?.snapshotId === candidate.snapshotId, annotations: verified?.value?.operations?.length,
      pending: listing.files.filter((file) => file.includes(".pending-")).length };
  }, snapshotModules);
  assert.equal(snapshots.fulfilled, 8, JSON.stringify(snapshots));
  assert.equal(snapshots.verified, true);
  assert.equal(snapshots.annotations, 1);
  assert.equal(snapshots.pending, 8);
  ok = true;
  process.stdout.write(`${JSON.stringify({ ...result, publication, snapshots, scope: "isolated-windows-obsidian-adapter" })}\n`);
} finally {
  if (browser) { try { await browser.close(); } catch { /* owned process is stopped below if needed */ } }
  if (child.exitCode === null) { try { child.kill(); } catch { /* already exited */ } }
  if (ok) {
    const resolved = await realpath(root);
    assert.ok(resolved.startsWith(`${parent}${path.sep}.obsidian-copy-probe-`), "cleanup must remain within the owned probe");
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } else process.stderr.write(`Probe evidence retained: ${root}\n`);
}
