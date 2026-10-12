"use strict";

const {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObjectCopier,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} = require("pdf-lib");
const { sha256 } = require("@noble/hashes/sha256");

const LEDGER_KEY = PDFName.of("ObReaderMerge");
const UUID_KEY = PDFName.of("ObReaderId");
const ANNOTS_KEY = PDFName.of("Annots");
const SUBTYPE_TO_KIND = new Map([
  ["FreeText", "freetext"],
  ["Square", "square"],
  ["Underline", "underline"],
  ["Highlight", "highlight"],
  ["Ink", "ink"],
]);
const KIND_TO_SUBTYPE = new Map(
  [...SUBTYPE_TO_KIND].map(([subtype, kind]) => [kind, subtype]),
);
const OMIT_PAGE_KEYS = new Set(["Annots", "Parent", "StructParents"]);
const OMIT_ANNOTATION_HASH_KEYS = new Set([
  "P",
  "Popup",
  "Parent",
  "IRT",
  "ObReaderId",
  // PDF.js updates /M when it writes the annotation; it is not a semantic edit.
  "M",
  "CreationDate",
]);

class PdfMergeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "PdfMergeError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new PdfMergeError(code, message, details);
}

function asBytes(input, label) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  fail("PDF_MERGE_INVALID_BYTES", `${label} must be PDF bytes.`);
}

