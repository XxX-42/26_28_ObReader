import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
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
), { gitRef = null } = {}) {
  const normalizeRepoPath = (absolutePath) =>
    path.relative(testRoot, absolutePath).split(path.sep).join("/");
  const readRepoSource = async (relativePath) => gitRef
    ? execFileSync("git", ["show", `${gitRef}:${relativePath}`], {
      cwd: testRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    })
    : readFile(path.join(testRoot, relativePath), "utf8");
  const candidateRuntimeFiles = gitRef
    ? new Set(execFileSync("git", [
      "ls-tree", "-r", "--name-only", gitRef, "--",
      "viewer-adapter/input", "viewer-adapter/vocabulary",
    ], { cwd: testRoot, encoding: "utf8" }).trim().split(/\r?\n/))
    : null;
  const moduleSources = await Promise.all(inputRuntimeFiles
    .filter((file) => !candidateRuntimeFiles ||
      candidateRuntimeFiles.has(`viewer-adapter/input/${file}`))
    .map((file) => readRepoSource(`viewer-adapter/input/${file}`)));
  const vocabularyEntryPoint = path.join(
    testRoot,
    "viewer-adapter",
    "vocabulary",
    "runtime-entry.js",
  );
  const vocabularyRuntime = await build({
    entryPoints: [vocabularyEntryPoint],
    bundle: true,
    format: "iife",
    globalName: "PdfReaderVocabularyRuntimeModule",
    platform: "browser",
    target: ["es2022"],
    legalComments: "none",
    write: false,
    ...(gitRef ? {
      plugins: [{
        name: "learning-reliability-source-git-ref",
        setup(buildApi) {
          buildApi.onLoad({ filter: /\.(?:js|mjs)$/ }, async ({ path: sourcePath }) => {
            const repoPath = normalizeRepoPath(sourcePath);
            if (!repoPath.startsWith("viewer-adapter/")) return null;
            return {
              contents: await readRepoSource(repoPath),
              loader: "js",
              resolveDir: path.dirname(sourcePath),
            };
          });
        },
      }],
    } : {}),
  });
  if (vocabularyRuntime.outputFiles.length !== 1) throw new Error("Expected one vocabulary runtime bundle");
  const bridgeSource = await readRepoSource(normalizeRepoPath(bridgePath));
  return `${moduleSources.join("\n")}\n${vocabularyRuntime.outputFiles[0].text}\n${bridgeSource}`;
}
