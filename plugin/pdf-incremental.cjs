"use strict";

const { sha256 } = require("@noble/hashes/sha256");
const {
  PDFArray,
  PDFCatalog,
  PDFCrossRefSection,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
} = require("pdf-lib");
const PDFParser = require("pdf-lib/cjs/core/parser/PDFParser").default;
const PDFStream = require("pdf-lib/cjs/core/objects/PDFStream").default;
const PDFXRefStreamParser = require("pdf-lib/cjs/core/parser/PDFXRefStreamParser").default;
const { Keywords } = require("pdf-lib/cjs/core/syntax/Keywords");

const WS = new Set([0, 9, 10, 12, 13, 32]);
const ASCII_EOF = [37, 37, 69, 79, 70]; // %%EOF
const ASCII_STARTXREF = [115, 116, 97, 114, 116, 120, 114, 101, 102];
const STREAM_OPEN = new TextEncoder().encode("\nstream\n");
const STREAM_CLOSE = new TextEncoder().encode("\nendstream");
let activeHashRuntime = null;

class PdfIncrementalError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = "PdfIncrementalError";
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function fail(code, message, cause) {
  throw new PdfIncrementalError(code, message, cause);
}

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  fail("PDF_INCREMENTAL_INVALID_BYTES", "The incremental PDF source must be a byte array.");
}

function toHex(bytes) {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function fingerprint(bytes) {
  if (activeHashRuntime) return activeHashRuntime.fingerprint(bytes);
  return toHex(sha256(bytes));
}

function fingerprintConcat(prefix, suffix) {
  if (activeHashRuntime) return activeHashRuntime.fingerprintChunks([prefix, suffix]);
  const hash = sha256.create();
  hash.update(prefix);
  hash.update(suffix);
  return toHex(hash.digest());
}

function setHashRuntime(runtime) {
  activeHashRuntime = runtime || null;
}

function sameRef(left, right) {
  return left instanceof PDFRef && right instanceof PDFRef && left.toString() === right.toString();
}

function parseFinalStartXref(bytes) {
  let cursor = bytes.length;
  while (cursor > 0 && WS.has(bytes[cursor - 1])) cursor -= 1;
  if (cursor < ASCII_EOF.length) fail("PDF_INCREMENTAL_INVALID_EOF", "The PDF has no final %%EOF marker.");
  for (let index = 0; index < ASCII_EOF.length; index += 1) {
    if (bytes[cursor - ASCII_EOF.length + index] !== ASCII_EOF[index]) {
      fail("PDF_INCREMENTAL_INVALID_EOF", "The PDF has no final %%EOF marker.");
    }
  }
  cursor -= ASCII_EOF.length;
  while (cursor > 0 && WS.has(bytes[cursor - 1])) cursor -= 1;

  const digitsEnd = cursor;
  while (cursor > 0 && bytes[cursor - 1] >= 48 && bytes[cursor - 1] <= 57) cursor -= 1;
  if (cursor === digitsEnd) fail("PDF_INCREMENTAL_INVALID_STARTXREF", "The final startxref offset is missing.");
  if (digitsEnd - cursor > 16) fail("PDF_INCREMENTAL_INVALID_STARTXREF", "The final startxref offset is too large.");
  let xrefOffset = 0;
  for (let index = cursor; index < digitsEnd; index += 1) {
    xrefOffset = xrefOffset * 10 + bytes[index] - 48;
  }
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset < 0 || xrefOffset >= bytes.length) {
    fail("PDF_INCREMENTAL_INVALID_STARTXREF", "The final startxref offset is outside the PDF.");
  }
  while (cursor > 0 && WS.has(bytes[cursor - 1])) cursor -= 1;
  if (cursor < ASCII_STARTXREF.length) fail("PDF_INCREMENTAL_INVALID_STARTXREF", "The final startxref keyword is missing.");
  const keywordStart = cursor - ASCII_STARTXREF.length;
  for (let index = 0; index < ASCII_STARTXREF.length; index += 1) {
    if (bytes[keywordStart + index] !== ASCII_STARTXREF[index]) {
      fail("PDF_INCREMENTAL_INVALID_STARTXREF", "The final startxref keyword is missing.");
    }
  }
  if (keywordStart > 0 && !WS.has(bytes[keywordStart - 1])) {
    fail("PDF_INCREMENTAL_INVALID_STARTXREF", "The final startxref keyword is not delimited.");
  }
  return xrefOffset;
}