function toHex(bytes) {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function hashBytes(bytes) {
  return toHex(sha256(bytes));
}

function hashText(text) {
  return hashBytes(new TextEncoder().encode(text));
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function errorFromLoad(error, label) {
  if (error instanceof PdfMergeError) return error;
  const message = String(error?.message || error || "Unknown PDF parse error");
  const encrypted = /encrypt|password|decrypt/i.test(message);
  return new PdfMergeError(
    encrypted ? "PDF_MERGE_ENCRYPTED_DOCUMENT" : "PDF_MERGE_INVALID_DOCUMENT",
    `${label} could not be read safely: ${message}`,
  );
}

async function loadPdf(bytes, label) {
  try {
    return await PDFDocument.load(asBytes(bytes, label), {
      ignoreEncryption: false,
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
  } catch (error) {
    throw errorFromLoad(error, label);
  }
}

function nameKey(name) {
  const text = name.asString();
  return text.startsWith("/") ? text.slice(1) : text;
}

function getName(dict, key) {
  const value = dict.get(PDFName.of(key));
  return value instanceof PDFName ? nameKey(value) : null;
}

function isFreehandHighlight(entry) {
  return entry?.subtype === "Ink" && getName(entry.dict, "IT") === "InkHighlight";
}

function operationKindMatches(actualKind, expectedKind, entry = null) {
  const actual = String(actualKind || "").toLowerCase();
  const expected = String(expectedKind || "").toLowerCase();
  return actual === expected || (
    ((actual === "ink" && expected === "highlight") ||
      (actual === "highlight" && expected === "ink")) &&
    isFreehandHighlight(entry)
  );
}

function resolve(context, value) {
  return value instanceof PDFRef ? context.lookup(value) : value;
}

function refText(ref) {
  return ref instanceof PDFRef ? ref.toString() : null;
}

function parseReference(value) {
  if (value instanceof PDFRef) return value;
  if (typeof value !== "string") return null;
  const pdfJs = /^(\d+)R(\d*)$/.exec(value);
  if (pdfJs && Number(pdfJs[1]) > 0) {
    return PDFRef.of(Number(pdfJs[1]), pdfJs[2] ? Number(pdfJs[2]) : 0);
  }
  const pdfLib = /^(\d+)\s+(\d+)\s+R$/.exec(value);
  if (pdfLib && Number(pdfLib[1]) > 0) {
    return PDFRef.of(Number(pdfLib[1]), Number(pdfLib[2]));
  }
  return null;
}

function pdfJsRef(value) {
  const ref = parseReference(value);
  if (!ref) return null;
  return ref.generationNumber === 0
    ? `${ref.objectNumber}R`
    : `${ref.objectNumber}R${ref.generationNumber}`;
}

function pdfLibRef(value) {
  const ref = parseReference(value);
  return ref?.toString() || null;
}

function decodePdfString(value) {
  if (value instanceof PDFHexString || value instanceof PDFString) {
    return value.decodeText();
  }
  return null;
}

function readUuid(dict) {
  return decodePdfString(dict.get(UUID_KEY));
}

function setUuid(dict, uuid) {
  dict.set(UUID_KEY, PDFHexString.fromText(uuid));
}

function refMaps(doc) {
  const pageRefs = new Map();
  doc.getPages().forEach((page, index) => {
    if (page.ref instanceof PDFRef) pageRefs.set(page.ref.toString(), index);
  });
  const annotations = [];
  const byRef = new Map();
  const byPage = [];
  for (const [pageIndex, page] of doc.getPages().entries()) {
    const array = page.node.lookupMaybe(ANNOTS_KEY, PDFArray);
    const entries = [];
    if (array) {
      for (let order = 0; order < array.size(); order += 1) {
        const raw = array.get(order);
        const ref = raw instanceof PDFRef ? raw : doc.context.getObjectRef(raw);
        const dict = resolve(doc.context, raw);
        if (!(dict instanceof PDFDict) || !(ref instanceof PDFRef)) {
          fail(
            "PDF_MERGE_UNSUPPORTED_ANNOTATION_TREE",
            `Page ${pageIndex + 1} contains an annotation without a stable indirect reference.`,
          );
        }
        const subtype = getName(dict, "Subtype") || "Unknown";
        // PDF.js writes its freehand HighlightEditor through the Ink writer:
        // /Subtype /Ink plus /IT /InkHighlight. Keep the physical subtype on
        // the entry for exact writer validation, while exposing the editor's
        // semantic kind to identities and operations.
        const kind = isFreehandHighlight({ subtype, dict })
          ? "highlight"
          : SUBTYPE_TO_KIND.get(subtype) || subtype.toLowerCase();
        const entry = {
          ref,
          refString: ref.toString(),
          dict,
          pageIndex,
          order,
          subtype,
          kind,
          supported: SUBTYPE_TO_KIND.has(subtype) || isFreehandHighlight({ subtype, dict }),
        };
        entries.push(entry);
        annotations.push(entry);
        byRef.set(entry.refString, entry);
      }
    }
    byPage.push(entries);
  }
  return { pageRefs, annotations, byRef, byPage };
}

function canonicalValue(doc, value, options = {}, state = null) {
  const {
    skipKeys = new Set(),
    pageRefs = new Map(),
    annotationRefs = new Map(),
    omitAnnotationRelationships = false,
  } = options;
  state ||= { activeRefs: new Set(), activeObjects: new WeakSet(), depth: 0 };
  if (state.depth > 100) {
    fail("PDF_MERGE_OBJECT_GRAPH_TOO_DEEP", "A PDF object graph exceeds the safe inspection depth.");
  }
  if (value === undefined) return null;
  if (value === PDFNull) return null;
  if (value instanceof PDFRef) {
    const key = value.toString();
    if (pageRefs.has(key)) return { page: pageRefs.get(key) };
    if (annotationRefs.has(key)) return { annotation: annotationRefs.get(key) };
    if (state.activeRefs.has(key)) return { cycle: true };
    state.activeRefs.add(key);
    let result;
    try {
      result = canonicalValue(doc, doc.context.lookup(value), options, {
        activeRefs: state.activeRefs,
        activeObjects: state.activeObjects,
        depth: state.depth + 1,
      });
    } finally {
      state.activeRefs.delete(key);
    }
    return result;
  }
  if (value instanceof PDFName) return { name: nameKey(value) };
  if (value instanceof PDFNumber) return { number: value.asNumber() };
  if (value instanceof PDFBool) return { bool: value.asBoolean() };
  if (value instanceof PDFHexString || value instanceof PDFString) {
    return { stringBytes: toHex(value.asBytes()) };
  }
  if (value instanceof PDFArray) {
    if (state.activeObjects.has(value)) return { cycle: true };
    state.activeObjects.add(value);
    const result = [];
    for (let index = 0; index < value.size(); index += 1) {
      result.push(
        canonicalValue(doc, value.get(index), options, {
          activeRefs: state.activeRefs,
          activeObjects: state.activeObjects,
          depth: state.depth + 1,
        }),
      );
    }
    state.activeObjects.delete(value);
    return result;
  }
  if (value instanceof PDFStream) {
    const stream = value.getContents();
    // /Length describes the encoded representation and is often indirect in
    // source PDFs. Writers may replace that reference with a direct byte count
    // on a lossless round trip; the exact stream bytes below remain in the
    // fingerprint, so /Length must not make a page lineage unstable.
    const streamOptions = { ...options, skipKeys: new Set([...skipKeys, "Length"]) };
    const dict = canonicalValue(doc, value.dict, streamOptions, {
      activeRefs: state.activeRefs,
      activeObjects: state.activeObjects,
      depth: state.depth + 1,
    });
    return { stream: hashBytes(stream), dictionary: dict };
  }
  if (value instanceof PDFDict) {
    if (state.activeObjects.has(value)) return { cycle: true };
    state.activeObjects.add(value);
    const entries = [];
    for (const [key, child] of value.entries()) {
      const normalizedKey = nameKey(key);
      if (skipKeys.has(normalizedKey)) continue;
      if (omitAnnotationRelationships && ["P", "Popup", "Parent", "IRT"].includes(normalizedKey)) {
        continue;
      }
      entries.push([
        normalizedKey,
        canonicalValue(doc, child, options, {
          activeRefs: state.activeRefs,
          activeObjects: state.activeObjects,
          depth: state.depth + 1,
        }),
      ]);
    }
    state.activeObjects.delete(value);
    entries.sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries);
  }
  return { object: value.toString() };
}

function getPageFingerprint(doc, maps = refMaps(doc)) {
  const pages = doc.getPages();
  const fingerprints = pages.map((page, pageIndex) => {
    const body = canonicalValue(
      doc,
      page.node,
      { skipKeys: OMIT_PAGE_KEYS, pageRefs: maps.pageRefs },
    );
    const geometry = {
      mediaBox: page.getMediaBox(),
      cropBox: page.getCropBox(),
      rotation: page.getRotation().angle,
    };
    return hashText(stableJson({ body, geometry }));
  });
  return fingerprints;
}

function documentIdFromPageFingerprints(fingerprints) {
  return `doc-${hashText(stableJson({ version: 1, pages: fingerprints }))}`;
}

function catalogLedger(doc) {
  const raw = doc.catalog.get(LEDGER_KEY);
  if (!raw) return null;
  const text = decodePdfString(resolve(doc.context, raw));
  if (!text) {
    fail("PDF_MERGE_INVALID_LEDGER", "The embedded annotation ledger is not valid text.");
  }
  let ledger;
  try {
    ledger = JSON.parse(text);
  } catch (error) {
    fail("PDF_MERGE_INVALID_LEDGER", `The embedded annotation ledger is malformed: ${error.message}`);
  }
  if (!ledger || ledger.version !== 1 || typeof ledger.documentId !== "string" || !Array.isArray(ledger.entries)) {
    fail("PDF_MERGE_INVALID_LEDGER", "The embedded annotation ledger has an unsupported shape.");
  }
  return ledger;
}

function operationStamp(operation, fallbackActorId) {
  const timestamp = operation.timestamp;
  const logical = operation.logical;
  const actorId = operation.actorId || fallbackActorId;
  const operationId = operation.operationId;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    fail("PDF_MERGE_INVALID_OPERATION", "An annotation operation must have a nonnegative integer timestamp.");
  }
  if (!Number.isSafeInteger(logical) || logical < 0) {
    fail("PDF_MERGE_INVALID_OPERATION", "An annotation operation must have a nonnegative integer logical counter.");
  }
  if (typeof actorId !== "string" || actorId.length === 0 || typeof operationId !== "string" || operationId.length === 0) {
    fail("PDF_MERGE_INVALID_OPERATION", "An annotation operation needs actorId and operationId strings.");
  }
  if (operation.action !== "upsert" && operation.action !== "delete") {
    fail("PDF_MERGE_INVALID_OPERATION", "An annotation operation action must be 'upsert' or 'delete'.");
  }
  return {
    timestamp,
    logical,
    actorId,
    operationId,
    action: operation.action,
  };
}

function compareStamp(left, right) {
  for (const key of ["timestamp", "logical"]) {
    const a = Number(left?.[key] || 0);
    const b = Number(right?.[key] || 0);
    if (a !== b) return a < b ? -1 : 1;
  }
  for (const key of ["actorId", "operationId"]) {
    const a = String(left?.[key] || "");
    const b = String(right?.[key] || "");
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function normalizeIdentity(entry, runtimeId = null) {
  return {
    ...(runtimeId === null ? {} : { runtimeId }),
    uuid: entry.uuid,
    ref: entry.ref === null || entry.ref === undefined ? null : (pdfJsRef(entry.ref) || null),
    pageIndex: entry.pageIndex,
    kind: entry.kind,
    order: entry.order,
    deleted: Boolean(entry.deleted),
    timestamp: entry.timestamp || 0,
    logical: entry.logical || 0,
    actorId: entry.actorId || "legacy",
    operationId: entry.operationId || "legacy",
  };
}

function defaultLegacyUuid(documentId, pageFingerprint, ref, subtype) {
  return `legacy-${hashText(`${documentId}\n${pageFingerprint}\n${ref}\n${subtype}`).slice(0, 32)}`;
}

function annotationHash(doc, entry, maps, uuidByRef) {
  const refMap = new Map(uuidByRef);
  const ordinary = canonicalValue(doc, entry.dict, {
    skipKeys: OMIT_ANNOTATION_HASH_KEYS,
    pageRefs: maps.pageRefs,
    annotationRefs: refMap,
  });
  const popupRaw = entry.dict.get(PDFName.of("Popup"));
  let popup = null;
  if (popupRaw) {
    if (!(popupRaw instanceof PDFRef)) {
      fail("PDF_MERGE_UNSUPPORTED_POPUP", "An annotation popup is not an indirect object.");
    }
    const popupDict = resolve(doc.context, popupRaw);
    if (!(popupDict instanceof PDFDict) || getName(popupDict, "Subtype") !== "Popup") {
      fail("PDF_MERGE_UNSUPPORTED_POPUP", "An annotation popup has an unexpected PDF structure.");
    }
    popup = canonicalValue(doc, popupDict, {
      skipKeys: new Set(["P", "Parent", "ObReaderId", "M"]),
      pageRefs: maps.pageRefs,
      annotationRefs: refMap,
    });
  }
  const irtRaw = entry.dict.get(PDFName.of("IRT"));
  let replyTo = null;
  if (irtRaw) {
    if (!(irtRaw instanceof PDFRef) || !uuidByRef.has(irtRaw.toString())) {
      fail("PDF_MERGE_UNBOUND_REPLY", "A reply annotation points to an annotation with no stable merge identity.");
    }
    replyTo = uuidByRef.get(irtRaw.toString());
  }
  return hashText(stableJson({ ordinary, popup, replyTo }));
}

function inspectDocument(doc, { fingerprint = null } = {}) {
  const maps = refMaps(doc);
  const pageFingerprints = fingerprint || getPageFingerprint(doc, maps);
  const docId = documentIdFromPageFingerprints(pageFingerprints);
  const embedded = catalogLedger(doc);
  if (embedded && embedded.documentId !== docId) {
    fail("PDF_MERGE_DOCUMENT_LINEAGE_MISMATCH", "The embedded ledger belongs to a different page-content lineage.");
  }
  if (embedded && stableJson(embedded.pageFingerprints) !== stableJson(pageFingerprints)) {
    fail("PDF_MERGE_DOCUMENT_STRUCTURE_CHANGED", "Page contents, geometry, or order differ from the ledger lineage.");
  }
  const savedByUuid = new Map((embedded?.entries || []).map((entry) => [entry.uuid, entry]));
  const savedByRef = new Map((embedded?.entries || []).filter((entry) => entry.ref).map((entry) => [pdfLibRef(entry.ref) || entry.ref, entry]));
  const uuidByRef = new Map();
  const uuidSet = new Set();
  const liveEntries = [];
  for (const entry of maps.annotations) {
    // Popup dictionaries are folded into their owning annotation's hash and
    // copied through its /Popup relationship, never as independent merge rows.
    if (entry.subtype === "Popup") continue;
    const uuid = readUuid(entry.dict) || savedByRef.get(entry.refString)?.uuid || defaultLegacyUuid(docId, pageFingerprints[entry.pageIndex], entry.refString, entry.subtype);
    if (uuidSet.has(uuid)) {
      fail("PDF_MERGE_DUPLICATE_ANNOTATION_ID", `More than one annotation carries merge identity ${uuid}.`);
    }
    uuidSet.add(uuid);
    uuidByRef.set(entry.refString, uuid);
    entry.uuid = uuid;
    entry.annotationHash = null;
    liveEntries.push(entry);
  }
  const stateEntries = [];
  for (const entry of liveEntries) {
    entry.annotationHash = annotationHash(doc, entry, maps, uuidByRef);
    const saved = savedByUuid.get(entry.uuid) || {};
    const normalized = normalizeIdentity({
      ...saved,
      uuid: entry.uuid,
      ref: entry.refString,
      pageIndex: entry.pageIndex,
      kind: entry.kind,
      order: entry.order,
      deleted: false,
      hash: entry.annotationHash,
    });
    entry.identity = normalized;
    entry.saved = saved;
    stateEntries.push({ ...normalized, hash: entry.annotationHash, live: true, entry });
  }
  for (const saved of savedByUuid.values()) {
    if (saved.deleted && !uuidSet.has(saved.uuid)) {
      stateEntries.push({ ...normalizeIdentity(saved), hash: null, live: false, entry: null });
    } else if (!saved.deleted && !uuidSet.has(saved.uuid)) {
      fail("PDF_MERGE_MISSING_TOMBSTONE", `Live annotation ${saved.uuid} is absent without a deletion tombstone.`);
    }
  }
  const identities = stateEntries
    .map(({ entry: _entry, hash: _hash, live: _live, ...identity }) => identity)
    .sort((left, right) => left.uuid.localeCompare(right.uuid));
  const persistedEntries = stateEntries
    .filter((entry) => !entry.live || entry.entry?.supported)
    .map(({ entry: _entry, live: _live, ...entry }) => ({ ...entry }))
    .sort((left, right) => left.uuid.localeCompare(right.uuid));
  const ledger = {
    version: 1,
    documentId: docId,
    pageFingerprints,
    entries: persistedEntries,
  };
  const stateDigest = digestEntries(ledger.entries);
  return { doc, maps, pageFingerprints, documentId: docId, embedded, uuidByRef, liveEntries, stateEntries, identities, ledger, stateDigest };
}

function makeLegacyIdentity(entry, documentId, pageFingerprint) {
  return {
    uuid: entry.uuid || defaultLegacyUuid(documentId, pageFingerprint, entry.refString, entry.subtype),
    ref: entry.refString,
    pageIndex: entry.pageIndex,
    kind: entry.kind,
    order: entry.order,
    deleted: false,
    timestamp: 0,
    logical: 0,
    actorId: "legacy",
    operationId: "legacy",
    hash: entry.annotationHash,
  };
}

function validateOperationList(operations, actorId) {
  if (operations === undefined || operations === null) return new Map();
  if (!Array.isArray(operations)) fail("PDF_MERGE_INVALID_OPERATION", "operations must be an array.");
  const effective = new Map();
  for (const operation of operations) {
    if (!operation || typeof operation.uuid !== "string" || !operation.uuid) {
      fail("PDF_MERGE_INVALID_OPERATION", "Each operation must identify an annotation UUID.");
    }
    const stamp = operationStamp(operation, actorId);
    if (operation.deleted !== undefined && Boolean(operation.deleted) !== (stamp.action === "delete")) {
      fail("PDF_MERGE_INVALID_OPERATION", `Operation ${operation.operationId} has inconsistent action/deleted fields.`);
    }
    const normalized = {
      uuid: operation.uuid,
      ref: operation.ref === null || operation.ref === undefined
        ? null
        : (pdfLibRef(operation.ref) || fail("PDF_MERGE_INVALID_OPERATION_REF", `Operation ${operation.operationId} has an invalid annotation reference.`)),
      pageIndex: Number.isInteger(operation.pageIndex) ? operation.pageIndex : null,
      kind: typeof operation.kind === "string" ? operation.kind : null,
      ...stamp,
    };
    const previous = effective.get(operation.uuid);
    if (!previous || compareStamp(normalized, previous) > 0) effective.set(operation.uuid, normalized);
    else if (compareStamp(normalized, previous) === 0 && stableJson(normalized) !== stableJson(previous)) {
      fail("PDF_MERGE_OPERATION_CLOCK_COLLISION", `UUID ${operation.uuid} has different operations with an identical clock.`);
    }
  }
  return effective;
}

function supportedSubtype(kind) {
  if (typeof kind !== "string") return null;
  return KIND_TO_SUBTYPE.get(kind.toLowerCase()) || [...SUBTYPE_TO_KIND].find(([subtype]) => subtype.toLowerCase() === kind.toLowerCase())?.[0] || null;
}

function validatePageLineage(baseInfo, branchInfo, label) {
  if (baseInfo.pageFingerprints.length !== branchInfo.pageFingerprints.length ||
      stableJson(baseInfo.pageFingerprints) !== stableJson(branchInfo.pageFingerprints)) {
    fail("PDF_MERGE_DOCUMENT_STRUCTURE_CHANGED", `${label} page content, geometry, order, or document identity changed.`);
  }
}

function rawAnnots(doc, pageIndex) {
  const page = doc.getPages()[pageIndex];
  if (!page) fail("PDF_MERGE_PAGE_OUT_OF_RANGE", `Page ${pageIndex + 1} is not present in the document.`);
  let array = page.node.lookupMaybe(ANNOTS_KEY, PDFArray);
  if (!array) {
    array = PDFArray.withContext(doc.context);
    page.node.set(ANNOTS_KEY, array);
  }
  return array;
}

function findOperationRefCandidate(info, uuid) {
  return info.liveEntries.find((entry) => entry.uuid === uuid) || null;
}

function checkUnsupportedChanges(baseInfo, draftInfo, uuidAssignments) {
  const baseByUuid = new Map(baseInfo.liveEntries.map((entry) => [entry.uuid, entry]));
  const draftByUuid = new Map(draftInfo.liveEntries.map((entry) => [entry.uuid, entry]));
  const mutableUuids = new Set(uuidAssignments.keys());
  for (const baseEntry of baseInfo.liveEntries) {
    if (baseEntry.subtype === "Popup") continue;
    if (baseEntry.supported) continue;
    const draftEntry = draftByUuid.get(baseEntry.uuid);
    if (!draftEntry) {
      fail("PDF_MERGE_UNSUPPORTED_ANNOTATION_CHANGE", `Unsupported ${baseEntry.subtype} annotation ${baseEntry.uuid} was removed; it cannot be merged safely.`);
    }
    if (draftEntry.annotationHash !== baseEntry.annotationHash) {
      fail("PDF_MERGE_UNSUPPORTED_ANNOTATION_CHANGE", `Unsupported ${baseEntry.subtype} annotation ${baseEntry.uuid} changed; it cannot be merged safely.`);
    }
  }
  for (const draftEntry of draftInfo.liveEntries) {
    if (draftEntry.subtype === "Popup" || draftEntry.supported) continue;
    if (!baseByUuid.has(draftEntry.uuid) && !mutableUuids.has(draftEntry.uuid)) {
      fail("PDF_MERGE_UNSUPPORTED_ANNOTATION_CHANGE", `A new unsupported ${draftEntry.subtype} annotation cannot be merged safely.`);
    }
  }
}

function buildNewAnnotationAssignments(baseInfo, draftInfo, newAnnotations, checkpointInfo = null) {
  if (newAnnotations === undefined || newAnnotations === null) newAnnotations = [];
  if (!Array.isArray(newAnnotations)) fail("PDF_MERGE_INVALID_NEW_ANNOTATIONS", "newAnnotations must be an array.");
  const baseRefs = new Set(baseInfo.maps.annotations.map((entry) => entry.refString));
  const checkpointByUuid = new Map((checkpointInfo?.ledger.entries || []).map((entry) => [entry.uuid, entry]));
  const unassigned = new Map();
  for (const entry of draftInfo.liveEntries) {
    if (!entry.supported || baseRefs.has(entry.refString)) continue;
    unassigned.set(entry.refString, entry);
  }
  // A PDF.js save preserves existing indirect refs. Ref-difference is therefore a
  // deterministic binding for a new annotation, while page/order/kind match the
  // exact storage sequence supplied by the host.
  const inputs = [...newAnnotations].sort((left, right) =>
    (left.pageIndex - right.pageIndex) || (left.order - right.order) || String(left.uuid).localeCompare(String(right.uuid)),
  );
  const assignments = new Map();
  const usedRefs = new Set();
  const seenUuids = new Set();
  const orderedInputs = [];
  const seenPositions = new Set();
  for (const input of inputs) {
    if (!input || typeof input.uuid !== "string" || !input.uuid || typeof input.runtimeId !== "string" || !input.runtimeId || !Number.isInteger(input.pageIndex) || input.pageIndex < 0 || !Number.isInteger(input.order) || input.order < 0) {
      fail("PDF_MERGE_INVALID_NEW_ANNOTATIONS", "Each new annotation needs runtimeId, UUID, pageIndex, kind, and order.");
    }
    const expectedSubtype = supportedSubtype(input.kind);
    if (!expectedSubtype) fail("PDF_MERGE_UNSUPPORTED_ANNOTATION_KIND", `New annotation kind ${input.kind} is not one of the five editor tools.`);
    const expectedKind = SUBTYPE_TO_KIND.get(expectedSubtype);
    if (seenUuids.has(input.uuid)) fail("PDF_MERGE_DUPLICATE_ANNOTATION_ID", `New annotations repeat UUID ${input.uuid}.`);
    seenUuids.add(input.uuid);
    if (baseInfo.liveEntries.some((entry) => entry.uuid === input.uuid)) fail("PDF_MERGE_DUPLICATE_ANNOTATION_ID", `New annotation UUID ${input.uuid} already belongs to the loaded document.`);
    const positionKey = `${input.pageIndex}:${input.order}`;
    if (seenPositions.has(positionKey)) {
      fail("PDF_MERGE_INVALID_NEW_ANNOTATIONS", `New annotation storage order ${input.order} is repeated on page ${input.pageIndex + 1}.`);
    }
    seenPositions.add(positionKey);
    const checkpointIdentity = checkpointByUuid.get(input.uuid);
    if (checkpointIdentity && checkpointIdentity.pageIndex !== input.pageIndex) {
      fail("PDF_MERGE_OPERATION_IDENTITY_MISMATCH", `New editor ${input.runtimeId} does not match its saved checkpoint page or kind.`);
    }
    const matches = [...unassigned.values()].filter((entry) => entry.pageIndex === input.pageIndex && entry.kind === expectedKind && !usedRefs.has(entry.refString));
    const orderedPageEntries = draftInfo.maps.byPage[input.pageIndex] || [];
    const expectedBefore = orderedInputs.filter((other) => other.pageIndex === input.pageIndex && other.order < input.order).length;
    const positionMatches = matches.filter((entry) => {
      const newSupportedBefore = orderedPageEntries
        .filter((item) => item.supported && !baseRefs.has(item.refString) && item.order < entry.order)
        .length;
      return newSupportedBefore === expectedBefore;
    });
    const candidate = positionMatches.length === 1 ? positionMatches[0] : null;
    if (!candidate) {
      fail("PDF_MERGE_NEW_ANNOTATION_BINDING_FAILED", `Could not bind new ${input.kind} editor ${input.runtimeId} to one exact PDF annotation reference on page ${input.pageIndex + 1}.`);
    }
    if (checkpointIdentity && !operationKindMatches(checkpointIdentity.kind, input.kind, candidate)) {
      fail("PDF_MERGE_OPERATION_IDENTITY_MISMATCH", `New editor ${input.runtimeId} does not match its saved checkpoint page or kind.`);
    }
    usedRefs.add(candidate.refString);
    candidate.uuid = input.uuid;
    draftInfo.uuidByRef.set(candidate.refString, input.uuid);
    assignments.set(input.uuid, { ...input, entry: candidate, ref: candidate.refString, kind: candidate.kind });
    orderedInputs.push(input);
  }
  if ([...unassigned.keys()].some((ref) => !usedRefs.has(ref))) {
    const extra = [...unassigned.keys()].filter((ref) => !usedRefs.has(ref));
    fail("PDF_MERGE_NEW_ANNOTATION_BINDING_FAILED", `The PDF contains unbound new annotation references: ${extra.join(", ")}.`);
  }
  return assignments;
}

function collectEffectiveOperations(operations, actorId, newAssignments, priorEntries = new Map()) {
  const effective = validateOperationList(operations, actorId);
  for (const [uuid, assignment] of newAssignments) {
    const operation = effective.get(uuid);
    const prior = priorEntries.get(uuid);
    if (!operation || operation.action !== "upsert" || operation.ref !== null) {
      fail("PDF_MERGE_MISSING_CREATION_OPERATION", `New annotation ${uuid} needs an upsert operation with ref:null and an explicit timestamp.`);
    }
    if (prior) {
      if (operation?.pageIndex !== null && operation?.pageIndex !== undefined && operation.pageIndex !== assignment.pageIndex) {
        fail("PDF_MERGE_OPERATION_IDENTITY_MISMATCH", `Operation page for saved annotation ${uuid} does not match its checkpoint identity.`);
      }
      if (operation?.kind && !operationKindMatches(operation.kind, assignment.kind, assignment.entry)) {
        fail("PDF_MERGE_OPERATION_IDENTITY_MISMATCH", `Operation kind for saved annotation ${uuid} does not match its checkpoint identity.`);
      }
    }
  }
  return effective;
}

function writeLedger(doc, ledger) {
  doc.catalog.set(LEDGER_KEY, PDFHexString.fromText(stableJson(ledger)));
}

function infoToIdentity(stateEntry, runtimeId = null) {
  return normalizeIdentity(stateEntry, runtimeId);
}

async function prepareLocal({ baseBytes, draftBytes, checkpointBytes, operations, newAnnotations, actorId }) {
  if (typeof actorId !== "string" || !actorId) fail("PDF_MERGE_INVALID_ACTOR", "actorId is required.");
  const checkpointMatchesBase = Boolean(checkpointBytes) && bytesEqual(baseBytes, checkpointBytes);
  const [baseDoc, draftDoc, checkpointDoc] = await Promise.all([
    loadPdf(baseBytes, "Loaded base PDF"),
    loadPdf(draftBytes, "PDF.js draft PDF"),
    checkpointBytes && !checkpointMatchesBase ? loadPdf(checkpointBytes, "Saved local checkpoint PDF") : Promise.resolve(null),
  ]);
  const baseInfo = inspectDocument(baseDoc);
  const draftInfo = inspectDocument(draftDoc);
  const checkpointInfo = checkpointBytes ? (checkpointMatchesBase ? baseInfo : inspectDocument(checkpointDoc)) : null;
  validatePageLineage(baseInfo, draftInfo, "PDF.js draft");
  if (checkpointInfo) {
    validatePageLineage(baseInfo, checkpointInfo, "Saved local checkpoint");
    if (checkpointInfo.documentId !== baseInfo.documentId) {
      fail("PDF_MERGE_DOCUMENT_IDENTITY_MISMATCH", "The saved local checkpoint does not share the loaded document lineage.");
    }
  }

  const historyEntries = new Map(baseInfo.ledger.entries.map((entry) => [entry.uuid, entry]));
  for (const entry of checkpointInfo?.ledger.entries || []) historyEntries.set(entry.uuid, entry);

  const newAssignments = buildNewAnnotationAssignments(baseInfo, draftInfo, newAnnotations, checkpointInfo);
  for (const [uuid, assignment] of newAssignments) {
    draftInfo.uuidByRef.set(assignment.ref, uuid);
    assignment.entry.uuid = uuid;
  }
  for (const entry of draftInfo.liveEntries) {
    entry.annotationHash = annotationHash(draftDoc, entry, draftInfo.maps, draftInfo.uuidByRef);
  }
  const effectiveOperations = collectEffectiveOperations(operations, actorId, newAssignments, historyEntries);
  const allUuidAssignments = new Map(newAssignments);
  for (const operation of effectiveOperations.values()) {
    if (!allUuidAssignments.has(operation.uuid)) allUuidAssignments.set(operation.uuid, { uuid: operation.uuid });
  }

  const baseByUuid = new Map(baseInfo.liveEntries.map((entry) => [entry.uuid, entry]));
  const draftByUuid = new Map(draftInfo.liveEntries.map((entry) => [entry.uuid, entry]));
  const baseRefByUuid = new Map(baseInfo.liveEntries.map((entry) => [entry.uuid, entry.refString]));

  // Existing annotations are identified by an embedded private UUID or their
  // unchanged indirect reference. Never infer identity from geometry or text.
  for (const entry of draftInfo.liveEntries) {
    if (entry.supported && !newAssignments.has(entry.uuid) && !baseByUuid.has(entry.uuid)) {
      const baseMatch = baseInfo.maps.byRef.get(entry.refString);
      if (baseMatch) {
        entry.uuid = baseMatch.uuid;
      } else if (!readUuid(entry.dict)) {
        fail("PDF_MERGE_ANNOTATION_IDENTITY_UNPROVEN", `Existing ${entry.subtype} annotation reference ${entry.refString} changed without a persisted private identity.`);
      }
    }
  }
  // Rebuild maps after resolving legacy references above.
  const draftByResolvedUuid = new Map(draftInfo.liveEntries.map((entry) => [entry.uuid, entry]));
  for (const [uuid, assignment] of newAssignments) assignment.entry.uuid = uuid;
  checkUnsupportedChanges(baseInfo, draftInfo, allUuidAssignments);

  const entries = [];
  const runtimeByUuid = new Map([...newAssignments].map(([uuid, assignment]) => [uuid, assignment.runtimeId]));
  const processed = new Set();
  let removedCheckpointStaleAnnotation = false;

  const validateOperationIdentity = (op, expected, current, label, allowUnboundUpsert = false) => {
    if (!op) return;
    const expectedRef = pdfLibRef(expected.ref) || expected.refString || null;
    if (!op.ref && expectedRef && !allowUnboundUpsert) {
      fail("PDF_MERGE_OPERATION_IDENTITY_MISMATCH", `${label} for saved annotation ${expected.uuid} must include its exact reference.`);
    }
    if (op.ref && expectedRef && op.ref !== expectedRef && (!current || op.ref !== current.refString)) {
      fail("PDF_MERGE_OPERATION_IDENTITY_MISMATCH", `${label} reference for ${expected.uuid} does not match its saved identity.`);
    }
    if (op.pageIndex !== null && op.pageIndex !== expected.pageIndex) {
      fail("PDF_MERGE_OPERATION_IDENTITY_MISMATCH", `${label} page for ${expected.uuid} does not match its saved identity.`);
    }
    if (op.kind && !operationKindMatches(op.kind, expected.kind, current || expected)) {
      fail("PDF_MERGE_OPERATION_IDENTITY_MISMATCH", `${label} kind for ${expected.uuid} does not match its saved identity.`);
    }
    if (current && op.pageIndex !== null && op.pageIndex !== current.pageIndex) {
      fail("PDF_MERGE_PAGE_MOVE_UNSUPPORTED", `${label} for ${expected.uuid} points to a different page than the draft annotation.`);
    }
    if (current && op.kind && !operationKindMatches(op.kind, current.kind, current)) {
      fail("PDF_MERGE_OPERATION_IDENTITY_MISMATCH", `${label} for ${expected.uuid} does not match the draft PDF subtype.`);
    }
  };

  const addTombstone = (prior, operation = null) => {
    const stamp = operation && (!prior || compareStamp(operation, prior) > 0) ? operation : prior;
    entries.push({
      uuid: prior?.uuid || operation.uuid,
      ref: prior?.ref ? (pdfJsRef(prior.ref) || prior.ref) : null,
      pageIndex: prior?.pageIndex ?? operation?.pageIndex,
      kind: prior?.kind || operation?.kind,
      order: prior?.order ?? operation?.order ?? 0,
      deleted: true,
      timestamp: stamp?.timestamp || 0,
      logical: stamp?.logical || 0,
      actorId: stamp?.actorId || actorId,
      operationId: stamp?.operationId || "legacy",
      hash: null,
    });
  };

  for (const baseEntry of baseInfo.liveEntries) {
    if (baseEntry.subtype === "Popup") continue;
    if (!baseEntry.supported) continue;
    const current = draftByResolvedUuid.get(baseEntry.uuid);
    const op = effectiveOperations.get(baseEntry.uuid);
    const previous = historyEntries.get(baseEntry.uuid) || makeLegacyIdentity(baseEntry, baseInfo.documentId, baseInfo.pageFingerprints[baseEntry.pageIndex]);
    validateOperationIdentity(op, baseEntry, current, "Operation");

    if (previous.deleted && op?.action !== "upsert") {
      if (op?.action === "delete" && current && compareStamp(op, previous) > 0) {
        fail("PDF_MERGE_OPERATION_BYTES_MISMATCH", `Newer delete operation for ${baseEntry.uuid} still has a live PDF annotation.`);
      }
      if (current) {
        removeRefFromPage(draftDoc, current.pageIndex, current.ref);
        const popup = current.dict.get(PDFName.of("Popup"));
        if (popup instanceof PDFRef) removeRefFromPage(draftDoc, current.pageIndex, popup);
        removedCheckpointStaleAnnotation = true;
      }
      addTombstone(previous, op);
      processed.add(baseEntry.uuid);
      continue;
    }

    if (op?.action === "delete") {
      if (current) fail("PDF_MERGE_OPERATION_BYTES_MISMATCH", `Delete operation for ${baseEntry.uuid} still has a live PDF annotation.`);
      addTombstone({ ...previous, ref: pdfJsRef(baseEntry.refString), pageIndex: baseEntry.pageIndex, kind: baseEntry.kind, order: baseEntry.order }, op);
      processed.add(baseEntry.uuid);
      continue;
    }
    if (!current) {
      fail("PDF_MERGE_MISSING_DELETE_OPERATION", `Loaded ${baseEntry.kind} annotation ${baseEntry.uuid} disappeared without a timestamped delete operation.`);
    }
    if (current.annotationHash !== baseEntry.annotationHash && op?.action !== "upsert") {
      fail("PDF_MERGE_MISSING_UPSERT_OPERATION", `Changed ${baseEntry.kind} annotation ${baseEntry.uuid} has no timestamped upsert operation.`);
    }
    const stamp = op?.action === "upsert" ? op : previous;
    setUuid(current.dict, baseEntry.uuid);
    entries.push({
      uuid: baseEntry.uuid,
      ref: pdfJsRef(current.refString),
      pageIndex: current.pageIndex,
      kind: current.kind,
      order: current.order,
      deleted: false,
      timestamp: stamp.timestamp || 0,
      logical: stamp.logical || 0,
      actorId: stamp.actorId || "legacy",
      operationId: stamp.operationId || "legacy",
      hash: current.annotationHash,
    });
    processed.add(baseEntry.uuid);
  }

  // A later local checkpoint can contain annotations first created in this
  // Viewer session. Keep those UUIDs stable across repeat saves and use the
  // checkpoint ledger to validate their edits or timestamped deletes.
  for (const prior of historyEntries.values()) {
    if (baseByUuid.has(prior.uuid) || processed.has(prior.uuid)) continue;
    const assignment = newAssignments.get(prior.uuid);
    const current = assignment?.entry || draftByResolvedUuid.get(prior.uuid) || null;
    const op = effectiveOperations.get(prior.uuid);
    validateOperationIdentity(op, prior, current, "Operation", Boolean(assignment && op?.action === "upsert"));

    if (prior.deleted) {
      if (op?.action === "upsert") {
        if (!current) fail("PDF_MERGE_OPERATION_BYTES_MISMATCH", `Undo operation for ${prior.uuid} has no live PDF annotation bytes.`);
      } else {
        if (current) {
          removeRefFromPage(draftDoc, current.pageIndex, current.ref);
          const popup = current.dict.get(PDFName.of("Popup"));
          if (popup instanceof PDFRef) removeRefFromPage(draftDoc, current.pageIndex, popup);
          removedCheckpointStaleAnnotation = true;
        }
        addTombstone(prior, op?.action === "delete" ? op : null);
        processed.add(prior.uuid);
        continue;
      }
    } else if (op?.action === "delete") {
      if (current) fail("PDF_MERGE_OPERATION_BYTES_MISMATCH", `Delete operation for ${prior.uuid} still has a live PDF annotation.`);
      addTombstone(prior, op);
      processed.add(prior.uuid);
      continue;
    } else if (!current) {
      fail("PDF_MERGE_MISSING_DELETE_OPERATION", `Saved ${prior.kind} annotation ${prior.uuid} disappeared without a timestamped delete operation.`);
    }

    if (!current) fail("PDF_MERGE_WINNER_BYTES_MISSING", `Saved annotation ${prior.uuid} has no current PDF bytes.`);
    if (current.annotationHash !== prior.hash && op?.action !== "upsert") {
      fail("PDF_MERGE_MISSING_UPSERT_OPERATION", `Changed saved ${prior.kind} annotation ${prior.uuid} has no timestamped upsert operation.`);
    }
    if (op && op.action !== "upsert") fail("PDF_MERGE_OPERATION_BYTES_MISMATCH", `Saved annotation ${prior.uuid} is live but its operation is not an upsert.`);
    setUuid(current.dict, prior.uuid);
    entries.push({
      uuid: prior.uuid,
      ref: pdfJsRef(current.refString),
      pageIndex: current.pageIndex,
      kind: current.kind,
      order: assignment?.order ?? current.order,
      deleted: false,
      timestamp: op?.timestamp ?? prior.timestamp ?? 0,
      logical: op?.logical ?? prior.logical ?? 0,
      actorId: op?.actorId || prior.actorId || "legacy",
      operationId: op?.operationId || prior.operationId || "legacy",
      hash: current.annotationHash,
    });
    processed.add(prior.uuid);
  }

  for (const [uuid, assignment] of newAssignments) {
    if (processed.has(uuid) || historyEntries.has(uuid)) continue;
    const current = assignment.entry;
    const op = effectiveOperations.get(uuid);
    if (op?.action !== "upsert") fail("PDF_MERGE_MISSING_CREATION_OPERATION", `New annotation ${uuid} is missing its creation upsert operation.`);
    if (op.pageIndex !== null && op.pageIndex !== current.pageIndex) fail("PDF_MERGE_OPERATION_IDENTITY_MISMATCH", `Creation operation for ${uuid} points to a different page.`);
    if (op.kind && !operationKindMatches(op.kind, current.kind, current)) fail("PDF_MERGE_OPERATION_IDENTITY_MISMATCH", `Creation operation kind for ${uuid} does not match the PDF subtype.`);
    setUuid(current.dict, uuid);
    entries.push({
      uuid,
      ref: pdfJsRef(current.refString),
      pageIndex: current.pageIndex,
      kind: current.kind,
      order: current.order,
      deleted: false,
      timestamp: op.timestamp,
      logical: op.logical,
      actorId: op.actorId,
      operationId: op.operationId,
      hash: current.annotationHash,
    });
    processed.add(uuid);
  }
  for (const op of effectiveOperations.values()) {
    if (processed.has(op.uuid) || baseByUuid.has(op.uuid) || historyEntries.has(op.uuid) || newAssignments.has(op.uuid)) continue;
    if (op.action === "delete") {
      if (op.ref !== null) fail("PDF_MERGE_UNKNOWN_ANNOTATION_ID", `Delete operation for ${op.uuid} includes an unverified saved reference.`);
      if (op.pageIndex === null || op.pageIndex < 0 || op.pageIndex >= baseInfo.pageFingerprints.length || !supportedSubtype(op.kind)) {
        fail("PDF_MERGE_INVALID_OPERATION", `Unsaved delete for ${op.uuid} needs a valid page and one of the five supported annotation kinds.`);
      }
      addTombstone(null, op);
      processed.add(op.uuid);
    } else {
      fail("PDF_MERGE_UNKNOWN_ANNOTATION_ID", `Upsert operation refers to unknown annotation ${op.uuid}.`);
    }
  }

  const ledger = {
    version: 1,
    documentId: baseInfo.documentId,
    pageFingerprints: baseInfo.pageFingerprints,
    entries: entries.sort((left, right) => left.uuid.localeCompare(right.uuid)),
  };
  const currentIdentities = entries.map((entry) => infoToIdentity(entry, runtimeByUuid.get(entry.uuid) ?? entry.ref));
  const currentDigest = digestEntries(entries);
  const previousLedger = draftInfo.embedded;
  if (!removedCheckpointStaleAnnotation && previousLedger && stableJson(previousLedger.entries) === stableJson(ledger.entries)) {
    return {
      bytes: new Uint8Array(asBytes(draftBytes, "PDF.js draft PDF")),
      stateDigest: currentDigest,
      ledger,
      identities: currentIdentities,
      annotations: currentIdentities,
    };
  }
  writeLedger(draftDoc, ledger);
  let bytes;
  try {
    bytes = await draftDoc.save({ useObjectStreams: false, addDefaultPage: false, objectsPerTick: 100 });
  } catch (error) {
    throw errorFromLoad(error, "Prepared local PDF");
  }
  return { bytes, stateDigest: currentDigest, ledger, identities: currentIdentities, annotations: currentIdentities };
}

function digestEntries(entries) {
  return hashText(stableJson(
    entries.map((entry) => ({
      uuid: entry.uuid,
      ref: entry.ref ?? null,
      pageIndex: entry.pageIndex,
      kind: entry.kind,
      order: entry.order,
      deleted: Boolean(entry.deleted),
      hash: entry.hash ?? null,
      timestamp: entry.timestamp || 0,
      logical: entry.logical || 0,
      actorId: entry.actorId || "legacy",
      operationId: entry.operationId || "legacy",
    })).sort((left, right) => left.uuid.localeCompare(right.uuid)),
  ));
}

function semanticState(info, uuid) {
  return info.stateEntries.find((entry) => entry.uuid === uuid) || null;
}

function sameValueState(left, right) {
  if (!left || !right) return left === right;
  return Boolean(left.live) === Boolean(right.live) && left.hash === right.hash && left.pageIndex === right.pageIndex && left.kind === right.kind;
}

function statesEquivalentIgnoringClock(left, right) {
  if (!left || !right) return left === right;
  return sameValueState(left, right);
}

function stateForLive(entry, docInfo) {
  return {
    ...entry.identity,
    uuid: entry.uuid,
    hash: entry.annotationHash,
    live: true,
    entry,
  };
}

function chooseState(base, local, remote, uuid) {
  if (!local && !remote) return null;
  if (!base) {
    if (!local) return remote;
    if (!remote) return local;
    if (sameValueState(local, remote)) return compareStamp(local, remote) >= 0 ? local : remote;
    return compareStamp(local, remote) >= 0 ? local : remote;
  }
  if (!local && !remote) return base;
  if (!local) {
    fail("PDF_MERGE_MISSING_BRANCH_IDENTITY", `Local state for ${uuid} is missing without a tombstone.`);
  }
  if (!remote) {
    fail("PDF_MERGE_MISSING_BRANCH_IDENTITY", `Remote state for ${uuid} is missing without a tombstone.`);
  }
  const localUnchanged = statesEquivalentIgnoringClock(local, base);
  const remoteUnchanged = statesEquivalentIgnoringClock(remote, base);
  if (localUnchanged && !remoteUnchanged) return remote;
  if (remoteUnchanged && !localUnchanged) return local;
  if (sameValueState(local, remote)) return compareStamp(local, remote) >= 0 ? local : remote;
  const order = compareStamp(local, remote);
  if (order !== 0) return order > 0 ? local : remote;
  fail("PDF_MERGE_CLOCK_CONFLICT", `Concurrent changes to ${uuid} have identical clocks but different annotation data.`);
}

function entryMaps(info) {
  const live = new Map(info.liveEntries.map((entry) => [entry.uuid, stateForLive(entry, info)]));
  const all = new Map(info.stateEntries.map((entry) => [entry.uuid, entry]));
  for (const [uuid, entry] of live) all.set(uuid, entry);
  return all;
}

function hasStructTree(info) {
  return Boolean(info.doc.catalog.get(PDFName.of("StructTreeRoot")));
}

function structureTreeSignature(info) {
  const raw = info.doc.catalog.get(PDFName.of("StructTreeRoot"));
  if (!raw) return null;
  return hashText(stableJson(canonicalValue(info.doc, raw, {
    pageRefs: info.maps.pageRefs,
    annotationRefs: info.uuidByRef,
  })));
}

function structurallySafeTaggedCopy(baseInfo, localInfo, remoteInfo, uuid, sourceEntry, remoteEntry) {
  const sourceStruct = sourceEntry.dict.get(PDFName.of("StructParent"));
  if (!sourceStruct) return false;
  const baseEntry = baseInfo.liveEntries.find((entry) => entry.uuid === uuid);
  if (!baseEntry) return false;
  const remoteDict = remoteEntry?.dict;
  const baseStruct = baseEntry.dict.get(PDFName.of("StructParent"));
  const remoteStruct = remoteDict?.get(PDFName.of("StructParent"));
  if (!(sourceStruct instanceof PDFNumber) || !(baseStruct instanceof PDFNumber) || !(remoteStruct instanceof PDFNumber)) return false;
  if (sourceStruct.asNumber() !== baseStruct.asNumber() || baseStruct.asNumber() !== remoteStruct.asNumber()) return false;
  const baseSignature = structureTreeSignature(baseInfo);
  if (baseSignature === null || baseSignature !== structureTreeSignature(localInfo) || baseSignature !== structureTreeSignature(remoteInfo)) return false;
  return true;
}

function isPageLike(doc, value) {
  if (!(value instanceof PDFDict)) return false;
  const type = getName(value, "Type");
  return type === "Page" || type === "Pages";
}

function preflightCopyValue(sourceDoc, value, maps, seenRefs = new Set(), seenObjects = new WeakSet(), depth = 0) {
  if (depth > 100) fail("PDF_MERGE_OBJECT_GRAPH_TOO_DEEP", "Annotation references exceed the safe copy depth.");
  if (value instanceof PDFRef) {
    const ref = value.toString();
    // Leaf-page references in fields such as Link /Dest are valid annotation
    // data. They are remapped to the destination document's existing pages by
    // the copier below; never resolve or copy the source page object here.
    if (maps.pageRefs.has(ref)) return;
    if (maps.byRef.has(ref)) fail("PDF_MERGE_ANNOTATION_RELATION_UNBOUND", "An annotation contains an unrecognized reference to another annotation.");
    if (seenRefs.has(ref)) return;
    seenRefs.add(ref);
    const resolved = sourceDoc.context.lookup(value);
    if (isPageLike(sourceDoc, resolved)) fail("PDF_MERGE_ANNOTATION_REFERENCES_PAGE", "An annotation references a page object outside the validated page list.");
    preflightCopyValue(sourceDoc, resolved, maps, seenRefs, seenObjects, depth + 1);
    return;
  }
  if (value instanceof PDFArray) {
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    for (let index = 0; index < value.size(); index += 1) preflightCopyValue(sourceDoc, value.get(index), maps, seenRefs, seenObjects, depth + 1);
    return;
  }
  if (value instanceof PDFStream) {
    preflightCopyValue(sourceDoc, value.dict, maps, seenRefs, seenObjects, depth + 1);
    return;
  }
  if (value instanceof PDFDict) {
    if (isPageLike(sourceDoc, value)) fail("PDF_MERGE_ANNOTATION_REFERENCES_PAGE", "An annotation contains a direct page object that cannot be safely remapped.");
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    for (const [key, child] of value.entries()) {
      const normalized = nameKey(key);
      if (["P", "Popup", "Parent", "IRT", "StructParent"].includes(normalized)) {
        fail("PDF_MERGE_ANNOTATION_RELATION_UNBOUND", `An annotation sub-object contains ${normalized}, which cannot be safely copied.`);
      }
      preflightCopyValue(sourceDoc, child, maps, seenRefs, seenObjects, depth + 1);
    }
  }
}

function mapValidatedPageRefs(copier, sourceInfo, destDoc) {
  const sourcePages = sourceInfo.doc.getPages();
  const destinationPages = destDoc.getPages();
  if (sourcePages.length !== destinationPages.length) {
    fail("PDF_MERGE_DOCUMENT_STRUCTURE_CHANGED", "The annotation source and destination have different page counts.");
  }
  for (let index = 0; index < sourcePages.length; index += 1) {
    const sourceRef = sourcePages[index].ref;
    const destinationRef = destinationPages[index].ref;
    if (!(sourceRef instanceof PDFRef) || !(destinationRef instanceof PDFRef) || sourceInfo.maps.pageRefs.get(sourceRef.toString()) !== index) {
      fail("PDF_MERGE_ANNOTATION_REFERENCES_PAGE", "An annotation page reference could not be mapped to the validated destination page.");
    }
    // PDFObjectCopier 1.17.1 uses interned PDFRef objects as traversedObjects
    // keys. Seeding the leaf refs makes copyPDFIndirectObject return this
    // existing destination ref without looking up/copying any page dictionary.
    copier.traversedObjects.set(sourceRef, destinationRef);
  }
}

function cloneSanitizedDictionary(sourceInfo, sourceEntry, destDoc, targetRef, pageRef, idToDestRef, options = {}) {
  const sourceDoc = sourceInfo.doc;
  const sourceDict = sourceEntry.dict;
  const copier = PDFObjectCopier.for(sourceDoc.context, destDoc.context);
  mapValidatedPageRefs(copier, sourceInfo, destDoc);
  const result = PDFDict.withContext(destDoc.context);
  const skip = new Set(["P", "Popup", "Parent", "IRT", "StructParent"]);
  for (const [key, value] of sourceDict.entries()) {
    const normalized = nameKey(key);
    if (skip.has(normalized)) continue;
    if (normalized === "ObReaderId") continue;
    preflightCopyValue(sourceDoc, value, sourceInfo.maps);
    result.set(key, copier.copy(value));
  }
  result.set(PDFName.of("P"), pageRef);
  setUuid(result, sourceEntry.uuid);
  const sourceStruct = sourceDict.get(PDFName.of("StructParent"));
  if (sourceStruct) {
    if (!options.keepStructParent) fail("PDF_MERGE_TAGGED_ANNOTATION_UNSAFE", "A tagged annotation cannot be copied without its original structure-tree binding.");
    result.set(PDFName.of("StructParent"), sourceStruct);
  }
  const irtRaw = sourceDict.get(PDFName.of("IRT"));
  if (irtRaw) {
    if (!(irtRaw instanceof PDFRef)) fail("PDF_MERGE_UNBOUND_REPLY", "A reply target is not an indirect annotation reference.");
    const targetUuid = sourceInfo.uuidByRef.get(irtRaw.toString());
    const targetRef = targetUuid ? idToDestRef.get(targetUuid) : null;
    if (!targetRef) fail("PDF_MERGE_UNBOUND_REPLY", `Reply target ${irtRaw.toString()} has no surviving merged identity.`);
    result.set(PDFName.of("IRT"), targetRef);
  }
  const popupRaw = sourceDict.get(PDFName.of("Popup"));
  if (popupRaw) {
    if (!(popupRaw instanceof PDFRef)) fail("PDF_MERGE_UNSUPPORTED_POPUP", "An annotation popup is not an indirect object.");
    const popupSource = resolve(sourceDoc.context, popupRaw);
    if (!(popupSource instanceof PDFDict) || getName(popupSource, "Subtype") !== "Popup") fail("PDF_MERGE_UNSUPPORTED_POPUP", "An annotation popup has an unexpected structure.");
    if (popupSource.get(PDFName.of("StructParent"))) {
      fail("PDF_MERGE_TAGGED_POPUP_UNSAFE", "A tagged popup cannot be copied without its structure-tree association.");
    }
    const popupTargetRef = options.popupTargetRef || destDoc.context.nextRef();
    const popup = PDFDict.withContext(destDoc.context);
    for (const [key, value] of popupSource.entries()) {
      const normalized = nameKey(key);
      if (["P", "Parent", "StructParent", "ObReaderId"].includes(normalized)) continue;
      preflightCopyValue(sourceDoc, value, sourceInfo.maps);
      popup.set(key, copier.copy(value));
    }
    popup.set(PDFName.of("P"), pageRef);
    popup.set(PDFName.of("Parent"), targetRef);
    destDoc.context.assign(popupTargetRef, popup);
    result.set(PDFName.of("Popup"), popupTargetRef);
    options.popupResult = { ref: popupTargetRef, sourceRef: popupRaw, sourceDict: popupSource };
  }
  destDoc.context.assign(targetRef, result);
  return result;
}

function removeRefFromPage(doc, pageIndex, ref) {
  const array = rawAnnots(doc, pageIndex);
  for (let index = array.size() - 1; index >= 0; index -= 1) {
    const raw = array.get(index);
    if (raw instanceof PDFRef && raw.toString() === ref.toString()) array.remove(index);
  }
}

function appendRefToPage(doc, pageIndex, ref) {
  const array = rawAnnots(doc, pageIndex);
  if (!Array.from({ length: array.size() }, (_, index) => array.get(index)).some((item) => item instanceof PDFRef && item.toString() === ref.toString())) {
    array.push(ref);
  }
}

function annotationEntry(info, uuid) {
  return info.liveEntries.find((entry) => entry.uuid === uuid) || null;
}

function sameAnnotationPage(stateA, stateB) {
  return stateA.pageIndex === stateB.pageIndex;
}

function pageFingerprintEqual(a, b) {
  return stableJson(a.pageFingerprints) === stableJson(b.pageFingerprints);
}

function branchMatchesBase(baseInfo, branchInfo) {
  const baseMap = entryMaps(baseInfo);
  const branchMap = entryMaps(branchInfo);
  for (const [uuid, baseState] of baseMap) {
    const candidate = branchMap.get(uuid);
    if (!candidate || !statesEquivalentIgnoringClock(baseState, candidate) || compareStamp(baseState, candidate) !== 0) return false;
  }
  for (const [uuid, branchState] of branchMap) {
    if (!baseMap.has(uuid) && branchState.live) return false;
  }
  return true;
}

function ledgerFromWinnerStates(baseInfo, winners) {
  const entries = [...winners.values()].filter((state) => {
    if (!state.live) return true;
    return Boolean(supportedSubtype(state.kind));
  }).map((state) => ({
    uuid: state.uuid,
    ref: state.deleted ? (pdfJsRef(state.ref) || state.ref || null) : pdfJsRef(state.targetRef) || state.ref || null,
    pageIndex: state.pageIndex,
    kind: state.kind,
    order: state.order,
    deleted: Boolean(state.deleted || !state.live),
    timestamp: state.timestamp || 0,
    logical: state.logical || 0,
    actorId: state.actorId || "legacy",
    operationId: state.operationId || "legacy",
    hash: state.live ? state.hash : null,
  }));
  return {
    version: 1,
    documentId: baseInfo.documentId,
    pageFingerprints: baseInfo.pageFingerprints,
    entries: entries.sort((left, right) => left.uuid.localeCompare(right.uuid)),
  };
}

async function merge({ baseBytes, localBytes, remoteBytes, actorId }) {
  const [baseDoc, localDoc, remoteDoc] = await Promise.all([
    loadPdf(baseBytes, "Loaded base PDF"),
    loadPdf(localBytes, "Prepared local PDF"),
    loadPdf(remoteBytes, "Remote checkpoint PDF"),
  ]);
  const baseInfo = inspectDocument(baseDoc);
  const localInfo = inspectDocument(localDoc);
  const remoteInfo = inspectDocument(remoteDoc);
  validatePageLineage(baseInfo, localInfo, "Local checkpoint");
  validatePageLineage(baseInfo, remoteInfo, "Remote checkpoint");
  if (localInfo.documentId !== remoteInfo.documentId) fail("PDF_MERGE_DOCUMENT_IDENTITY_MISMATCH", "Local and remote bytes do not share the loaded document lineage.");

  if (bytesEqual(baseBytes, remoteBytes) && branchMatchesBase(baseInfo, remoteInfo)) {
    return {
      bytes: new Uint8Array(asBytes(localBytes, "Prepared local PDF")),
      changed: !bytesEqual(localBytes, remoteBytes),
      stateDigest: localInfo.stateDigest,
      ledger: localInfo.ledger,
      identities: localInfo.identities,
      conflicts: [],
    };
  }
  if (branchMatchesBase(baseInfo, localInfo)) {
    return {
      bytes: new Uint8Array(asBytes(remoteBytes, "Remote checkpoint PDF")),
      changed: false,
      stateDigest: remoteInfo.stateDigest,
      ledger: remoteInfo.ledger,
      identities: remoteInfo.identities,
      conflicts: [],
    };
  }

  const baseMap = entryMaps(baseInfo);
  const localMap = entryMaps(localInfo);
  const remoteMap = entryMaps(remoteInfo);
  const uuids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
  const selected = new Map();
  const conflicts = [];
  for (const uuid of uuids) {
    const baseState = baseMap.get(uuid) || null;
    const localState = localMap.get(uuid) || null;
    const remoteState = remoteMap.get(uuid) || null;
    const winner = chooseState(baseState, localState, remoteState, uuid);
    if (winner) selected.set(uuid, winner);
    const localChanged = localState && (!baseState || !statesEquivalentIgnoringClock(localState, baseState) || compareStamp(localState, baseState) !== 0);
    const remoteChanged = remoteState && (!baseState || !statesEquivalentIgnoringClock(remoteState, baseState) || compareStamp(remoteState, baseState) !== 0);
    if (localChanged && remoteChanged && !sameValueState(localState, remoteState)) {
      conflicts.push({ uuid, winner: winner === localState ? "local" : "remote" });
    }
  }

  const baseStructure = structureTreeSignature(baseInfo);
  const localStructure = structureTreeSignature(localInfo);
  const remoteStructure = structureTreeSignature(remoteInfo);
  const taggedWinners = [...selected.entries()].filter(([uuid, state]) => {
    if (!state.live) return false;
    const localEntry = annotationEntry(localInfo, uuid);
    const remoteEntry = annotationEntry(remoteInfo, uuid);
    const chosen = state.entry;
    return Boolean(chosen?.dict?.get(PDFName.of("StructParent")) || localEntry?.dict?.get(PDFName.of("StructParent")) || remoteEntry?.dict?.get(PDFName.of("StructParent")));
  });
  if (taggedWinners.length && !(baseStructure !== null && baseStructure === localStructure && baseStructure === remoteStructure)) {
    fail("PDF_MERGE_TAGGED_STRUCTURE_TREE_UNSAFE", "A tagged annotation changed together with its structure tree. Keep the local PDF checkpoint and resolve this tagged-structure conflict manually.");
  }

  for (const [uuid, state] of selected) {
    if (state.live) continue;
    const baseEntry = annotationEntry(baseInfo, uuid);
    const localEntry = annotationEntry(localInfo, uuid);
    const remoteEntry = annotationEntry(remoteInfo, uuid);
    if (remoteEntry?.dict.get(PDFName.of("StructParent"))) {
      fail("PDF_MERGE_TAGGED_STRUCTURE_TREE_UNSAFE", `Deleting tagged annotation ${uuid} would leave the remote structure tree dangling. Keep the local checkpoint and resolve this tagged-structure conflict manually.`);
    }
    if (!remoteEntry && (baseEntry?.dict.get(PDFName.of("StructParent")) || localEntry?.dict.get(PDFName.of("StructParent")))) {
      // The remote branch already removed the tagged object. Its tree is kept
      // intact from that branch; this merge must not try to edit its tag tree.
      continue;
    }
  }

  // Keep stable remote refs for identities it already owns; reserve destination
  // refs for local-only winners before rewriting /IRT or popup /Parent links.
  const destinationRefs = new Map();
  for (const [uuid, state] of selected) {
    if (!state.live) continue;
    const remoteEntry = annotationEntry(remoteInfo, uuid);
    const ref = remoteEntry?.ref || remoteDoc.context.nextRef();
    destinationRefs.set(uuid, ref);
    state.targetRef = ref;
  }

  const entriesForOrder = [...selected.entries()].filter(([, state]) => state.live).sort(([, left], [, right]) =>
    (left.pageIndex - right.pageIndex) || (left.order - right.order) || left.uuid.localeCompare(right.uuid),
  );
  for (const [uuid, state] of selected) {
    const remoteEntry = annotationEntry(remoteInfo, uuid);
    if (!state.live) {
      if (remoteEntry) {
        removeRefFromPage(remoteDoc, remoteEntry.pageIndex, remoteEntry.ref);
        const popupRef = remoteEntry.dict.get(PDFName.of("Popup"));
        if (popupRef instanceof PDFRef) removeRefFromPage(remoteDoc, remoteEntry.pageIndex, popupRef);
      }
      continue;
    }
    const selectedEntry = state.entry;
    if (!(selectedEntry?.dict instanceof PDFDict)) {
      fail("PDF_MERGE_WINNER_BYTES_MISSING", `The winning PDF object for ${uuid} is not available in either branch.`);
    }
    if (remoteEntry && !sameAnnotationPage(state, remoteEntry.identity)) {
      fail("PDF_MERGE_PAGE_MOVE_UNSUPPORTED", `Annotation ${uuid} changed page between branches.`);
    }
    const sourceInfo = selectedEntry.refString && localInfo.maps.byRef.get(selectedEntry.refString) === selectedEntry ? localInfo : remoteInfo;
    const sourceEntry = annotationEntry(sourceInfo, uuid);
    if (!sourceEntry) fail("PDF_MERGE_WINNER_BYTES_MISSING", `The selected annotation bytes for ${uuid} are unavailable.`);
    if (sourceEntry.dict.get(PDFName.of("Parent"))) {
      fail("PDF_MERGE_ANNOTATION_RELATION_UNBOUND", `Annotation ${uuid} has a /Parent relationship that cannot be safely redirected.`);
    }
    const destinationPage = remoteDoc.getPages()[state.pageIndex];
    if (!destinationPage) fail("PDF_MERGE_PAGE_OUT_OF_RANGE", `Winning annotation ${uuid} refers to missing page ${state.pageIndex + 1}.`);
    const targetRef = destinationRefs.get(uuid);
    let popupTargetRef = null;
    const remotePopup = remoteEntry?.dict.get(PDFName.of("Popup"));
    if (remotePopup instanceof PDFRef) {
      const remotePopupDict = resolve(remoteDoc.context, remotePopup);
      if (remotePopupDict instanceof PDFDict && remotePopupDict.get(PDFName.of("StructParent"))) {
        fail("PDF_MERGE_TAGGED_POPUP_UNSAFE", `Popup for ${uuid} has a tagged structure-tree association that cannot be copied safely.`);
      }
    }
    if (remotePopup instanceof PDFRef) popupTargetRef = remotePopup;
    const keepStructParent = Boolean(sourceEntry.dict.get(PDFName.of("StructParent"))) && structurallySafeTaggedCopy(baseInfo, localInfo, remoteInfo, uuid, sourceEntry, remoteEntry);
    const anyStructParent = Boolean(
      sourceEntry.dict.get(PDFName.of("StructParent")) ||
      annotationEntry(baseInfo, uuid)?.dict.get(PDFName.of("StructParent")) ||
      remoteEntry?.dict.get(PDFName.of("StructParent")),
    );
    if (anyStructParent && !keepStructParent) {
      fail("PDF_MERGE_TAGGED_ANNOTATION_UNSAFE", `Tagged annotation ${uuid} has no provably stable structure-tree binding. Keep the local checkpoint and resolve it manually.`);
    }
    const options = { popupTargetRef, keepStructParent };
    cloneSanitizedDictionary(sourceInfo, sourceEntry, remoteDoc, targetRef, destinationPage.ref, destinationRefs, options);
    if (!remoteEntry) appendRefToPage(remoteDoc, state.pageIndex, targetRef);
    if (options.popupResult) {
      const popupWasListed = sourceInfo.maps.byPage[state.pageIndex]?.some((entry) => entry.refString === refText(options.popupResult.sourceRef));
      if (popupWasListed) appendRefToPage(remoteDoc, state.pageIndex, options.popupResult.ref);
    } else if (remotePopup instanceof PDFRef) {
      removeRefFromPage(remoteDoc, state.pageIndex, remotePopup);
    }
  }

  const winners = new Map();
  for (const [uuid, state] of selected) {
    const remoteEntry = annotationEntry(remoteInfo, uuid);
    const ref = state.live ? destinationRefs.get(uuid)?.toString() : remoteEntry?.refString || state.ref || null;
    const identity = {
      ...state,
      uuid,
      ref,
      deleted: !state.live,
      pageIndex: state.pageIndex ?? remoteEntry?.pageIndex ?? 0,
      kind: state.kind || remoteEntry?.kind || "unknown",
      order: state.order ?? remoteEntry?.order ?? 0,
    };
    winners.set(uuid, identity);
  }
  const ledger = ledgerFromWinnerStates(baseInfo, winners);
  const stateDigest = digestEntries(ledger.entries);
  if (stateDigest === remoteInfo.stateDigest) {
    return {
      bytes: new Uint8Array(asBytes(remoteBytes, "Remote checkpoint PDF")),
      changed: false,
      stateDigest,
      ledger: remoteInfo.ledger,
      identities: remoteInfo.identities,
      conflicts,
    };
  }
  writeLedger(remoteDoc, ledger);
  let bytes;
  try {
    bytes = await remoteDoc.save({ useObjectStreams: false, addDefaultPage: false, objectsPerTick: 100 });
  } catch (error) {
    throw errorFromLoad(error, "Merged PDF");
  }
  const resultInfo = inspectDocument(await loadPdf(bytes, "Merged PDF"));
  const identities = resultInfo.identities;
  return { bytes, changed: true, stateDigest: resultInfo.stateDigest, ledger: resultInfo.ledger, identities, conflicts };
}

function bytesEqual(left, right) {
  const a = asBytes(left, "PDF bytes");
  const b = asBytes(right, "PDF bytes");
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

async function inspect({ bytes }) {
  const doc = await loadPdf(bytes, "PDF to inspect");
  const info = inspectDocument(doc);
  return {
    documentId: info.documentId,
    stateDigest: info.stateDigest,
    ledger: info.ledger,
    identities: info.identities,
    annotations: info.identities,
    tagged: hasStructTree(info),
  };
}

module.exports = {
  PdfMergeError,
  prepareLocal,
  merge,
  inspect,
  _internals: {
    canonicalValue,
    digestEntries,
    documentIdFromPageFingerprints,
    getPageFingerprint,
    hashText,
    refMaps,
    stableJson,
  },
};
