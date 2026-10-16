import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { snapshotHash } from "./wal-v32-native-fixture.mjs";

const require = createRequire(import.meta.url);
const { createWalAnnotationStore } = require("../plugin/storage/wal-annotation-store.cjs");
const { createPdfHashRuntime } = require("../plugin/pdf-hash-runtime.cjs");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { vault, document, expectedLast, expectedCount, expectedStateHash, expectedOperationHash } = JSON.parse(input);
const vaultRoot = path.resolve(vault);
let diskReads = 0;
let deniedCacheWrites = 0;
const resolve = (relative) => {
  const absolute = path.resolve(vaultRoot, relative);
  assert.ok(absolute.startsWith(`${vaultRoot}${path.sep}`), "read must remain inside the isolated vault");
  return absolute;
};
const denyWrite = async () => { deniedCacheWrites++; throw new Error("Independent cold reader is read-only"); };
const adapter = {
  async exists(relative) { try { await access(resolve(relative)); return true; } catch { return false; } },
  async read(relative) { diskReads++; return readFile(resolve(relative), "utf8"); },
  async list(relative) {
    const entries = await readdir(resolve(relative), { withFileTypes: true });
    return { files: entries.filter((entry) => entry.isFile()).map((entry) => `${relative}/${entry.name}`),
      folders: entries.filter((entry) => entry.isDirectory()).map((entry) => `${relative}/${entry.name}`) };
  },
  write: denyWrite, append: denyWrite, mkdir: denyWrite, rename: denyWrite, remove: denyWrite,
};
const hashes = await createPdfHashRuntime();
const store = createWalAnnotationStore({ adapter, deviceId: "independent-cold-reader",
  hash: hashes.fingerprint, verifyHash: hashes.matches, identityHash: hashes.fingerprint,
  uuid: () => "read-only", jsonlMode: true });
const snapshot = await store.readDocument(document);
assert.equal(snapshot.syncPending, undefined, "cold replay must be complete");
assert.equal(snapshot.annotations.length, expectedCount, "all active annotations must be present");
assert.equal(new Set(snapshot.annotations.map((row) => row.uuid)).size, expectedCount);
const last = snapshot.annotations.find((row) => row.uuid === expectedLast.uuid);
assert.deepEqual(last, expectedLast, "the final annotation must retain every persisted field");
const stateHash = snapshotHash(snapshot.annotations);
assert.equal(stateHash, expectedStateHash, "every field of all 1,000 annotations must match");
const effective = await store.readEffective(document);
const operationHash = snapshotHash(Object.values(effective.state.annotations));
assert.equal(operationHash, expectedOperationHash, "original operation IDs and canonical WAL metadata must match");
process.stdout.write(JSON.stringify({ pid: process.pid, count: snapshot.annotations.length,
  unique: new Set(snapshot.annotations.map((row) => row.uuid)).size, last,
  stateHash, operationHash, diskReads, deniedCacheWrites, syncPending: false }));
