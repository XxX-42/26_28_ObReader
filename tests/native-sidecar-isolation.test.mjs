import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as sidecarIsolation from "./native-sidecar-isolation.mjs";
import {
  mapNativeSidecarAdapterArgs,
  mapNativeSidecarPath,
  serializeNativeSidecarAdapterMapper,
} from "./native-sidecar-isolation.mjs";

const sourceRoot = "00_Archive/20_PDFData";
const targetRoot = ".obsidian/plugins/pdf-web-reader/.native-test-output/run-1/sidecar";

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
