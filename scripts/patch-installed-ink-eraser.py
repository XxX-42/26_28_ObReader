"""Apply only the stroke-eraser delta to an installed, newer three-file build.

Never replaces the installed host/runtime with this checkout's older build.
Fails if an expected patch context is absent or ambiguous.
"""
import argparse
import base64
import difflib
import gzip
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--input', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
source = args.input.read_text()
marker = 'const VIEWER_ASSET_PAYLOAD = '
start = source.index(marker) + len(marker)
payload, length = json.JSONDecoder().raw_decode(source[start:])
changed = []
for entry in payload['files']:
    raw = gzip.decompress(base64.b64decode(entry['gzipBase64']))
    assert len(raw) == entry['size'] and hashlib.sha256(raw).hexdigest() == entry['sha256'], entry['path']
for relative, target in [
    ('vendor/pdfjs-generic-legacy/build/pdf.mjs', 'build/pdf.mjs'),
    ('vendor/pdfjs-generic-legacy/web/viewer.mjs', 'web/viewer.mjs'),
    ('viewer-adapter/obsidian-bridge.js', 'web/obsidian-bridge.js'),
]:
    entry = next(item for item in payload['files'] if item['path'] == target)
    text = gzip.decompress(base64.b64decode(entry['gzipBase64'])).decode()
    before = subprocess.check_output(['git', 'show', 'eb697bb41ca51da1b710698d639723a320702de2:' + relative], cwd=root, text=True).splitlines(keepends=True)
    after = (root / relative).read_text().splitlines(keepends=True)
    for group in difflib.SequenceMatcher(None, before, after, autojunk=False).get_grouped_opcodes(3):
        old = ''.join(before[group[0][1]:group[-1][2]])
        new = ''.join(after[group[0][3]:group[-1][4]])
        assert text.count(old) == 1, (target, 'missing/ambiguous delta context')
        text = text.replace(old, new, 1)
    raw = text.encode()
    entry.update(size=len(raw), sha256=hashlib.sha256(raw).hexdigest(),
                 gzipBase64=base64.b64encode(gzip.compress(raw, mtime=0)).decode())
    changed.append(target)
rows = ''.join(item['path'] + '\t' + str(item['size']) + '\t' + item['sha256'] + '\n'
               for item in sorted(payload['files'], key=lambda item: item['path']))
payload['contentHash'] = hashlib.sha256(('pdf-web-reader-assets\n' + str(payload['schema']) + '\n' + payload['id'] + '\n' + rows).encode()).hexdigest()
result = source[:start] + json.dumps(payload, separators=(',', ':')) + source[start + length:]
# The existing native erase/restore routing needs the same narrow Ink adapter
# in the newer host bundle. All other host code remains byte-for-byte intact.
for old in [
    'operation.deleted === true && operation.provenance === "embedded");',
    'operation.provenance === "embedded" && operation.deleted !== true);',
]:
    new = old[:-2] + ' && operation.kind !== "Ink");'
    assert result.count(old) == 1, 'missing/ambiguous native host dispatch'
    result = result.replace(old, new, 1)
marker = 'return input.map((item) => {'
# This normalizer occurs once in the bundled Annotation Host.
assert result.count(marker) == 1, 'missing/ambiguous operation normalizer'
result = result.replace(marker, 'input = structuredClone(input);\n          ' + marker, 1)
args.output.write_text(result)
print(json.dumps({'sha256': hashlib.sha256(result.encode()).hexdigest(), 'payload': payload['contentHash'], 'changedAssets': changed}))
