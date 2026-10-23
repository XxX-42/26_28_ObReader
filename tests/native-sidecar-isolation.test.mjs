import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as sidecarIsolation from "./native-sidecar-isolation.mjs";
import {
  mapNativeSidecarAdapterArgs,
  mapNativeSidecarPath,
  readNativeSidecarTree,
  serializeNativeSidecarAdapterMapper,
} from "./native-sidecar-isolation.mjs";

const sourceRoot = "00_Archive/20_PDFData";
const targetRoot = ".obsidian/plugins/pdf-web-reader/.native-test-output/run-1/sidecar";

test("Native PDF guard scope survives CLI serialization and rejects omitted or unrelated fixture folders", () => {
  const fixtureFolder = "PDF迁移测试/sidecar-native-0.12.2-test";
  const file = `${fixtureFolder}/immutable-source.pdf`;
  const context = { file, fixtureFolder };
  runInNewContext(`${serializeNativeSidecarAdapterMapper()};
    globalThis.valid = assertNativeFixtureScope({ file, fixtureFolder });`, context);
  assert.equal(context.valid, true);
  assert.throws(() => sidecarIsolation.assertNativeFixtureScope({ file }), /explicit isolated/);
  assert.throws(() => sidecarIsolation.assertNativeFixtureScope({ file, fixtureFolder: "12_books" }), /explicit isolated/);
  assert.throws(() => sidecarIsolation.assertNativeFixtureScope({ file: "12_books/book.pdf", fixtureFolder }), /explicit isolated/);
});

test("Native sidecar redirect maps only the exact annotation root", () => {
  assert.equal(mapNativeSidecarPath(sourceRoot, sourceRoot, targetRoot), targetRoot);
  assert.equal(
    mapNativeSidecarPath(`${sourceRoot}/checkpoints/doc.json`, sourceRoot, targetRoot),
    `${targetRoot}/checkpoints/doc.json`,
  );
  assert.equal(
    mapNativeSidecarPath("00_Archive/20_PDFData-old/file.json", sourceRoot, targetRoot),
    "00_Archive/20_PDFData-old/file.json",
  );
  assert.equal(mapNativeSidecarPath("other/file.pdf", sourceRoot, targetRoot), "other/file.pdf");
});

test("Native sidecar redirect maps DataAdapter.process and both source and destination paths", () => {
  const process = async () => "callback-preserved";
  const processArgs = mapNativeSidecarAdapterArgs(
    "process",
    [`${sourceRoot}/checkpoints/doc.json`, process],
    sourceRoot,
    targetRoot,
  );
  assert.equal(processArgs[0], `${targetRoot}/checkpoints/doc.json`);
  assert.equal(processArgs[1], process);

  assert.deepEqual(
    mapNativeSidecarAdapterArgs(
      "rename",
      [`${sourceRoot}/ops/a.pending`, `${sourceRoot}/ops/a.json`],
      sourceRoot,
      targetRoot,
    ),
    [`${targetRoot}/ops/a.pending`, `${targetRoot}/ops/a.json`],
  );
  assert.deepEqual(
    mapNativeSidecarAdapterArgs(
      "copy",
      [`${sourceRoot}/ops/a.json`, `${sourceRoot}/ops/b.json`],
      sourceRoot,
      targetRoot,
    ),
    [`${targetRoot}/ops/a.json`, `${targetRoot}/ops/b.json`],
  );
  assert.deepEqual(
    mapNativeSidecarAdapterArgs("vaultRead", ["source.pdf"], sourceRoot, targetRoot),
    ["source.pdf"],
  );
});

test("Native sidecar redirect maps DataAdapter.list results back into the virtual namespace", () => {
  const physical = {
    folders: [
      `${targetRoot}/wal/device-a`,
      "00_Archive/20_PDFData-old/untouched",
    ],
    files: [`${targetRoot}/wal/device-a/doc.jsonl.anchor.json`, "outside/file.json"],
  };
  const mapped = sidecarIsolation.mapNativeSidecarListResult?.(
    physical,
    targetRoot,
    sourceRoot,
  );
  assert.deepEqual(mapped?.folders, [
    `${sourceRoot}/wal/device-a`,
    "00_Archive/20_PDFData-old/untouched",
  ]);
  assert.deepEqual(mapped?.files, [
    `${sourceRoot}/wal/device-a/doc.jsonl.anchor.json`,
    "outside/file.json",
  ]);
  assert.deepEqual(physical.files, [`${targetRoot}/wal/device-a/doc.jsonl.anchor.json`, "outside/file.json"],
    "mapping a list result must not mutate the adapter's physical result");
});