function parserFor(bytes) {
  try {
    return PDFParser.forBytesWithOptions(bytes, Infinity, true, true);
  } catch (error) {
    fail("PDF_INCREMENTAL_INVALID_TRAILER", "The PDF trailer could not be parsed safely.", error);
  }
}

function readXrefStreamAt(bytes, offset) {
  const parser = parserFor(bytes);
  try {
    if (bytes[offset] < 48 || bytes[offset] > 57) {
      fail("PDF_INCREMENTAL_INVALID_STARTXREF", "The startxref offset does not point to an indirect xref stream object.");
    }
    parser.bytes.moveTo(offset);
    const ref = parser.parseIndirectObjectHeader();
    parser.skipWhitespaceAndComments();
    const object = parser.parseObject();
    parser.skipWhitespaceAndComments();
    if (!parser.matchKeyword(Keywords.endobj)) {
      fail("PDF_INCREMENTAL_INVALID_XREF_STREAM", "The xref stream object is missing endobj.");
    }
    if (!(object instanceof PDFRawStream) || object.dict.lookup(PDFName.of("Type")) !== PDFName.of("XRef")) {
      fail("PDF_INCREMENTAL_INVALID_STARTXREF", "The startxref offset does not point to an xref stream.");
    }
    const xrefParser = PDFXRefStreamParser.forStream(object);
    xrefParser.parseIntoContext();
    const dict = object.dict;
    return { ref, dict, xrefParser };
  } catch (error) {
    if (error instanceof PdfIncrementalError) throw error;
    fail("PDF_INCREMENTAL_INVALID_XREF_STREAM", "The xref stream could not be parsed safely.", error);
  }
}

function readClassicXrefAt(bytes, offset) {
  const parser = parserFor(bytes);
  try {
    parser.bytes.moveTo(offset);
    if (!parser.matchKeyword(Keywords.xref)) {
      fail("PDF_INCREMENTAL_INVALID_STARTXREF", "The startxref offset does not point to an xref table.");
    }
    parser.bytes.moveTo(offset);
    parser.maybeParseCrossRefSection();
    if (parser.bytes.offset() <= offset) {
      fail("PDF_INCREMENTAL_INVALID_XREF_TABLE", "The xref table could not be parsed.");
    }
    parser.skipWhitespaceAndComments();
    if (!parser.matchKeyword(Keywords.trailer)) {
      fail("PDF_INCREMENTAL_INVALID_TRAILER", "The xref table has no trailer dictionary.");
    }
    parser.skipWhitespaceAndComments();
    const dict = parser.parseDict();
    return { dict };
  } catch (error) {
    if (error instanceof PdfIncrementalError) throw error;
    fail("PDF_INCREMENTAL_INVALID_XREF_TABLE", "The xref table or trailer could not be parsed safely.", error);
  }
}

