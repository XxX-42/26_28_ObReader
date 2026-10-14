import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = process.argv[2] || path.join(root, "test-vault/测试插件/PDF迁移测试/五工具测试.pdf");
const require = createRequire(path.join(root, "package.json"));
const { createPdfHashRuntime } = require("./plugin/pdf-hash-runtime.cjs");
const [xxh, sha] = await Promise.all([
  createPdfHashRuntime(),
  createPdfHashRuntime({ forceSha256: true }),
]);
const fixture = new Uint8Array(await readFile(fixturePath));
const cases = [{ label: "actual-pdf", bytes: fixture, iterations: 40 }];
for (const size of [16, 64]) {
  const bytes = new Uint8Array(size * 1024 * 1024);
  for (let offset = 0; offset < bytes.length; offset += fixture.length) {
    bytes.set(fixture.subarray(0, Math.min(fixture.length, bytes.length - offset)), offset);
  }
  cases.push({ label: `fixture-bytes-${size}MiB-synthetic`, bytes, iterations: size === 16 ? 12 : 6 });
}

const now = () => performance.now();
const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    N: sorted.length,
    meanMs: +(sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(3),
    medianMs: +((sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2).toFixed(3),
    p90Ms: +sorted[Math.ceil(sorted.length * 0.9) - 1].toFixed(3),
    maxMs: +sorted.at(-1).toFixed(3),
  };
};

const results = [];
for (const sample of cases) {
  const expected = xxh.fingerprint(sample.bytes);
  if (!xxh.matches(sample.bytes, expected) || !sha.matches(sample.bytes, sha.fingerprint(sample.bytes))) {
    throw new Error(`Hash consistency check failed for ${sample.label}`);
  }
  const times = { xxh64: [], sha256: [] };
  // Warm both engines before sampling; alternate order to reduce order bias.
  xxh.fingerprint(sample.bytes);
  sha.fingerprint(sample.bytes);
  for (let index = 0; index < sample.iterations; index += 1) {
    const order = index % 2 ? ["sha256", "xxh64"] : ["xxh64", "sha256"];
    for (const algorithm of order) {
      const started = now();
      (algorithm === "xxh64" ? xxh : sha).fingerprint(sample.bytes);
      times[algorithm].push(now() - started);
    }
  }
  const xxhStats = summarize(times.xxh64);
  const shaStats = summarize(times.sha256);
  results.push({
    sample: sample.label,
    bytes: sample.bytes.byteLength,
    xxh64: xxhStats,
    sha256: shaStats,
    meanSpeedup: +(shaStats.meanMs / xxhStats.meanMs).toFixed(2),
    medianSpeedup: +(shaStats.medianMs / xxhStats.medianMs).toFixed(2),
    shaOneTenthGoalMet: xxhStats.medianMs <= shaStats.medianMs / 10,
  });
}

process.stdout.write(`${JSON.stringify({
  runtime: process.version,
  platform: `${process.platform}-${process.arch}`,
  fixture: path.relative(root, fixturePath),
  xxhAlgorithm: xxh.algorithm,
  shaAlgorithm: sha.algorithm,
  results,
}, null, 2)}\n`);
