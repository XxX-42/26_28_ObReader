import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mapNativeSidecarAdapterArgs,
  mapNativeSidecarPath,
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

test("Native sidecar redirect maps DataAdapter.process and both rename paths", () => {
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
    mapNativeSidecarAdapterArgs("vaultRead", ["source.pdf"], sourceRoot, targetRoot),
    ["source.pdf"],
  );
});