function readSourceTrailer(input, document = null) {
  const bytes = asBytes(input);
  const xrefOffset = parseFinalStartXref(bytes);
  let current;
  if (bytes[xrefOffset] === 120) current = readClassicXrefAt(bytes, xrefOffset);
  else current = readXrefStreamAt(bytes, xrefOffset);
  const dict = current.dict;
  const root = dict.get(PDFName.of("Root"));
  const size = dict.get(PDFName.of("Size"));
  if (!(root instanceof PDFRef) || !(size instanceof PDFNumber)) {
    fail("PDF_INCREMENTAL_INVALID_TRAILER", "The latest PDF trailer must include a valid /Root reference and /Size value.");
  }
  const declaredSize = size.asNumber();
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 1) {
    fail("PDF_INCREMENTAL_INVALID_TRAILER", "The latest PDF trailer has an invalid /Size value.");
  }
  const previous = dict.get(PDFName.of("Prev"));
  if (previous !== undefined && (!(previous instanceof PDFNumber) || !Number.isSafeInteger(previous.asNumber()) || previous.asNumber() < 0 || previous.asNumber() >= xrefOffset)) {
    fail("PDF_INCREMENTAL_INVALID_TRAILER", "The latest PDF trailer has an invalid /Prev offset.");
  }
  const hybrid = dict.get(PDFName.of("XRefStm"));
  if (hybrid !== undefined) {
    if (!(hybrid instanceof PDFNumber) || !Number.isSafeInteger(hybrid.asNumber()) || hybrid.asNumber() < 0 || hybrid.asNumber() >= xrefOffset) {
      fail("PDF_INCREMENTAL_INVALID_TRAILER", "The hybrid xref stream offset is invalid.");
    }
    const hybridInfo = readXrefStreamAt(bytes, hybrid.asNumber());
    if (!sameRef(hybridInfo.dict.get(PDFName.of("Root")), root)) {
      fail("PDF_INCREMENTAL_INVALID_TRAILER", "The hybrid xref table and stream disagree about the catalog root.");
    }
  }
  const encrypt = dict.get(PDFName.of("Encrypt"));
  if (encrypt !== undefined && document) {
    fail("PDF_INCREMENTAL_ENCRYPTED_DOCUMENT", "Encrypted PDFs cannot be updated through the incremental writer.");
  }
  if (document) {
    const context = document.context;
    if (context.trailerInfo.Encrypt || encrypt) {
      fail("PDF_INCREMENTAL_ENCRYPTED_DOCUMENT", "Encrypted PDFs cannot be updated through the incremental writer.");
    }
    if (!sameRef(context.trailerInfo.Root, root)) {
      fail("PDF_INCREMENTAL_INVALID_TRAILER", "The parsed document catalog does not match the final xref trailer.");
    }
    if (declaredSize < context.largestObjectNumber + 1) {
      fail("PDF_INCREMENTAL_INVALID_TRAILER", "The trailer /Size is smaller than the parsed object numbers.");
    }
    const catalog = context.lookup(root);
    if (!(catalog instanceof PDFCatalog) || catalog.get(PDFName.of("Type")) !== PDFName.of("Catalog")) {
      fail("PDF_INCREMENTAL_INVALID_TRAILER", "The final trailer /Root does not resolve to a usable catalog.");
    }
  }
  return {
    xrefOffset,
    root,
    declaredSize,
    previous: previous instanceof PDFNumber ? previous.asNumber() : null,
    info: dict.get(PDFName.of("Info")),
    id: dict.get(PDFName.of("ID")),
    encrypt,
  };
}

function hashPdfStream(object, scratchState, measuredSize) {
  let contents;
  let dictionarySize;
  try {
    // PDFStream.sizeInBytes() refreshes /Length just as copyBytesInto() does.
    // Hash the stream framing and its existing contents view separately so a
    // multi-megabyte image never needs a same-sized scratch copy.
    contents = object.getContents();
    dictionarySize = object.dict.sizeInBytes();
  } catch (error) {
    fail("PDF_INCREMENTAL_UNSERIALIZABLE_OBJECT", "A PDF stream could not be inspected for change detection.", error);
  }
  if (!(contents instanceof Uint8Array) || object.getContentsSize() !== contents.length) {
    fail("PDF_INCREMENTAL_UNSERIALIZABLE_OBJECT", "A PDF stream returned an inconsistent contents view.");
  }
  if (!Number.isSafeInteger(dictionarySize) || dictionarySize < 0 || measuredSize !== dictionarySize + contents.length + 18) {
    fail("PDF_INCREMENTAL_UNSERIALIZABLE_OBJECT", "A PDF stream reported an inconsistent serialized size.");
  }
  if (scratchState.buffer.length < dictionarySize) scratchState.buffer = new Uint8Array(dictionarySize);
  let written;
  try {
    written = object.dict.copyBytesInto(scratchState.buffer, 0);
  } catch (error) {
    fail("PDF_INCREMENTAL_UNSERIALIZABLE_OBJECT", "A PDF stream dictionary could not be serialized for change detection.", error);
  }
  if (written !== dictionarySize) fail("PDF_INCREMENTAL_UNSERIALIZABLE_OBJECT", "A PDF stream dictionary reported an inconsistent serialized size.");
  const chunks = [scratchState.buffer.subarray(0, written), STREAM_OPEN, contents, STREAM_CLOSE];
  if (activeHashRuntime) return activeHashRuntime.fingerprintChunks(chunks);
  const hash = sha256.create();
  for (const chunk of chunks) hash.update(chunk);
  return toHex(hash.digest());
}

function hashPdfObject(object, scratchState) {
  let size;
  try {
    size = object.sizeInBytes();
  } catch (error) {
    fail("PDF_INCREMENTAL_UNSERIALIZABLE_OBJECT", "A PDF object could not be measured for incremental serialization.", error);
  }
  if (!Number.isSafeInteger(size) || size < 0) fail("PDF_INCREMENTAL_UNSERIALIZABLE_OBJECT", "A PDF object has an invalid serialized size.");
  if (object instanceof PDFStream) return hashPdfStream(object, scratchState, size);
  if (scratchState.buffer.length < size) scratchState.buffer = new Uint8Array(size);
  let written;
  try {
    written = object.copyBytesInto(scratchState.buffer, 0);
  } catch (error) {
    fail("PDF_INCREMENTAL_UNSERIALIZABLE_OBJECT", "A PDF object could not be serialized for change detection.", error);
  }
  if (written !== size) fail("PDF_INCREMENTAL_UNSERIALIZABLE_OBJECT", "A PDF object reported an inconsistent serialized size.");
  return fingerprint(scratchState.buffer.subarray(0, written));
}

