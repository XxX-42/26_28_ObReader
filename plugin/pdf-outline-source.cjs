/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { PDFDocument, PDFDict, PDFArray, PDFRef, PDFName, PDFNumber, PDFString, PDFHexString, PDFRawStream } = require("pdf-lib");
const PDFParser = require("pdf-lib/cjs/core/parser/PDFParser").default;
const { decodePDFRawStream } = require("pdf-lib/cjs/core/streams/decode");
const { Keywords } = require("pdf-lib/cjs/core/syntax/Keywords");
const { sha256 } = require("@noble/hashes/sha256");
const { createPdfHashRuntime } = require("./pdf-hash-runtime.cjs");
const { readSourceTrailer } = require("./pdf-incremental.cjs");
const VERSION = "outline-incremental-v1";
const verifiedProofs = /* @__PURE__ */ new Map();
let runtimeReady;
const LIMITS = Object.freeze({ revisions: 32, objects: 1e5, outlineNodes: 1e4, appendBytes: 16 * 1024 * 1024, sourceBytes: 512 * 1024 * 1024, depth: 64 });
const key = (name) => PDFName.of(name);
const refKey = (ref) => ref.toString();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
function fail(message) {
  throw Object.assign(new Error(message), { code: "PDF_OUTLINE_UPDATE_UNVERIFIED" });
}
function ensure(test, message) {
  if (!test) fail(message);
}
function integer(value, label) {
  ensure(value instanceof PDFNumber && Number.isSafeInteger(value.asNumber()) && value.asNumber() >= 0, `Invalid ${label}`);
  return value.asNumber();
}
function dictOf(value) {
  return value instanceof PDFRawStream ? value.dict : value;
}
function canonical(object, excluded = /* @__PURE__ */ new Set(), depth = 0) {
  ensure(depth <= LIMITS.depth, "Object nesting limit");
  if (object === void 0) return "undefined";
  if (object instanceof PDFRawStream) return `stream:${canonical(object.dict, excluded, depth + 1)}:${hex(sha256(object.contents))}`;
  if (object instanceof PDFDict) return "{" + object.entries().filter(([k]) => !excluded.has(k.decodeText())).map(([k, v]) => [k.toString(), canonical(v, /* @__PURE__ */ new Set(), depth + 1)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => k + ":" + v).join(",") + "}";
  if (object instanceof PDFArray) return "[" + object.asArray().map((v) => canonical(v, /* @__PURE__ */ new Set(), depth + 1)).join(",") + "]";
  return object.toString();
}
function parserAt(bytes, offset) {
  const p = PDFParser.forBytesWithOptions(bytes, Infinity, true, true);
  p.bytes.moveTo(offset);
  return p;
}
function indirect(bytes, offset, end = bytes.length) {
  ensure(Number.isSafeInteger(offset) && offset >= 0 && offset < end, "Invalid object offset");
  const p = parserAt(bytes, offset);
  const ref = p.parseIndirectObjectHeader();
  p.skipWhitespaceAndComments();
  const object = p.parseObject();
  p.skipWhitespaceAndComments();
  ensure(p.matchKeyword(Keywords.endobj), "Missing endobj");
  ensure(p.bytes.offset() <= end, "Object crosses revision");
  return { ref, object, end: p.bytes.offset() };
}
function readXref(bytes, offset) {
  ensure(Number.isSafeInteger(offset) && offset >= 0 && offset < bytes.length, "Invalid xref offset");
  let p = parserAt(bytes, offset), entries = [], dict, streamRef = null, end;
  if (bytes[offset] === 120) {
    ensure(p.matchKeyword(Keywords.xref), "Invalid xref keyword");
    const nums = /* @__PURE__ */ new Set();
    while (true) {
      p.skipWhitespaceAndComments();
      if (p.matchKeyword(Keywords.trailer)) break;
      const start = p.parseRawInt();
      p.skipWhitespaceAndComments();
      const count = p.parseRawInt();
      ensure(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(count) && count > 0 && count <= LIMITS.objects && entries.length + count <= LIMITS.objects, "Invalid xref range");
      for (let i = 0; i < count; i++) {
        p.skipWhitespaceAndComments();
        const pos = p.parseRawInt();
        p.skipWhitespaceAndComments();
        const gen = p.parseRawInt();
        p.skipWhitespaceAndComments();
        const flag = p.bytes.next();
        ensure((flag === 110 || flag === 102) && !nums.has(start + i) && Number.isSafeInteger(pos) && pos >= 0 && Number.isSafeInteger(gen) && gen >= 0 && gen <= 65535, "Invalid xref entry");
        nums.add(start + i);
        entries.push({ num: start + i, gen, type: flag === 110 ? 1 : 0, offset: pos });
      }
    }
    p.skipWhitespaceAndComments();
    dict = p.parseDict();
    end = p.bytes.offset();
  } else {
    const obj = indirect(bytes, offset);
    ensure(obj.object instanceof PDFRawStream && obj.object.dict.get(key("Type")) === key("XRef"), "Expected xref stream");
    dict = obj.object.dict;
    streamRef = obj.ref;
    end = obj.end;
    const w = dict.get(key("W"));
    ensure(w instanceof PDFArray && w.size() === 3, "Invalid xref widths");
    const widths = w.asArray().map((x) => integer(x, "xref width"));
    ensure(widths.every((x) => x <= 6) && widths.reduce((a, b) => a + b, 0) > 0, "Unsupported xref widths");
    const size = integer(dict.get(key("Size")), "xref size"), index = dict.get(key("Index"));
    const ranges = index === void 0 ? [0, size] : index instanceof PDFArray ? index.asArray().map((x) => integer(x, "xref index")) : [];
    ensure(ranges.length && ranges.length % 2 === 0, "Invalid xref index");
    let count = 0, last = -1;
    for (let i = 0; i < ranges.length; i += 2) {
      ensure(ranges[i] > last && ranges[i + 1] > 0 && ranges[i] + ranges[i + 1] <= size, "Overlapping xref ranges");
      last = ranges[i] + ranges[i + 1] - 1;
      count += ranges[i + 1];
    }
    ensure(count <= LIMITS.objects, "Xref entry limit");
    // Read at most the declared rows plus predictor bytes and one overflow
    // byte. A stream with extra decoded data must not silently gain entries.
    let data = decodePDFRawStream(obj.object).getBytes(count * (widths.reduce((a, b) => a + b, 0) + 1) + 1);
    const params = dict.get(key("DecodeParms"));
    if (params instanceof PDFDict) {
      const predictor = params.get(key("Predictor")) ? integer(params.get(key("Predictor")), "predictor") : 1;
      if (predictor !== 1) {
        const columns = integer(params.get(key("Columns")), "predictor columns"), colors = params.get(key("Colors")) ? integer(params.get(key("Colors")), "predictor colors") : 1, bits = params.get(key("BitsPerComponent")) ? integer(params.get(key("BitsPerComponent")), "predictor bits") : 8;
        ensure(predictor >= 10 && predictor <= 15 && colors === 1 && bits === 8 && columns === widths.reduce((a, b) => a + b, 0) && data.length === count * (columns + 1), "Unsupported xref predictor");
        const decoded = new Uint8Array(count * columns);
        for (let row = 0; row < count; row++) {
          const filter = data[row * (columns + 1)];
          ensure(filter <= 4, "Invalid PNG xref filter");
          for (let col = 0; col < columns; col++) {
            const left = col ? decoded[row * columns + col - 1] : 0, up = row ? decoded[(row - 1) * columns + col] : 0, upperLeft = row && col ? decoded[(row - 1) * columns + col - 1] : 0;
            let add = 0;
            if (filter === 1) add = left;
            else if (filter === 2) add = up;
            else if (filter === 3) add = Math.floor((left + up) / 2);
            else if (filter === 4) {
              const p2 = left + up - upperLeft, a = Math.abs(p2 - left), b = Math.abs(p2 - up), c = Math.abs(p2 - upperLeft);
              add = a <= b && a <= c ? left : b <= c ? up : upperLeft;
            }
            decoded[row * columns + col] = data[row * (columns + 1) + col + 1] + add & 255;
          }
        }
        data = decoded;
      }
    } else ensure(params === void 0, "Unsupported xref DecodeParms");
    ensure(data.length === count * widths.reduce((a, b) => a + b, 0), `Xref stream length mismatch at ${offset}: ${data.length} / ${count * widths.reduce((a, b) => a + b, 0)}`);
    let cursor = 0;
    const field = (n) => {
      let value = 0;
      for (let j = 0; j < n; j++) value = value * 256 + data[cursor++];
      ensure(Number.isSafeInteger(value), "Xref overflow");
      return value;
    };
    for (let i = 0; i < ranges.length; i += 2) for (let j = 0; j < ranges[i + 1]; j++) {
      const type = widths[0] ? field(widths[0]) : 1, offset2 = field(widths[1]), gen = field(widths[2]);
      ensure([0, 1, 2].includes(type), "Unknown xref type");
      entries.push({ num: ranges[i] + j, type, offset: offset2, gen });
    }
  }
  ensure(dict instanceof PDFDict && !dict.has(key("Encrypt")) && !dict.has(key("XRefStm")), "Encrypted/hybrid revisions are unsupported");
  const prev = dict.get(key("Prev"));
  const previous = prev === void 0 ? null : integer(prev, "Prev");
  ensure(previous === null || previous < offset, "Invalid xref chain");
  return { offset, entries, dict, previous, streamRef, end };
}
function eofAfter(bytes, revision) {
  const tail = new TextDecoder("latin1").decode(bytes.subarray(revision.end, Math.min(bytes.length, revision.end + 256)));
  const m = /^\s*startxref\s+(\d+)\s+%%EOF(?:\r\n|\r|\n)?/.exec(tail);
  ensure(m && Number(m[1]) === revision.offset, "Invalid revision EOF");
  return revision.end + m[0].length;
}
function resolve(map, value) {
  if (!(value instanceof PDFRef)) return value;
  const result = map.get(refKey(value));
  ensure(result !== void 0, "Missing referenced object " + value);
  return result;
}
function protectedRefs(map, root, info) {
  const seen = /* @__PURE__ */ new Set(), walk = (value, depth = 0) => {
    ensure(depth <= LIMITS.depth && seen.size <= LIMITS.objects, "Reference graph limit");
    if (value instanceof PDFRef) {
      const id = refKey(value);
      if (seen.has(id)) return;
      seen.add(id);
      walk(resolve(map, value), depth + 1);
      return;
    }
    const d = dictOf(value);
    if (d instanceof PDFDict) for (const [k, v] of d.entries()) walk(v, depth + 1);
    else if (value instanceof PDFArray) for (const v of value.asArray()) walk(v, depth + 1);
  };
  const catalog = resolve(map, root);
  ensure(catalog instanceof PDFDict && catalog.get(key("Type")) === key("Catalog"), "Invalid Catalog");
  seen.add(refKey(root));
  for (const [k, v] of catalog.entries()) if (k !== key("Outlines")) walk(v);
  if (info) walk(info);
  return seen;
}
function outlineRefs(map, root, pageRefs) {
  const ids = /* @__PURE__ */ new Set(), catalog = resolve(map, root), outline = catalog.get(key("Outlines"));
  if (outline === void 0) return ids;
  function add(ref) {
    ensure(ref instanceof PDFRef && !ids.has(refKey(ref)) && ids.size < LIMITS.outlineNodes, "Invalid/cyclic outline");
    ids.add(refKey(ref));
    const obj = resolve(map, ref);
    ensure(obj instanceof PDFDict, "Outline must be a dictionary");
    return obj;
  }
  function fields(d2, allowed) {
    ensure(d2.keys().every((k) => allowed.includes(k.decodeText())), "Unsupported outline field");
  }
  function dest(value) {
    const a = resolve(map, value);
    if (value instanceof PDFRef) {
      ensure(!ids.has(refKey(value)), "Shared destination object");
      ids.add(refKey(value));
    }
    ensure(a instanceof PDFArray && a.size() >= 2 && a.get(0) instanceof PDFRef && pageRefs.has(refKey(a.get(0))), "Non-page outline destination");
    const mode = a.get(1)?.toString(), arity = { "/XYZ": 5, "/Fit": 2, "/FitH": 3, "/FitV": 3, "/FitR": 6, "/FitB": 2, "/FitBH": 3, "/FitBV": 3 }[mode];
    ensure(arity && a.size() === arity, "Unsupported destination");
    for (let i = 2; i < a.size(); i++) ensure(a.get(i)?.toString() === "null" || a.get(i) instanceof PDFNumber && Number.isFinite(a.get(i).asNumber()), "Invalid destination coordinate");
  }
  function children(parentRef, parent, depth) {
    ensure(depth <= LIMITS.depth, "Outline depth limit");
    let next = parent.get(key("First")), last = null;
    const declaredLast = parent.get(key("Last"));
    ensure(Boolean(next) === Boolean(declaredLast), "Incomplete outline children");
    while (next) {
      const d2 = add(next);
      fields(d2, ["Title", "Parent", "Prev", "Next", "First", "Last", "Count", "Dest", "A", "C", "F"]);
      ensure(d2.get(key("Parent"))?.toString() === parentRef.toString(), "Outline parent mismatch");
      ensure((d2.get(key("Prev"))?.toString() || null) === (last?.toString() || null), "Outline sibling mismatch");
      ensure(d2.get(key("Title")) instanceof PDFString || d2.get(key("Title")) instanceof PDFHexString, "Invalid outline title");
      const count = d2.get(key("Count"));
      if (count !== void 0) ensure(count instanceof PDFNumber && Number.isSafeInteger(count.asNumber()), "Invalid outline Count");
      const flags = d2.get(key("F"));
      if (flags !== void 0) ensure(integer(flags, "outline flags") <= 3, "Invalid outline flags");
      const color = d2.get(key("C"));
      if (color !== void 0) ensure(color instanceof PDFArray && color.size() === 3 && color.asArray().every((v) => v instanceof PDFNumber && v.asNumber() >= 0 && v.asNumber() <= 1), "Invalid outline color");
      const destination = d2.get(key("Dest")), action = d2.get(key("A"));
      ensure(!(destination && action), "Ambiguous outline action");
      if (destination) dest(destination);
      if (action) {
        const a = action instanceof PDFRef ? add(action) : action;
        ensure(a instanceof PDFDict, "Invalid outline action");
        fields(a, ["S", "D"]);
        ensure(a.get(key("S")) === key("GoTo"), "Executable/nonlocal outline action");
        dest(a.get(key("D")));
      }
      children(next, d2, depth + 1);
      last = next;
      next = d2.get(key("Next"));
    }
    ensure((last?.toString() || null) === (declaredLast?.toString() || null), "Outline Last mismatch");
  }
  const d = add(outline);
  fields(d, ["Type", "Count", "First", "Last"]);
  ensure(d.get(key("Type")) === key("Outlines"), "Invalid outline root");
  if (d.has(key("Count"))) ensure(integer(d.get(key("Count")), "outline root Count") <= LIMITS.outlineNodes, "Outline root Count limit");
  children(outline, d, 0);
  return ids;
}
async function verifyOutlineUpdate({ bytes, source, expectedAfterHash } = {}) {
  const started = performance.now();
  ensure(bytes instanceof Uint8Array, "PDF bytes required");
  ensure(source && Number.isSafeInteger(source.size) && source.size > 0 && source.size < bytes.length, "Not an incremental append");
  ensure(bytes.length <= LIMITS.sourceBytes && bytes.length - source.size <= LIMITS.appendBytes, "PDF verification resource limit");
  const runtime = await (runtimeReady ||= createPdfHashRuntime());
  ensure(runtime.matches(bytes.subarray(0, source.size), source.sourceHash), "Original PDF prefix fingerprint differs");
  const afterHash = "sha256-v1:" + hex(sha256(bytes));
  ensure(!expectedAfterHash || runtime.matches(bytes, expectedAfterHash), "Expected new PDF hash differs");
  const proofKey = JSON.stringify([afterHash, source.sourceHash, source.size, source.pageCount, source.orderedPageIdentities]);
  if (verifiedProofs.has(proofKey)) {
    const cached = verifiedProofs.get(proofKey);
    verifiedProofs.delete(proofKey);
    verifiedProofs.set(proofKey, cached);
    return { ...JSON.parse(cached), cacheHit: true, elapsedMs: Math.round((performance.now() - started) * 10) / 10 };
  }
  const base = bytes.subarray(0, source.size), baseTrailer = readSourceTrailer(base), final = readSourceTrailer(bytes);
  ensure(!baseTrailer.encrypt && !final.encrypt, "Encrypted source");
  let cursor = final.xrefOffset;
  const revisions = [];
  while (cursor !== baseTrailer.xrefOffset) {
    ensure(cursor >= source.size && revisions.length < LIMITS.revisions, "Unrelated/overlong xref chain");
    const rev = readXref(bytes, cursor);
    revisions.push(rev);
    ensure(rev.previous !== null, "Missing original xref");
    cursor = rev.previous;
  }
  ensure(revisions.length > 0, "Missing incremental revision");
  revisions.reverse();
  const doc = await PDFDocument.load(base, { updateMetadata: false, throwOnInvalidObject: true });
  ensure(!doc.isEncrypted, "Encrypted source");
  const root = doc.context.trailerInfo.Root;
  ensure(root instanceof PDFRef && root.toString() === baseTrailer.root.toString(), "Original root mismatch");
  const map = new Map(doc.context.enumerateIndirectObjects().map(([r, o]) => [r.toString(), o]));
  ensure(map.size <= LIMITS.objects, "Object limit");
  let off = baseTrailer.xrefOffset;
  const visited = /* @__PURE__ */ new Set(), effective = /* @__PURE__ */ new Map();
  while (off !== null) {
    ensure(!visited.has(off) && visited.size < LIMITS.objects, "Original xref cycle");
    visited.add(off);
    const x = readXref(base, off);
    for (const e of x.entries) if (!effective.has(e.num)) effective.set(e.num, e);
    off = x.previous;
  }
  for (const [id] of map) {
    const [num, gen] = id.split(" ").map(Number), e = effective.get(num);
    if (!e || e.type === 0 || e.type === 1 && e.gen !== gen || e.type === 2 && gen !== 0) map.delete(id);
  }
  for (const e of effective.values()) if (e.type === 1) {
    const obj = indirect(base, e.offset);
    ensure(obj.ref.objectNumber === e.num && obj.ref.generationNumber === e.gen, "Original xref offset mismatch");
    if (obj.object instanceof PDFRawStream && [key("XRef"), key("ObjStm")].includes(obj.object.dict.get(key("Type")))) {
      map.set(refKey(obj.ref), obj.object);
    } else ensure(canonical(map.get(refKey(obj.ref))) === canonical(obj.object), "Original parser/xref disagreement " + JSON.stringify(e) + " parsed=" + obj.ref.toString() + " mapped=" + Boolean(map.get(refKey(obj.ref))));
  }
  ensure(Number.isSafeInteger(source.pageCount) && Array.isArray(source.orderedPageIdentities) && source.orderedPageIdentities.length === source.pageCount, "Verified original page identities required");
  const pages = doc.getPages();
  ensure(pages.length === source.pageCount, "Original page count mismatch");
  const pageRefs = new Set(pages.map((p, i) => {
    const id = `ref:${p.ref.objectNumber}R${p.ref.generationNumber || ""}`;
    ensure(id === source.orderedPageIdentities[i], "Original page order mismatch");
    return p.ref.toString();
  }));
  for (const obj of map.values()) {
    const d = dictOf(obj);
    if (d instanceof PDFDict) ensure(d.get(key("Type")) !== key("Sig") && !d.has(key("ByteRange")), "Signed PDFs unsupported");
  }
  let previousEnd = source.size, previousSize = baseTrailer.declaredSize, info = baseTrailer.info, revisionSummary = [];
  for (const rev of revisions) {
    ensure(rev.offset >= previousEnd && rev.dict.get(key("Root"))?.toString() === root.toString(), "Revision root mismatch");
    ensure(canonical(rev.dict.get(key("Info")) ?? info) === canonical(info), "Info changed");
    const permittedTrailer = /* @__PURE__ */ new Set(["Type", "Size", "Root", "Info", "ID", "Prev", "W", "Index", "Length", "Filter", "DecodeParms"]);
    ensure(rev.dict.keys().every((k) => permittedTrailer.has(k.decodeText())), "Unknown trailer field");
    const beforeOutline = outlineRefs(map, root, pageRefs), protectedBefore = protectedRefs(map, root, info);
    ensure(![...beforeOutline].some((k) => protectedBefore.has(k)), "Outline shares protected objects");
    if (rev.streamRef) {
      const id = refKey(rev.streamRef), old = map.get(id);
      ensure(!protectedBefore.has(id) && !beforeOutline.has(id) &&
        (!old || old instanceof PDFRawStream && old.dict.get(key("Type")) === key("XRef")),
        "xref bookkeeping replaces a protected/non-xref object");
      ensure(rev.entries.some(e => e.type === 1 && e.num === rev.streamRef.objectNumber &&
        e.gen === rev.streamRef.generationNumber && e.offset === rev.offset), "xref stream lacks its exact self entry");
    }
    const next = new Map(map), changed = [];
    const end = eofAfter(bytes, rev);
    const maxSize = integer(rev.dict.get(key("Size")), "trailer Size");
    ensure(maxSize >= previousSize, "xref Size regressed");
    for (const e of rev.entries) {
      ensure(e.num < maxSize, "xref exceeds Size");
      if (e.num === 0) {
        ensure(e.type === 0, "Invalid object zero");
        continue;
      }
      ensure(e.type !== 2, "Compressed incremental objects unsupported");
      if (e.type === 0) {
        for (const id of next.keys()) if (Number(id.split(" ")[0]) === e.num) next.delete(id);
        changed.push({ e, ref: PDFRef.of(e.num, e.gen), deleted: true });
        continue;
      }
      const parsed = indirect(bytes, e.offset, end);
      ensure(parsed.ref.objectNumber === e.num && parsed.ref.generationNumber === e.gen, "xref points to another object");
      if (e.offset < previousEnd) {
        const old = map.get(refKey(parsed.ref));
        ensure(old && canonical(old) === canonical(parsed.object), "xref redirects original object");
      } else ensure(e.offset < rev.offset || rev.streamRef?.toString() === parsed.ref.toString(), "Unexpected object after xref");
      for (const id of next.keys()) if (Number(id.split(" ")[0]) === e.num) next.delete(id);
      next.set(refKey(parsed.ref), parsed.object);
      changed.push({ ...parsed, e });
    }
    ensure(canonical(resolve(map, root), /* @__PURE__ */ new Set(["Outlines"])) === canonical(resolve(next, root), /* @__PURE__ */ new Set(["Outlines"])), "Non-outline Catalog changed");
    const afterOutline = outlineRefs(next, root, pageRefs), protectedAfter = protectedRefs(next, root, info);
    ensure(![...afterOutline].some((k) => protectedAfter.has(k)), "New outline shares protected objects");
    for (const change of changed) {
      const id = refKey(change.ref), old = map.get(id), current = next.get(id);
      if (id === root.toString()) continue;
      if (rev.streamRef?.toString() === id) {
        ensure(change.e.offset === rev.offset, "xref stream redirected");
        continue;
      }
      const permitted = beforeOutline.has(id) || afterOutline.has(id);
      if (change.deleted) {
        const deletedIds = [...map.keys()].filter((k) => Number(k.split(" ")[0]) === change.e.num);
        ensure(deletedIds.length > 0 && deletedIds.every((k) => beforeOutline.has(k) && !protectedBefore.has(k) && !protectedAfter.has(k)), "Protected/non-outline object deleted");
      } else if (!permitted) ensure(old && canonical(old) === canonical(current), "Protected/new non-outline object changed");
    }
    map.clear();
    for (const [k, v] of next) map.set(k, v);
    previousEnd = end;
    previousSize = maxSize;
    revisionSummary.push({ xrefOffset: rev.offset, outlineObjects: afterOutline.size });
  }
  ensure(bytes.subarray(previousEnd).every((b) => [0, 9, 10, 12, 13, 32].includes(b)), "Trailing unverified PDF bytes");
  const result = { status: "VERIFIED", verifierVersion: VERSION, beforeHash: source.sourceHash, beforeSize: source.size, afterHash, afterSize: bytes.length, pageCount: source.pageCount, orderedPageIdentities: source.orderedPageIdentities, revisions: revisionSummary, cacheHit: false, elapsedMs: Math.round((performance.now() - started) * 10) / 10 };
  verifiedProofs.set(proofKey, JSON.stringify(result));
  while (verifiedProofs.size > 8) verifiedProofs.delete(verifiedProofs.keys().next().value);
  return result;
}
module.exports = { verifyOutlineUpdate, VERSION, LIMITS };
