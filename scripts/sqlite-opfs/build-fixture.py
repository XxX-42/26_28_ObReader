#!/usr/bin/env python3
"""Build an offline SQLite fixture from the frozen ECDICT resource-v2 JSONL."""

import argparse
import gzip
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path


EXPECTED_RESOURCE_SHA256 = "b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126"
EXPECTED_ENTRY_COUNT = 770_611
EXPECTED_COMPRESSED_BYTES = 16_734_703
EXPECTED_UNCOMPRESSED_BYTES = 69_667_588
EXPECTED_FIELDS = {"key", "translation", "phonetic"}
QUERY_TERMS = ["on", "mostly", "subscription", "details", "about"]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("resource", type=Path, help="Frozen .jsonl.gz copied from testVaultv2")
    parser.add_argument("database", type=Path, help="New output SQLite file (must not exist)")
    parser.add_argument("--report", type=Path, help="Optional build report JSON path")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    resource = args.resource.resolve()
    database = args.database.resolve()
    if not resource.is_file():
        raise SystemExit(f"resource not found: {resource}")
    if database.exists():
        raise SystemExit(f"refusing to overwrite an existing database: {database}")
    database.parent.mkdir(parents=True, exist_ok=True)

    compressed_bytes = resource.stat().st_size
    resource_sha256 = sha256_file(resource)
    if compressed_bytes != EXPECTED_COMPRESSED_BYTES:
        raise SystemExit(f"wrong compressed byte count: {compressed_bytes}")
    if resource_sha256 != EXPECTED_RESOURCE_SHA256:
        raise SystemExit(f"wrong compressed SHA-256: {resource_sha256}")
    manifest_path = resource.parent / "manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (manifest.get("entryCount") != EXPECTED_ENTRY_COUNT
                or manifest.get("compressedBytes") != EXPECTED_COMPRESSED_BYTES
                or manifest.get("uncompressedBytes") != EXPECTED_UNCOMPRESSED_BYTES
                or manifest.get("sha256") != EXPECTED_RESOURCE_SHA256):
            raise SystemExit(f"resource manifest does not match the frozen fixture: {manifest_path}")

    started = time.perf_counter()
    jsonl_digest = hashlib.sha256()
    uncompressed_bytes = 0
    entries = 0
    previous_key = None

    fd, temp_name = tempfile.mkstemp(prefix=f".{database.name}.", suffix=".tmp", dir=database.parent)
    os.close(fd)
    temp_database = Path(temp_name)
    try:
        connection = sqlite3.connect(temp_database)
        try:
            connection.execute("PRAGMA page_size = 4096")
            connection.execute("PRAGMA journal_mode = OFF")
            connection.execute("PRAGMA synchronous = OFF")
            connection.execute("PRAGMA temp_store = MEMORY")
            connection.executescript("""
                CREATE TABLE fixture_metadata (
                    name TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                ) WITHOUT ROWID;
                CREATE TABLE entries (
                    ordinal INTEGER NOT NULL UNIQUE,
                    key TEXT PRIMARY KEY COLLATE BINARY,
                    translation TEXT NOT NULL,
                    phonetic TEXT NOT NULL,
                    row_json TEXT NOT NULL
                ) WITHOUT ROWID;
                PRAGMA user_version = 1;
            """)
            insert = "INSERT INTO entries (ordinal, key, translation, phonetic, row_json) VALUES (?, ?, ?, ?, ?)"
            batch = []
            with gzip.open(resource, "rb") as source:
                for line_number, raw_line in enumerate(source, start=1):
                    if not raw_line.endswith(b"\n"):
                        raise SystemExit(f"JSONL line {line_number} lacks a final line feed")
                    jsonl_digest.update(raw_line)
                    uncompressed_bytes += len(raw_line)
                    row_text = raw_line[:-1].decode("utf-8")
                    row = json.loads(row_text)
                    if not isinstance(row, dict) or set(row) != EXPECTED_FIELDS:
                        raise SystemExit(f"JSONL line {line_number} has unexpected fields")
                    if any(not isinstance(row[field], str) for field in EXPECTED_FIELDS):
                        raise SystemExit(f"JSONL line {line_number} has a non-string value")
                    key = row["key"]
                    if previous_key is not None and key <= previous_key:
                        raise SystemExit(f"JSONL keys are not strictly ordered at line {line_number}")
                    previous_key = key
                    entries += 1
                    batch.append((entries, key, row["translation"], row["phonetic"], row_text))
                    if len(batch) == 10_000:
                        connection.executemany(insert, batch)
                        batch.clear()
                if batch:
                    connection.executemany(insert, batch)

            if entries != EXPECTED_ENTRY_COUNT:
                raise SystemExit(f"wrong row count: {entries}")
            if uncompressed_bytes != EXPECTED_UNCOMPRESSED_BYTES:
                raise SystemExit(f"wrong uncompressed byte count: {uncompressed_bytes}")
            raw_jsonl_sha256 = jsonl_digest.hexdigest()
            metadata = {
                "dictionaryId": "ECDICT",
                "resourceSchemaVersion": "1",
                "resourceSha256": resource_sha256,
                "resourceCompressedBytes": str(compressed_bytes),
                "resourceJsonlSha256": raw_jsonl_sha256,
                "resourceUncompressedBytes": str(uncompressed_bytes),
                "entryCount": str(entries),
                "equivalence": "row_json contains each original JSONL row byte-for-byte excluding its line feed",
            }
            connection.executemany(
                "INSERT INTO fixture_metadata (name, value) VALUES (?, ?)", metadata.items()
            )
            connection.commit()
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            db_entries = connection.execute("SELECT count(*) FROM entries").fetchone()[0]
            readback = hashlib.sha256()
            readback_rows = 0
            for (row_text,) in connection.execute("SELECT row_json FROM entries ORDER BY ordinal"):
                readback.update(row_text.encode("utf-8"))
                readback.update(b"\n")
                readback_rows += 1
            if integrity != "ok" or db_entries != entries or readback_rows != entries:
                raise SystemExit("SQLite integrity or row-count verification failed")
            if readback.hexdigest() != raw_jsonl_sha256:
                raise SystemExit("SQLite JSONL readback differs from the frozen source")
            connection.execute("PRAGMA optimize")
            page_size = connection.execute("PRAGMA page_size").fetchone()[0]
            page_count = connection.execute("PRAGMA page_count").fetchone()[0]
            sample_queries = []
            for term in QUERY_TERMS:
                row = connection.execute(
                    "SELECT key, translation, phonetic FROM entries WHERE key = ?", (term,)
                ).fetchone()
                if row is None:
                    raise SystemExit(f"expected query term is missing from the source: {term}")
                sample_queries.append({"key": row[0], "translation": row[1], "phonetic": row[2]})
            missing_query = "__sqlite_opfs_benchmark_missing_key__"
            if connection.execute("SELECT 1 FROM entries WHERE key = ?", (missing_query,)).fetchone() is not None:
                raise SystemExit("missing-key query fixture unexpectedly exists in the resource")
        finally:
            connection.close()

        os.replace(temp_database, database)
    except BaseException:
        temp_database.unlink(missing_ok=True)
        raise

    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
    report = {
        "fixture": "ECDICT resource-v2 -> prebuilt SQLite database",
        "sourcePath": str(resource),
        "databasePath": str(database),
        "resourceSha256": resource_sha256,
        "resourceCompressedBytes": compressed_bytes,
        "resourceJsonlSha256": raw_jsonl_sha256,
        "resourceUncompressedBytes": uncompressed_bytes,
        "entryCount": entries,
        "databaseBytes": database.stat().st_size,
        "databaseSha256": sha256_file(database),
        "pageSize": page_size,
        "pageCount": page_count,
        "integrityCheck": integrity,
        "readbackJsonlSha256": readback.hexdigest(),
        "sampleQueries": sample_queries,
        "missingQuery": "__sqlite_opfs_benchmark_missing_key__",
        "equivalent": True,
        "buildWallMs": elapsed_ms,
        "python": sys.version.split()[0],
        "sqlite": sqlite3.sqlite_version,
    }
    print(json.dumps(report, indent=2))
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
