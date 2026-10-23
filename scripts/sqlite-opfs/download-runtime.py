#!/usr/bin/env python3
"""Fetch and verify the pinned official SQLite WASM release into ignored artifacts."""

import argparse
import hashlib
import json
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path


URL = "https://www.sqlite.org/2026/sqlite-wasm-3540100.zip"
EXPECTED_SHA3_256 = "87e24f6a4588692310b7942dc2fa7c7275bb9ba2e01d553e4115aa4a904a0050"
PREFIX = "sqlite-wasm-3540100/"
JSWASM_FILES = ("sqlite3.js", "sqlite3.wasm", "sqlite3-opfs-async-proxy.js")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path,
                        nargs="?", default=Path("tests/artifacts/sqlite-opfs-2026-10-23"))
    args = parser.parse_args()
    destination = args.destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    archive_path = destination / "sqlite-wasm-3540100.zip"
    with tempfile.NamedTemporaryFile(prefix="sqlite-wasm-3540100-", suffix=".zip", delete=False) as temp:
        temp_path = Path(temp.name)
    try:
        with urllib.request.urlopen(URL, timeout=60) as response, temp_path.open("wb") as output:
            shutil.copyfileobj(response, output)
        digest = hashlib.sha3_256(temp_path.read_bytes()).hexdigest()
        if digest != EXPECTED_SHA3_256:
            raise SystemExit(f"official SQLite archive SHA3-256 mismatch: {digest}")
        shutil.copyfile(temp_path, archive_path)
    finally:
        temp_path.unlink(missing_ok=True)

    asset_directory = destination / "runtime/sqlite-wasm-3540100/jswasm"
    asset_directory.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path) as archive:
        for name in JSWASM_FILES:
            member = PREFIX + "jswasm/" + name
            (asset_directory / name).write_bytes(archive.read(member))
        sqlite_bundle = archive.read(PREFIX + "jswasm/sqlite3.js").decode("utf-8")
        notice = sqlite_bundle.split("*/", 1)[0] + "*/\n"
        (destination / "SQLITE-NOTICE.txt").write_text(notice, encoding="utf-8")
        readme = archive.read(PREFIX + "README.txt")
        (destination / "SQLITE-README.txt").write_bytes(readme)
    print(json.dumps({"url": URL, "sha3_256": digest, "archiveBytes": archive_path.stat().st_size,
                      "assets": [str(asset_directory / name) for name in JSWASM_FILES]}, indent=2))


if __name__ == "__main__":
    main()
