import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { createMainRouteClaimStore } = require("../plugin/storage/main-route-claim-store.cjs");
const sha = (bytes) => `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
const sourceHash = sha("pdf");
const route = (path, dev, seq) => ({ type: "ROUTE_SET", seq, opId: `${dev}-${seq}`,
  version: { rev: seq, seq, deviceId: dev }, payload: { sourcePath: path, source: { sourceHash } } });
function backing() {
  const files = new Map(), dirs = new Set();
  return { files, adapter: {
    async exists(p) { return files.has(p) || dirs.has(p); },
    async mkdir(p) { dirs.add(p); },
    async read(p) { if (!files.has(p)) throw new Error("missing"); return files.get(p); },
    async write(p, data) { files.set(p, data); },
    async rename(a, b) { files.set(b, files.get(a)); files.delete(a); },
    async copy(a, b) {
      if (!files.has(a)) throw new Error("source missing");
      if (files.has(b) || dirs.has(b)) throw new Error("target exists");
      files.set(b, files.get(a));
    },
    async remove(p) { files.delete(p); },
    async list(p) { const prefix = `${p}/`; return {
      files: [...files.keys()].filter((x) => x.startsWith(prefix) && !x.slice(prefix.length).includes("/")),
      folders: [...dirs].filter((x) => x.startsWith(prefix) && !x.slice(prefix.length).includes("/")),
    }; },
  } };
}

test("route claims retain concurrent identities and index rename without scanning other documents", async () => {
  const { adapter } = backing();
  const a = createMainRouteClaimStore({ adapter, root: "data", hash: sha, token: () => "a", deviceId: "windows-A" });
  const b = createMainRouteClaimStore({ adapter, root: "data", hash: sha, token: () => "b", deviceId: "ipad-B" });
  const docA = { docKey: "123456abcdef", documentId: "A", source: { sourceHash } };
  const docB = { docKey: "abcdef123456", documentId: "B", source: { sourceHash } };
  await a.publish({ indexedPath: "Books/old.pdf", document: docA, route: route("Books/old.pdf", "windows-A", 1) });
  await b.publish({ indexedPath: "Books/old.pdf", document: docB, route: route("Books/old.pdf", "ipad-B", 1) });
  const old = await a.query("Books/old.pdf");
  assert.deepEqual(old.claims.map((row) => row.documentId).sort(), ["A", "B"]);
  assert.deepEqual(old.errors, []);
  const moved = route("Books/new.pdf", "windows-A", 2);
  await a.publish({ indexedPath: "Books/old.pdf", document: docA, route: moved });
  await a.publish({ indexedPath: "Books/new.pdf", document: docA, route: moved });
  assert.equal((await b.query("Books/new.pdf")).claims[0].route.payload.sourcePath, "Books/new.pdf");
  assert.equal((await b.query("Books/other.pdf")).claims.length, 0);
});

test("corrupted route claims remain explicit errors and cannot act as trusted hints", async () => {
  const { adapter, files } = backing();
  const store = createMainRouteClaimStore({ adapter, root: "data", hash: sha, token: () => "a", deviceId: "windows-A" });
  const saved = await store.publish({ indexedPath: "Books/a.pdf", document: { docKey: "123456abcdef", documentId: "A", source: { sourceHash } }, route: route("Books/a.pdf", "windows-A", 1) });
  files.set(saved.path, "{broken");
  const result = await store.query("Books/a.pdf");
  assert.deepEqual(result.claims, []);
  assert.ok(result.errors.some((entry) => entry.path === saved.path));
  assert.ok(result.errors.some((entry) => entry.path === `${saved.path}.pending-a` && entry.code === "MAIN_ROUTE_CLAIM_PENDING"));
});

test("incomplete and malformed route claim files are reported instead of silently ignored", async () => {
  const { adapter, files } = backing();
  const store = createMainRouteClaimStore({ adapter, root: "data", hash: sha, token: () => "a", deviceId: "windows-A" });
  const saved = await store.publish({ indexedPath: "Books/a.pdf", document: { docKey: "123456abcdef", documentId: "A", source: { sourceHash } }, route: route("Books/a.pdf", "windows-A", 1) });
  files.set(`${saved.path}.pending`, "{partial");
  const malformed = `${saved.path.slice(0, saved.path.lastIndexOf("/"))}/malformed.json`;
  files.set(malformed, "{}");
  const result = await store.query("Books/a.pdf");
  assert.equal(result.claims.length, 1);
  assert.ok(result.errors.some((row) => row.path === `${saved.path}.pending` && row.code === "MAIN_ROUTE_CLAIM_PENDING"));
  assert.ok(result.errors.some((row) => row.path === malformed && row.code === "MAIN_ROUTE_CLAIM_INVALID"));
});
