import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPdfAnnotationHost } = require("../plugin/pdf-annotation-host.cjs");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = "00_Archive/20_PDFData";

function hash(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
}

function memoryAdapter(shared = { files: new Map(), folders: new Set(), writes: [] }) {
  const { files, folders, writes } = shared;
  return {
    shared,
    adapter: {
      async exists(p) { return files.has(p) || folders.has(p); },
      async mkdir(p) { folders.add(p); },
      async read(p) {
        if (!files.has(p)) throw new Error(`missing ${p}`);
        return files.get(p);
      },
      async write(p, value) {
        const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
        if (parent && !folders.has(parent)) throw new Error(`parent directory missing: ${parent}`);
        files.set(p, value);
        writes.push(p);
      },
      async rename(from, to) {
        if (!files.has(from)) throw new Error(`missing rename source: ${from}`);
        if (files.has(to)) throw new Error(`rename target exists: ${to}`);
        files.set(to, files.get(from));
        files.delete(from);
      },
      async remove(p) { files.delete(p); },
      async list(p) {
        const prefix = `${p}/`;
        const listedFiles = [];
        const listedFolders = new Set();
        for (const entry of [...files.keys(), ...folders]) {
          if (!entry.startsWith(prefix)) continue;
          const remainder = entry.slice(prefix.length);
          if (!remainder.includes("/")) {
            if (files.has(entry)) listedFiles.push(remainder);
            else if (remainder) listedFolders.add(remainder);
          } else listedFolders.add(remainder.slice(0, remainder.indexOf("/")));
        }
        return { files: listedFiles, folders: [...listedFolders] };
      },
    },
  };
}

function createHarness(sourcePath = "Books/boundary.pdf", sourceBytes = new TextEncoder().encode("immutable PDF bytes")) {
  const { adapter, shared } = memoryAdapter();
  const bytes = sourceBytes.slice();
  const file = { path: sourcePath, basename: sourcePath.split("/").at(-1), stat: { size: bytes.byteLength, mtime: 1 } };
  const forbiddenCalls = [];
  const app = {
    vault: {
      adapter,
      getAbstractFileByPath(p) { return p === file.path ? file : null; },
      async readBinary(target) {
        assert.equal(target, file);
        return bytes.slice().buffer;
      },
      async modifyBinary() { forbiddenCalls.push("modifyBinary"); throw new Error("source PDF writes are forbidden"); },
      async appendBinary() { forbiddenCalls.push("appendBinary"); throw new Error("source PDF appends are forbidden"); },
    },
  };
  let token = 0;
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    deviceId: "boundary-device",
    makeToken: () => `boundary-token-${++token}`,
  });
  const view = {
    documentId: "pending",
    openRequest: 1,
    requestedPath: sourcePath,
    documentFile: file,
    file,
    iframe: {},
    messages: [],
    pdfDocument: {
      async saveDocument() { forbiddenCalls.push("saveDocument"); throw new Error("PDF serialization is forbidden"); },
    },
    postToViewer(message) { this.messages.push(message); return true; },
    setStatus(message) { this.status = message; },
  };
  return { adapter, shared, app, file, bytes, forbiddenCalls, host, view };
}