function snapshotObjects(document) {
  const objectHashes = new Map();
  const scratch = { buffer: new Uint8Array(0) };
  try {
    for (const [ref, object] of document.context.enumerateIndirectObjects()) {
      objectHashes.set(ref.toString(), hashPdfObject(object, scratch));
    }
  } catch (error) {
    if (error instanceof PdfIncrementalError) throw error;
    fail("PDF_INCREMENTAL_SNAPSHOT_FAILED", "The source PDF objects could not be snapshotted safely.", error);
  }
  return objectHashes;
}

function captureIncrementalSnapshot({ sourceBytes, document }) {
  const bytes = asBytes(sourceBytes);
  const trailer = readSourceTrailer(bytes, document);
  // pdf-lib chooses new object numbers from the highest parsed live object.
  // A valid source can have free numbers above that object, so keep future
  // allocations beyond the source trailer's complete object-number range.
  document.context.largestObjectNumber = Math.max(
    document.context.largestObjectNumber,
    trailer.declaredSize - 1,
  );
  return {
    baseLength: bytes.length,
    baseFingerprint: fingerprint(bytes),
    root: trailer.root.toString(),
    xrefOffset: trailer.xrefOffset,
    declaredSize: trailer.declaredSize,
    objectHashes: snapshotObjects(document),
  };
}

function textBytes(text) {
  return new TextEncoder().encode(text);
}

function writeBytes(buffer, offset, bytes) {
  buffer.set(bytes, offset);
  return offset + bytes.length;
}

function writeObject(buffer, offset, ref, object) {
  offset = writeBytes(buffer, offset, textBytes(`${ref.objectNumber} ${ref.generationNumber} obj\n`));
  const written = object.copyBytesInto(buffer, offset);
  offset += written;
  offset = writeBytes(buffer, offset, textBytes("\nendobj\n\n"));
  return offset;
}

