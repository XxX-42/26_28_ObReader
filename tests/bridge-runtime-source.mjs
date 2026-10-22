import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputRuntimeFiles = [
  "interaction-intent.js",
  "interaction-mode.js",
  "viewport-controller.js",
  "ios-direct-manipulation-controller.js",
  "text-selection-controller.js",
  "backlink-interaction-controller.js",
  "annotation-controller.js",
  "desktop-input-policy.js",
  "ios-input-policy.js",
  "input-router.js",
];

export async function readBridgeRuntimeSource(bridgePath = path.join(
  testRoot,
  "viewer-adapter",
  "obsidian-bridge.js",
)) {
  const moduleSources = await Promise.all(inputRuntimeFiles.map((file) =>
    readFile(path.join(testRoot, "viewer-adapter", "input", file), "utf8"),
  ));
  const vocabularyRuntime = await build({
    entryPoints: [path.join(testRoot, "viewer-adapter", "vocabulary", "runtime-entry.js")],
    bundle: true,
    format: "iife",
    globalName: "PdfReaderVocabularyRuntimeModule",
    platform: "browser",
    target: ["es2022"],
    legalComments: "none",
    write: false,
  });
  if (vocabularyRuntime.outputFiles.length !== 1) throw new Error("Expected one vocabulary runtime bundle");
  const bridgeSource = await readFile(bridgePath, "utf8");
  return `${moduleSources.join("\n")}\n${vocabularyRuntime.outputFiles[0].text}\n${bridgeSource}`;
}