async function runtimeDependencyGraph(entry) {
  const visited = new Map();
  const pending = [entry];
  const requirePattern = /\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g;
  while (pending.length) {
    const current = path.resolve(pending.pop());
    if (visited.has(current)) continue;
    const source = await readFile(current, "utf8");
    visited.set(current, source);
    const allCalls = [...source.matchAll(/\brequire\s*\(/g)];
    const literalCalls = [...source.matchAll(requirePattern)];
    assert.equal(literalCalls.length, allCalls.length, `${current}: every require must be a static literal`);
    for (const [, , specifier] of literalCalls) {
      assert.ok(specifier.startsWith("."), `${current}: non-relative runtime dependency ${specifier}`);
      let dependency = path.resolve(path.dirname(current), specifier);
      if (!path.extname(dependency)) dependency += ".cjs";
      pending.push(dependency);
    }
  }
  return visited;
}

test("WAL storage runtime dependency graph stays relative and free of host-only APIs", async () => {
  const entry = path.resolve(HERE, "../plugin/storage/wal-annotation-store.cjs");
  const graph = await runtimeDependencyGraph(entry);
  assert.ok(graph.has(entry));
  for (const [file, source] of graph) {
    assert.doesNotMatch(source, /\b(?:process|Buffer)\b/, `${file} must not depend on Node globals`);
    assert.doesNotMatch(source, /\b(?:modifyBinary|appendBinary|saveDocument)\b/,
      `${file} must not write or serialize the source PDF`);
  }
});

test("default annotation host uses WAL storage and saves without source PDF write APIs", async () => {
  const h = createHarness();
  assert.equal(h.host.store.sourceProtocol, "wal-sidecar-v3.1",
    "the default host store factory is the WAL implementation");

  const snapshot = await h.host.initializeView(h.view, h.bytes);
  h.view.documentId = snapshot.documentId;
  await h.host.handleMessage(h.view, {
    type: "annotation-source-identity",
    documentId: h.view.documentId,
    openRequest: h.view.openRequest,
    pageCount: 1,
    orderedPageIdentities: ["4 0 R"],
  });
  await h.host.handleMessage(h.view, {
    type: "save",
    documentId: h.view.documentId,
    openRequest: h.view.openRequest,
    requestId: "boundary-save",
    revision: 1,
    operations: [{ uuid: "boundary-mark", kind: "Square", pageIndex: 0, deleted: false,
      payload: { editor: { type: "square", rect: [1, 2, 3, 4] } } }],
  });

  assert.equal(h.view.messages.at(-1)?.type, "saved");
  assert.deepEqual(h.forbiddenCalls, [], "neither Vault source writes nor PDF.js serialization ran");
  assert.ok(h.shared.writes.length > 0, "annotation state was persisted outside the PDF");
  assert.ok(h.shared.writes.every((p) => p.startsWith(`${ROOT}/`)));
  assert.equal(h.shared.files.has(h.file.path), false);
  h.host.dispose();
});

for (const mode of ["deleted", "corrupt"]) {
  test(`default host rebuilds a ${mode} registry from verified sidecar and WAL routing`, async () => {
    const h = createHarness(`Books/registry-${mode}.pdf`);
    const first = await h.host.initializeView(h.view, h.bytes);
    h.view.documentId = first.documentId;
    const paths = h.host.store.pathsFor(h.view.annotationDocument);
    const registryPath = paths.registry;
    const sidecarPath = paths.snapshot;
    const sidecar = JSON.parse(h.shared.files.get(sidecarPath));
    assert.equal(sidecar.document.sourcePath, h.file.path);
    assert.ok(sidecar.integrity, "the route is recorded in an integrity-verified sidecar");
    h.host.dispose();

    if (mode === "deleted") h.shared.files.delete(registryPath);
    else h.shared.files.set(registryPath, "{truncated registry JSON");

    const reopened = createPdfAnnotationHost({
      app: h.app,
      hashRuntime: { fingerprint: hash },
      deviceId: "boundary-device",
      makeToken: (() => { let token = 0; return () => `reopened-token-${++token}`; })(),
    });
    const reopenedView = { ...h.view, messages: [] };
    const recovered = await reopened.initializeView(reopenedView, h.bytes);
    assert.equal(recovered.documentId, first.documentId);
    const rebuilt = JSON.parse(h.shared.files.get(registryPath));
    assert.equal(rebuilt.kind, "pdf-reader-registry-cache");
    assert.deepEqual(rebuilt.entries[h.file.path], { documentId: first.documentId, docKey: paths.docKey });
    reopened.dispose();
  });
}
