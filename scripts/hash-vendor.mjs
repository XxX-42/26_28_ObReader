import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "vendor", "pdfjs-generic-legacy");
const manifestPath = path.join(vendor, "SHA256SUMS.json");

async function walk(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRelative = path.posix.join(relative, entry.name);
    const childPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Unexpected symlink in vendored PDF.js runtime: ${childRelative}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await walk(childPath, childRelative)));
    } else if (
      entry.isFile() &&
      entry.name !== "SHA256SUMS.json" &&
      entry.name !== "PROVENANCE.md"
    ) {
      files.push(childRelative);
    }
  }
  return files;
}

async function currentHashes() {
  const files = (await walk(vendor)).sort();
  const hashes = {};
  for (const relative of files) {
    const data = await readFile(path.join(vendor, relative));
    hashes[relative] = createHash("sha256").update(data).digest("hex");
  }
  return hashes;
}

export async function verifyVendorHashes() {
  const expected = JSON.parse(await readFile(manifestPath, "utf8"));
  const actual = await currentHashes();
  assert.deepEqual(actual, expected, "Vendored PDF.js artifact hash mismatch");
  return Object.keys(actual).length;
}

export async function writeVendorHashes() {
  const hashes = await currentHashes();
  await writeFile(manifestPath, `${JSON.stringify(hashes, null, 2)}\n`);
  return Object.keys(hashes).length;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) {
    const count = await writeVendorHashes();
    console.log(`Recorded SHA-256 hashes for ${count} vendored files.`);
  } else {
    const count = await verifyVendorHashes();
    console.log(`Verified SHA-256 hashes for ${count} vendored files.`);
  }
}
