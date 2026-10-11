import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const {
  computeContentHash,
  ensureViewerAssets,
  sha256Bytes,
} = require("../plugin/asset-runtime.cjs");
const pluginRoot = ".obsidian/plugins/pdf-web-reader";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function makeFile(path, data, overrides = {}) {
  return {
    path,
    size: data.byteLength,
    sha256: sha256(data),
    gzipBase64: gzipSync(data).toString("base64"),
    ...overrides,
  };
}

function makePayload(files, overrides = {}) {
  const payload = {
    schema: 1,
    id: "test-assets-v1",
    files,
    ...overrides,
  };
  payload.contentHash = computeContentHash(payload);
  return payload;
}

test("synchronous browser SHA-256 export matches standard byte vectors", () => {
  const whole = new TextEncoder().encode("abc");
  const padded = new Uint8Array([0, ...whole, 0]);
  assert.equal(
    sha256Bytes(whole),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    sha256Bytes(padded.subarray(1, 4)),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    sha256Bytes(whole.buffer.slice(0)),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

function createMockAdapter() {
  const writes = [];
  const directories = [];
  return {
    writes,
    directories,
    async exists() {
      return false;
    },
    async mkdir(path) {
      directories.push(path);
    },
    async readBinary(path) {
      throw new Error(`Unexpected readBinary: ${path}`);
    },
    async writeBinary(path, bytes) {
      writes.push({ path, bytes });
    },
    async remove(path) {
      throw new Error(`Unexpected remove: ${path}`);
    },
    async read(path) {
      throw new Error(`Unexpected read: ${path}`);
    },
    async write(path, data) {
      writes.push({ path, data });
    },
  };
}

async function assertRejectedWithoutWrites(
  adapter,
  rootPath,
  payload,
  errorPattern,
) {
  await assert.rejects(
    ensureViewerAssets(adapter, rootPath, payload),
    errorPattern,
  );
  assert.deepEqual(
    adapter.writes,
    [],
    "Rejected payloads must not write files",
  );
  assert.deepEqual(
    adapter.directories,
    [],
    "Rejected payloads must fail before creating cache directories",
  );
}

test("asset payload integrity guards reject bad compressed data before filesystem writes", async (t) => {
  const trustedBytes = Buffer.from("good");
  const validFile = makeFile("web/viewer.html", trustedBytes);

  await t.test(
    "compressed content changed while manifest metadata is unchanged",
    async () => {
      const tampered = {
        ...validFile,
        // Same byte length, valid gzip/base64, but different decoded content.
        gzipBase64: gzipSync(Buffer.from("evil")).toString("base64"),
      };
      const payload = makePayload([tampered]);
      const adapter = createMockAdapter();

      await assertRejectedWithoutWrites(
        adapter,
        pluginRoot,
        payload,
        /failed integrity verification/,
      );
    },
  );

  await t.test(
    "declared SHA does not match valid compressed bytes",
    async () => {
      const wrongSha = sha256(Buffer.from("evil"));
      const payload = makePayload([{ ...validFile, sha256: wrongSha }]);
      const adapter = createMockAdapter();

      await assertRejectedWithoutWrites(
        adapter,
        pluginRoot,
        payload,
        /failed integrity verification/,
      );
    },
  );

  await t.test("overall manifest hash does not match", async () => {
    const payload = makePayload([validFile]);
    payload.contentHash =
      payload.contentHash[0] === "0" ? "f".repeat(64) : "0".repeat(64);
    const adapter = createMockAdapter();

    await assertRejectedWithoutWrites(
      adapter,
      pluginRoot,
      payload,
      /manifest content hash does not match/,
    );
  });

  await t.test("decompressed bytes exceed declared size", async () => {
    const payload = makePayload([
      makeFile("web/viewer.html", Buffer.from("larger than one byte"), {
        size: 1,
      }),
    ]);
    const adapter = createMockAdapter();

    await assertRejectedWithoutWrites(
      adapter,
      pluginRoot,
      payload,
      /Unable to decompress viewer asset/,
    );
  });

  await t.test("non-canonical base64 padding bits are rejected", async () => {
    const file = makeFile("web/viewer.html", Buffer.from("canonical"));
    const base64 = file.gzipBase64;
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    assert.ok(padding > 0, "Fixture should have base64 padding");
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const index = base64.length - padding - 1;
    const current = alphabet.indexOf(base64[index]);
    const replacement = alphabet[current + 1];
    const nonCanonical = {
      ...file,
      gzipBase64:
        base64.slice(0, index) + replacement + base64.slice(index + 1),
    };
    const adapter = createMockAdapter();

    await assertRejectedWithoutWrites(
      adapter,
      pluginRoot,
      makePayload([nonCanonical]),
      /Invalid compressed viewer asset data/,
    );
  });
});

test("asset path, ID, and plugin-root guards reject unsafe names before writes", async (t) => {
  const bytes = Buffer.from("safe");
  const validFile = makeFile("web/viewer.html", bytes);

  await t.test("duplicate paths differing only by case", async () => {
    const payload = makePayload([
      validFile,
      makeFile("WEB/VIEWER.HTML", bytes),
    ]);
    const adapter = createMockAdapter();

    await assertRejectedWithoutWrites(
      adapter,
      pluginRoot,
      payload,
      /Duplicate viewer asset path/,
    );
  });

  await t.test(
    "case-insensitive collision with completion marker",
    async () => {
      const payload = {
        schema: 1,
        id: "test-assets-v1",
        contentHash: "a".repeat(64),
        files: [makeFile(".COMPLETE.JSON", bytes)],
      };
      const adapter = createMockAdapter();

      await assertRejectedWithoutWrites(
        adapter,
        pluginRoot,
        payload,
        /reserved for the cache marker/,
      );
    },
  );

  for (const id of ["CON", "bundle."]) {
    await t.test(
      `Windows-reserved or trailing-dot asset id: ${id}`,
      async () => {
        const payload = {
          schema: 1,
          id,
          contentHash: "a".repeat(64),
          files: [validFile],
        };
        const adapter = createMockAdapter();

        await assertRejectedWithoutWrites(
          adapter,
          pluginRoot,
          payload,
          /asset id/,
        );
      },
    );
  }

  for (const rootPath of [
    "/absolute/plugin",
    "plugins\\pdf-reader",
    "plugins/../outside",
  ]) {
    await t.test(
      `unsafe plugin root: ${JSON.stringify(rootPath)}`,
      async () => {
        const adapter = createMockAdapter();
        const payload = makePayload([validFile]);

        await assertRejectedWithoutWrites(
          adapter,
          rootPath,
          payload,
          /plugin root|vault-relative/,
        );
      },
    );
  }

  for (const path of ["/outside.bin", "web\\viewer.html", "../escape.bin"]) {
    await t.test(`unsafe asset path: ${JSON.stringify(path)}`, async () => {
      const adapter = createMockAdapter();
      const payload = {
        schema: 1,
        id: "test-assets-v1",
        contentHash: "a".repeat(64),
        files: [makeFile(path, bytes)],
      };

      await assertRejectedWithoutWrites(
        adapter,
        pluginRoot,
        payload,
        /viewer asset path/,
      );
    });
  }
});

test("a failed completion-marker write cannot leave the cache committed", async () => {
  const bytes = Buffer.from("verified payload");
  const payload = makePayload([makeFile("web/asset.bin", bytes)]);
  const files = new Map();
  let attemptedMarker = "";
  const adapter = {
    async exists(path) {
      return files.has(path);
    },
    async mkdir() {},
    async readBinary(path) {
      return files.get(path);
    },
    async writeBinary(path, value) {
      files.set(path, value);
    },
    async remove(path) {
      files.delete(path);
    },
    async read(path) {
      return files.get(path);
    },
    async write(path, value) {
      attemptedMarker = path;
      files.set(path, value);
      throw new Error("Simulated completion-marker write failure");
    },
  };

  await assert.rejects(
    ensureViewerAssets(adapter, pluginRoot, payload),
    /Simulated completion-marker write failure/,
  );
  assert.ok(attemptedMarker.endsWith("/.complete.json"));
  assert.equal(files.has(attemptedMarker), false);
});