function createIncrementalPatch({ sourceBytes, document, snapshot, allowInfoChange = false }) {
  const base = asBytes(sourceBytes);
  if (!snapshot || snapshot.baseLength !== base.length || snapshot.baseFingerprint !== fingerprint(base)) {
    fail("PDF_INCREMENTAL_BASE_MISMATCH", "The incremental snapshot does not belong to these exact source bytes.");
  }
  // The target context can already contain merge-created refs above the
  // source trailer's /Size. Validate the immutable source independently;
  // output /Size is computed from the current context below.
  const trailer = readSourceTrailer(base);
  if (trailer.encrypt !== undefined || document.context.trailerInfo.Encrypt) {
    fail("PDF_INCREMENTAL_ENCRYPTED_DOCUMENT", "Encrypted PDFs cannot be updated through the incremental writer.");
  }
  if (snapshot.root !== trailer.root.toString() || snapshot.xrefOffset !== trailer.xrefOffset) {
    fail("PDF_INCREMENTAL_BASE_MISMATCH", "The incremental snapshot no longer matches the source PDF trailer.");
  }

  const context = document.context;
  const scratch = { buffer: new Uint8Array(0) };
  const objects = context.enumerateIndirectObjects()
    .filter(([ref, object]) => snapshot.objectHashes.get(ref.toString()) !== hashPdfObject(object, scratch))
    .sort(([left], [right]) => left.objectNumber - right.objectNumber || left.generationNumber - right.generationNumber);
  if (!objects.length) return null;
  for (let index = 1; index < objects.length; index += 1) {
    if (objects[index - 1][0].objectNumber === objects[index][0].objectNumber) {
      fail("PDF_INCREMENTAL_DUPLICATE_GENERATION", `Object ${objects[index][0].objectNumber} has multiple changed generations and cannot be updated in one classic xref section.`);
    }
  }

  const currentRoot = context.trailerInfo.Root;
  if (!(currentRoot instanceof PDFRef) || currentRoot.toString() !== snapshot.root) {
    fail("PDF_INCREMENTAL_ROOT_CHANGED", "Changing the catalog root is not supported by the incremental writer.");
  }
  const maxObjectNumber = Math.max(context.largestObjectNumber, snapshot.declaredSize - 1);
  const size = Math.max(snapshot.declaredSize, maxObjectNumber + 1);
  const trailerDict = PDFDict.withContext(context);
  trailerDict.set(PDFName.of("Size"), PDFNumber.of(size));
  trailerDict.set(PDFName.of("Root"), trailer.root);
  const info = allowInfoChange ? context.trailerInfo.Info : trailer.info;
  if (info !== undefined) {
    if (allowInfoChange && (!(info instanceof PDFRef) || !(context.lookup(info) instanceof PDFDict))) {
      fail("PDF_INCREMENTAL_INVALID_INFO", "The replacement Info must reference a dictionary.");
    }
    trailerDict.set(PDFName.of("Info"), info);
  }
  if (trailer.id !== undefined) {
    if (!(trailer.id instanceof PDFArray)) fail("PDF_INCREMENTAL_INVALID_TRAILER", "The final trailer /ID value is not an array.");
    trailerDict.set(PDFName.of("ID"), trailer.id);
  }
  trailerDict.set(PDFName.of("Prev"), PDFNumber.of(snapshot.xrefOffset));

  const xref = PDFCrossRefSection.createEmpty();
  const sourcePrefix = 1; // One newline separates prior %%EOF from this revision.
  let nextOffset = base.length + sourcePrefix;
  const objectOffsets = [];
  for (const [ref, object] of objects) {
    objectOffsets.push(nextOffset);
    const objectSize = ref.sizeInBytes() + 3 + object.sizeInBytes() + 9;
    if (!Number.isSafeInteger(objectSize) || objectSize < 0) fail("PDF_INCREMENTAL_UNSERIALIZABLE_OBJECT", `Object ${ref} has an invalid serialized size.`);
    nextOffset += objectSize;
  }
  const xrefOffset = nextOffset;
  if (xrefOffset > 9_999_999_999) fail("PDF_INCREMENTAL_XREF_OFFSET_OVERFLOW", "The incremental xref table cannot address a PDF larger than ten billion bytes.");
  for (let index = 0; index < objects.length; index += 1) xref.addEntry(objects[index][0], objectOffsets[index]);

  const trailerText = `trailer\n${trailerDict.toString()}\n\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const trailerBytes = textBytes(trailerText);
  const xrefSize = xref.sizeInBytes() + 1;
  const suffixLength = sourcePrefix + (nextOffset - (base.length + sourcePrefix)) + xrefSize + trailerBytes.length;
  const suffix = new Uint8Array(suffixLength);
  let offset = 0;
  suffix[offset++] = 10;
  for (const [ref, object] of objects) offset = writeObject(suffix, offset, ref, object);
  offset += xref.copyBytesInto(suffix, offset);
  suffix[offset++] = 10;
  offset = writeBytes(suffix, offset, trailerBytes);
  if (offset !== suffix.length) fail("PDF_INCREMENTAL_SERIALIZATION_SIZE_MISMATCH", "The incremental update did not match its measured size.");

  const outputLength = base.length + suffix.length;
  return {
    baseLength: base.length,
    baseFingerprint: snapshot.baseFingerprint,
    suffix,
    outputLength,
    outputFingerprint: fingerprintConcat(base, suffix),
    xrefOffset,
    changedObjectCount: objects.length,
  };
}

function concatenate(base, suffix) {
  const result = new Uint8Array(base.length + suffix.length);
  result.set(base, 0);
  result.set(suffix, base.length);
  return result;
}

function materializeIncrementalResult({ sourceBytes, patch, patchOnly = false }) {
  if (!patch) return { bytes: null, patch: null };
  const base = asBytes(sourceBytes);
  return {
    ...(patchOnly ? {} : { bytes: concatenate(base, patch.suffix) }),
    patch: {
      baseLength: patch.baseLength,
      baseFingerprint: patch.baseFingerprint,
      suffix: patch.suffix,
      outputLength: patch.outputLength,
      outputFingerprint: patch.outputFingerprint,
      xrefOffset: patch.xrefOffset,
      changedObjectCount: patch.changedObjectCount,
    },
  };
}

module.exports = {
  PdfIncrementalError,
  captureIncrementalSnapshot,
  createIncrementalPatch,
  materializeIncrementalResult,
  readSourceTrailer,
  fingerprint,
  setHashRuntime,
  _internals: {
    parseFinalStartXref,
    hashPdfObject,
    snapshotObjects,
    concatenate,
  },
};