test("Native evidence snapshot defers while an atomic .pending file is being renamed", async () => {
  const reads = [];
  const error = await readNativeSidecarTree("sidecar", {
    rejectPending: true,
    readdir: async () => [{ name: "doc.jsonl.archive.11-11.json.pending", isDirectory: () => false }],
    readFile: async file => {
      reads.push(file);
      throw Object.assign(new Error("ENOENT during atomic rename"), { code: "ENOENT" });
    },
  }).then(() => null, value => value);

  assert.equal(error?.code, "NATIVE_SIDECAR_SNAPSHOT_TRANSIENT");
  assert.equal(error?.path, "sidecar/doc.jsonl.archive.11-11.json.pending");
  assert.deepEqual(reads, [], "Unpublished temporary files must never be parsed as durable WAL evidence");
});

test("Native evidence snapshot ignores the retained JSONL witness but reads its published WAL", async () => {
  const reads = [];
  const files = await readNativeSidecarTree("sidecar", {
    rejectPending: true,
    readdir: async directory => directory === "sidecar"
      ? [{ name: "wal", isDirectory: () => true }]
      : [
        { name: "doc.jsonl.pending", isDirectory: () => false },
        { name: "doc.jsonl", isDirectory: () => false },
      ],
    readFile: async file => {
      reads.push(file);
      return Buffer.from("published-wal\n");
    },
  });

  assert.deepEqual([...files.keys()], ["sidecar/wal/doc.jsonl"]);
  assert.deepEqual(reads, ["sidecar/wal/doc.jsonl"], "The retained pending witness is never treated as the active WAL");
});

test("Native evidence snapshot still defers when a JSONL pending file has no published WAL", async () => {
  const error = await readNativeSidecarTree("sidecar", {
    rejectPending: true,
    readdir: async directory => directory === "sidecar"
      ? [{ name: "wal", isDirectory: () => true }]
      : [{ name: "doc.jsonl.pending", isDirectory: () => false }],
    readFile: async () => { throw new Error("unpublished WAL must not be read"); },
  }).then(() => null, value => value);

  assert.equal(error?.code, "NATIVE_SIDECAR_SNAPSHOT_TRANSIENT");
  assert.equal(error?.path, "sidecar/wal/doc.jsonl.pending");
});

test("Native evidence snapshot propagates a missing published file", async () => {
  const error = await readNativeSidecarTree("sidecar", {
    rejectPending: true,
    readdir: async () => [{ name: "doc.jsonl.archive.11-11.json", isDirectory: () => false }],
    readFile: async () => { throw Object.assign(new Error("missing published archive"), { code: "ENOENT" }); },
  }).then(() => null, value => value);

  assert.equal(error?.code, "ENOENT", "A missing final archive remains a real evidence failure");
});

test("Native sidecar mapper works after serialization into an isolated Obsidian runtime", () => {
  const isolatedRuntime = {};
  runInNewContext(`
    ${serializeNativeSidecarAdapterMapper()}
    globalThis.mapped = mapNativeSidecarAdapterArgs(
      "readBinary",
      ["${sourceRoot}/checkpoints/doc.json"],
      "${sourceRoot}",
      "${targetRoot}",
    );
    globalThis.listed = mapNativeSidecarListResult(
      { folders: ["${targetRoot}/wal/device-a"], files: ["${targetRoot}/wal/device-a/a.jsonl"] },
      "${targetRoot}",
      "${sourceRoot}",
    );
  `, isolatedRuntime);
  assert.equal(isolatedRuntime.mapped.length, 1);
  assert.equal(isolatedRuntime.mapped[0], `${targetRoot}/checkpoints/doc.json`);
  assert.equal(isolatedRuntime.listed.folders[0], `${sourceRoot}/wal/device-a`);
  assert.equal(isolatedRuntime.listed.files[0], `${sourceRoot}/wal/device-a/a.jsonl`);
});
