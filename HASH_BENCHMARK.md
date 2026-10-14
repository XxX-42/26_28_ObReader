# XXH64 Candidate Benchmark

This benchmark compares the inlined `xxhash-wasm` XXH64 implementation with the
same bundled `@noble/hashes` SHA-256 fallback used by the plugin. Hash runtime
initialization and file reads happen before timing. Each run hashes identical
in-memory bytes; no PDF parsing or PDF writing is included.

Environment: macOS Apple Silicon (`darwin-arm64`), Node.js 26.3.1. These are
desktop byte-hash measurements, not iPad Safari or Obsidian measurements.

| Sample | Bytes | N | XXH64 mean / median / P90 / max | SHA-256 mean / median / P90 / max | Median speedup |
|---|---:|---:|---:|---:|---:|
| `test-vault/测试插件/PDF迁移测试/五工具测试.pdf` | 1,022,166 | 40 | 0.110 / 0.097 / 0.148 / 0.203 ms | 6.422 / 6.290 / 6.711 / 8.105 ms | 64.85× |
| Repeated fixture bytes, synthetic | 16,777,216 | 12 | 1.764 / 1.713 / 2.173 / 2.239 ms | 105.502 / 105.350 / 107.323 / 109.453 ms | 61.50× |
| Repeated fixture bytes, synthetic | 67,108,864 | 6 | 7.589 / 7.212 / 9.356 / 9.356 ms | 416.849 / 416.458 / 424.961 / 424.961 ms | 57.75× |

All cases met the requested desktop goal of XXH64 median time at or below one
tenth of SHA-256. The synthetic cases are byte-stream throughput probes, not
valid enlarged PDF files. XXH64 is non-cryptographic and only replaces PDF,
recovery, and sync content-consistency hashes. Asset/build/vendor SHA-256 and
stable embedded PDF identities remain unchanged.

Reproduce with:

```sh
node scripts/benchmark-pdf-hashes.mjs
```
