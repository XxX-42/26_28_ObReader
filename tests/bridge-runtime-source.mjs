import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputRuntimeFiles = [
  "interaction-intent.js",
  "viewport-controller.js",
  "text-selection-controller.js",
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
  const bridgeSource = await readFile(bridgePath, "utf8");
  return `${moduleSources.join("\n")}\n${bridgeSource}`;
}
