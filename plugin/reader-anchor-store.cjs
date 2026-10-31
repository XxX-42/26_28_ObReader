/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { canonicalJson, seal, verify } = require("./storage/canonical.cjs");

const ROOT = "00_Archive/20_PDFData/anchors";
const DOC_KEY = /^[a-f0-9]{12}$/i;
const ANCHOR_ID = /^[A-Za-z0-9_-]{8,128}$/;
const SOURCE_HASH = /^(?:xxh64-v1:[a-f0-9]{16}|sha256-v1:[a-f0-9]{64})$/i;
const PAGE_DIGEST = SOURCE_HASH;
const ANCHOR_KINDS = new Set(["selection", "annotation", "page"]);

function codedError(code, message) {
  const error = new Error(message);
  error.name = "ReaderAnchorError";
  error.code = code;
  return error;
}

function parseReaderLinkFragment(value) {
  const raw = typeof value === "string" ? value.replace(/^#/, "") : "";
  const params = new URLSearchParams(raw.replaceAll("&amp;", "&"));
  const pageValue = params.get("page");
  const pageNumber = pageValue && /^\d{1,6}$/.test(pageValue) ? Number(pageValue) : null;
  const obreader = params.get("obreader");
  let target = null;
  if (typeof obreader === "string") {
    const match = /^(sel|ann|page)\.(.{1,512})$/.exec(obreader);
    const safeId = match?.[2] && !/[\u0000-\u001f\u007f-\u009f&#?]/.test(match[2]) &&
      (match[1] !== "sel" || ANCHOR_ID.test(match[2]));
    if (match && safeId) target = { kind: match[1] === "sel" ? "selection" : match[1] === "ann" ? "annotation" : "page",
      id: match[2] };
  }
  const docKey = params.get("docKey");
  const documentId = params.get("obdoc");
  const selection = params.get("selection");
  return {
    pageNumber,
    selection: typeof selection === "string" && selection.length <= 128 ? selection : null,
    docKey: DOC_KEY.test(docKey || "") ? docKey.toLowerCase() : null,
    documentId: typeof documentId === "string" && documentId.length <= 512 ? documentId : null,
    target,
  };
}

function encodeReaderLinkFragment(options = {}) {
  const { pageNumber, selection, target, docKey, documentId } = options;
  const params = new URLSearchParams();
  if (Number.isSafeInteger(pageNumber) && pageNumber > 0) params.set("page", String(pageNumber));
  if (typeof selection === "string" && selection.length > 0 && selection.length <= 128 &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(selection)) params.set("selection", selection);
  // Validate internal routing identity for callers, but never expose it in a
  // copied Markdown link. ObReader resolves the current route from the PDF
  // path and verifies the stable object/anchor identity inside its own stores.
  if (docKey !== undefined || documentId !== undefined) {
    if (!DOC_KEY.test(typeof docKey === "string" ? docKey : "") ||
        typeof documentId !== "string" || !documentId || documentId.length > 512 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(documentId)) {
      throw codedError("READER_LINK_IDENTITY_INVALID", "A valid document key and document identity are required together.");
    }
  }
  if (options.includeIdentity === true) {
    if (!docKey || !documentId) throw codedError("READER_LINK_IDENTITY_INVALID", "Region links require document identity.");
    params.set("docKey", docKey); params.set("obdoc", documentId);
  }
  if (target && ANCHOR_KINDS.has(target.kind) && typeof target.id === "string" &&
      target.id.length > 0 && target.id.length <= 512 && !/[\u0000-\u001f\u007f-\u009f&#?]/.test(target.id)) {
    const prefix = target.kind === "selection" ? "sel" : target.kind === "annotation" ? "ann" : "page";
    params.set("obreader", `${prefix}.${target.id}`);
  }
  return params.toString();
}

function parseReaderLinkDestination(value) {
  const raw = typeof value === "string" ? value : "";
  const marker = raw.indexOf("#");
  if (marker < 0) return { routePath: null, ...parseReaderLinkFragment(raw) };
  let routePath = raw.slice(0, marker).trim();
  try { routePath = decodeURIComponent(routePath); } catch { /* Keep malformed legacy path literal. */ }
  return { routePath: routePath || null, ...parseReaderLinkFragment(raw.slice(marker + 1)) };
}

function validateSelectionAnchor(value) {
  if (!value || value.schemaVersion !== 1 || value.kind !== "obreader-selection-anchor" ||
      !ANCHOR_ID.test(value.anchorId || "") || !DOC_KEY.test(value.docKey || "") ||
      typeof value.documentId !== "string" || !value.documentId || value.documentId.length > 512 ||
      typeof value.sourceHash !== "string" || !SOURCE_HASH.test(value.sourceHash) ||
      typeof value.pageIdentity !== "string" || !value.pageIdentity || value.pageIdentity.length > 512 ||
      !Number.isSafeInteger(value.pageIndexHint) || value.pageIndexHint < 0 ||
      !Number.isSafeInteger(value.textPosition?.start) || value.textPosition.start < 0 ||
      !Number.isSafeInteger(value.textPosition?.end) || value.textPosition.end <= value.textPosition.start ||
      typeof value.exactQuote !== "string" || !value.exactQuote || value.exactQuote.length > 4096 ||
      typeof value.prefix !== "string" || value.prefix.length > 256 ||
      typeof value.suffix !== "string" || value.suffix.length > 256) {
    throw codedError("READER_ANCHOR_INVALID", "The Selection Anchor is incomplete or invalid.");
  }
  const geometry = value.geometry;
  if (geometry !== null && geometry !== undefined &&
      (!geometry || ![geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite) ||
       geometry.x < 0 || geometry.y < 0 || geometry.width < 0 || geometry.height < 0 ||
       geometry.x + geometry.width > 1.001 || geometry.y + geometry.height > 1.001)) {
    throw codedError("READER_ANCHOR_GEOMETRY_INVALID", "The Selection Anchor geometry is invalid.");
  }
  if (typeof value.orderedPageIdentityDigest !== "string" || !PAGE_DIGEST.test(value.orderedPageIdentityDigest) ||
      !Number.isSafeInteger(value.pageCount) || value.pageCount < 1 || value.pageIndexHint >= value.pageCount) {
    throw codedError("READER_ANCHOR_SOURCE_INVALID", "The Selection Anchor source evidence is incomplete.");
  }
  return value;
}

function createReaderAnchorStore({ adapter, hash, makeId, currentStore = null, root = ROOT } = {}) {
  if (!adapter || !["exists", "read", "write", "rename", "mkdir", "list"].every((method) => typeof adapter[method] === "function")) {
    throw new TypeError("Reader Anchor Store requires the cross-platform Obsidian DataAdapter API.");
  }
  if (typeof hash !== "function" || typeof makeId !== "function") {
    throw new TypeError("Reader Anchor Store requires injected hashing and ID functions.");
  }
  async function ensureDirectory(directory) {
    const parts = directory.split("/");
    let current = "";
    for (const part of parts) {
      if (!part || part === "." || part === ".." || /[\\\x00-\x1f]/.test(part)) {
        throw codedError("READER_ANCHOR_PATH_INVALID", "Unsafe Anchor Store path.");
      }
      current = current ? `${current}/${part}` : part;
      if (await adapter.exists(current)) continue;
      try { await adapter.mkdir(current); }
      catch (error) { if (!(await adapter.exists(current))) throw error; }
    }
  }

  function directoryFor(docKey) {
    if (!DOC_KEY.test(docKey || "")) throw codedError("READER_ANCHOR_DOCKEY_INVALID", "A stable document key is required.");
    return `${root}/${docKey.toLowerCase()}`;
  }

  function pathFor(docKey, anchorId) {
    if (!ANCHOR_ID.test(anchorId || "")) throw codedError("READER_ANCHOR_ID_INVALID", "A valid Anchor ID is required.");
    return `${directoryFor(docKey)}/${anchorId}.json`;
  }

  async function inlineDocuments(docKey=null){
    if(!currentStore)return [];
    const registryPath=`${root.slice(0,root.lastIndexOf('/'))}/_registry.json`;
    if(!await adapter.exists(registryPath))return [];
    const registry=JSON.parse(await adapter.read(registryPath));
    if(registry.schemaVersion!==15||!registry.entries)throw codedError('READER_ANCHOR_REGISTRY_INVALID','Cannot verify annotation routes.');
    const documents=[];
    for(const row of Object.values(registry.entries)){
      if(docKey&&row.docKey!==docKey)continue;
      currentStore.bindPath(row.sourcePath,row.jsonlPath);
      const current=await currentStore.readCurrent(row.sourcePath);
      if(!current||current.document.docKey!==row.docKey||current.document.documentId!==row.documentId)throw codedError('READER_ANCHOR_IDENTITY_MISMATCH','Annotation route cannot be verified.');
      documents.push(current);
    }
    return documents;
  }
  async function inlineGet(docKey,anchorId){
    const docs=await inlineDocuments(docKey);
    const matches=docs.flatMap(d=>(d.selectionAnchors||[]).filter(a=>a.anchorId===anchorId));
    if(matches.length>1)throw codedError('READER_ANCHOR_ID_AMBIGUOUS','Multiple documents contain this selection anchor.');
    return matches[0]||null;
  }
  async function migrateDocument(docKey){
    if(!currentStore)throw codedError('READER_ANCHOR_BACKEND_REQUIRED','Inline anchor storage is not configured.');
    const docs=await inlineDocuments(docKey);
    if(docs.length!==1)throw codedError('READER_ANCHOR_DOCUMENT_MISSING','Exactly one verified annotation JSONL is required.');
    const directory=directoryFor(docKey),files=await adapter.exists(directory)?(await adapter.list(directory)).files:[];
    const anchors=[],originals=[];
    for(const path of files){
      const name=path.slice(path.lastIndexOf('/')+1);if(!name.endsWith('.json'))continue;
      const id=name.slice(0,-5);if(!ANCHOR_ID.test(id))throw codedError('READER_ANCHOR_ID_INVALID','Invalid legacy anchor filename.');
      const text=await adapter.read(path),sealed=JSON.parse(text),unsigned=await verify(sealed,hash);validateSelectionAnchor(unsigned);
      if(unsigned.docKey!==docKey||unsigned.anchorId!==id||unsigned.documentId!==docs[0].document.documentId)throw codedError('READER_ANCHOR_IDENTITY_MISMATCH','Legacy anchor identity differs.');
      anchors.push(sealed);originals.push({path,text});
    }
    const doc=docs[0];
    await currentStore.saveSelectionAnchors({sourcePath:doc.document.sourcePath,pairId:doc.pairId,anchors});
    for(const a of anchors){const saved=await inlineGet(docKey,a.anchorId);if(canonicalJson(saved)!==canonicalJson(a))throw codedError('READER_ANCHOR_WRITE_MISMATCH','Migrated anchor did not verify.');}
    for(const {path,text} of originals){if(await adapter.read(path)!==text)throw codedError('READER_ANCHOR_STALE_MIGRATION','Legacy anchor changed; retained.');await adapter.remove(path);}
    return {docKey,migrated:anchors.length};
  }

  async function create(input) {
    const anchorId = input?.anchorId || makeId();
    const unsigned = validateSelectionAnchor({ ...input, anchorId, schemaVersion: 1, kind: "obreader-selection-anchor" });
    const target = pathFor(unsigned.docKey, anchorId);
    if(currentStore){
      const docs=await inlineDocuments(unsigned.docKey);
      if(docs.length>1)throw codedError('READER_ANCHOR_DOCUMENT_MISSING','Multiple annotation routes.');
      if(docs.length===1){
      if(await inlineGet(unsigned.docKey,anchorId)||await adapter.exists(target))throw codedError('READER_ANCHOR_ID_COLLISION','Anchor ID already exists.');
      const sealed=await seal(unsigned,hash),doc=docs[0];
      await currentStore.saveSelectionAnchors({sourcePath:doc.document.sourcePath,pairId:doc.pairId,anchors:[sealed]});
      return sealed;
      }
    }
    if (await adapter.exists(target)) throw codedError("READER_ANCHOR_ID_COLLISION", "The immutable Anchor ID is already in use.");
    await ensureDirectory(directoryFor(unsigned.docKey));
    const sealed = await seal(unsigned, hash);
    const text = canonicalJson(sealed);
    const temporary = `${target}.${makeId()}.pending`;
    await adapter.write(temporary, text);
    if (await adapter.read(temporary) !== text) throw codedError("READER_ANCHOR_STAGE_MISMATCH", "The Anchor Store staged write did not verify.");
    if (await adapter.exists(target)) throw codedError("READER_ANCHOR_ID_COLLISION", "The immutable Anchor ID was claimed during the write.");
    await adapter.rename(temporary, target);
    if (await adapter.read(target) !== text) throw codedError("READER_ANCHOR_WRITE_MISMATCH", "The persisted Anchor did not verify.");
    return sealed;
  }

  async function get(docKey, anchorId, expectedDocumentId = null) {
    const target = pathFor(docKey, anchorId);
    const inline=await inlineGet(docKey,anchorId);
    if(!inline&&!(await adapter.exists(target)))return null;
    let parsed;
    try { parsed = inline || JSON.parse(await adapter.read(target)); }
    catch { throw codedError("READER_ANCHOR_JSON_INVALID", "The Anchor record is incomplete or malformed."); }
    let unsigned;
    try { unsigned = await verify(parsed, hash); }
    catch (error) { throw codedError(error.code || "READER_ANCHOR_INTEGRITY_INVALID", "The Anchor integrity check failed."); }
    validateSelectionAnchor(unsigned);
    if (unsigned.docKey.toLowerCase() !== docKey.toLowerCase() || unsigned.anchorId !== anchorId ||
        (expectedDocumentId && unsigned.documentId !== expectedDocumentId)) {
      throw codedError("READER_ANCHOR_IDENTITY_MISMATCH", "The Anchor belongs to a different document identity.");
    }
    return unsigned;
  }

  async function list(docKey) {
    const directory = directoryFor(docKey);
    const inline=(await inlineDocuments(docKey)).flatMap(d=>d.selectionAnchors||[]);
    if (!(await adapter.exists(directory))) { const anchors=[];for(const a of inline)anchors.push(await get(docKey,a.anchorId));return {anchors,errors:[]}; }
    const listing = await adapter.list(directory);
    const anchors = [];
    const errors = [];
    for (const path of listing.files || []) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (!name.endsWith(".json")) continue;
      const anchorId = name.slice(0, -5);
      if (!ANCHOR_ID.test(anchorId)) { errors.push({ path, code: "READER_ANCHOR_ID_INVALID" }); continue; }
      try {
        const anchor = await get(docKey, anchorId);
        if (anchor) anchors.push(anchor);
      } catch (error) { errors.push({ path, code: error.code || "READER_ANCHOR_INVALID" }); }
    }
    for(const a of inline)if(!anchors.some(x=>x.anchorId===a.anchorId))anchors.push(await get(docKey,a.anchorId));
    anchors.sort((left, right) => left.anchorId.localeCompare(right.anchorId));
    return { anchors, errors };
  }

  async function findById(anchorId) {
    if (!ANCHOR_ID.test(anchorId || "")) {
      throw codedError("READER_ANCHOR_ID_INVALID", "A valid Anchor ID is required.");
    }
    const inlineMatches=[];for(const d of await inlineDocuments())for(const a of d.selectionAnchors||[])if(a.anchorId===anchorId)inlineMatches.push(await get(d.document.docKey,anchorId));
    if(inlineMatches.length>1)throw codedError('READER_ANCHOR_ID_AMBIGUOUS','Multiple documents contain this ID.');
    if(inlineMatches.length)return inlineMatches[0];
    if (!(await adapter.exists(root))) return null;
    const listing = await adapter.list(root);
    const matches = [];
    for (const folder of listing.folders || []) {
      const normalized = String(folder).replace(/\/+$/u, "");
      const docKey = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
      if (!DOC_KEY.test(docKey)) continue;
      const target = pathFor(docKey, anchorId);
      if (!(await adapter.exists(target))) continue;
      const anchor = await get(docKey, anchorId);
      if (anchor) matches.push(anchor);
      if (matches.length > 1) {
        throw codedError("READER_ANCHOR_ID_AMBIGUOUS", "The Anchor ID resolves to more than one document.");
      }
    }
    return matches[0] || null;
  }

  async function findManyById(anchorIds) {
    const requested = new Set();
    const anchors = new Map();
    const errors = new Map();
    for (const anchorId of Array.isArray(anchorIds) ? anchorIds : []) {
      if (typeof anchorId !== "string" || !ANCHOR_ID.test(anchorId)) {
        errors.set(String(anchorId), codedError("READER_ANCHOR_ID_INVALID", "A valid Anchor ID is required."));
        continue;
      }
      requested.add(anchorId);
    }
    if(currentStore){
      for(const doc of await inlineDocuments())for(const value of doc.selectionAnchors||[]){
        const id=value.anchorId;if(!requested.has(id))continue;
        if(anchors.has(id)||errors.has(id)){anchors.delete(id);errors.set(id,codedError('READER_ANCHOR_ID_AMBIGUOUS','Multiple documents contain this ID.'));continue;}
        try{const a=validateSelectionAnchor(await verify(value,hash));anchors.set(id,a);}catch(e){errors.set(id,e);}
      }
      if(await adapter.exists(root))for(const id of requested)if(!anchors.has(id)&&!errors.has(id)){try{const a=await findById(id);if(a)anchors.set(id,a);}catch(e){errors.set(id,e)}}
      return {anchors,errors};
    }
    if (!requested.size || !(await adapter.exists(root))) return { anchors, errors };

    // A one-time directory listing locates compact links by their immutable
    // filename, without scanning every Anchor payload or doing one root walk
    // per Markdown link.
    const rootListing = await adapter.list(root);
    const candidates = new Map([...requested].map((anchorId) => [anchorId, []]));
    for (const folder of rootListing.folders || []) {
      const normalized = String(folder).replace(/\/+$/u, "");
      const docKey = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
      if (!DOC_KEY.test(docKey)) continue;
      const directory = directoryFor(docKey);
      const listing = await adapter.list(directory);
      for (const filePath of listing.files || []) {
        const filename = String(filePath).slice(String(filePath).lastIndexOf("/") + 1);
        if (!filename.endsWith(".json")) continue;
        const anchorId = filename.slice(0, -5);
        if (candidates.has(anchorId)) candidates.get(anchorId).push(docKey);
      }
    }
    for (const [anchorId, docKeys] of candidates) {
      if (!docKeys.length) continue;
      if (docKeys.length > 1) {
        errors.set(anchorId, codedError("READER_ANCHOR_ID_AMBIGUOUS",
          "The Anchor ID resolves to more than one document."));
        continue;
      }
      try {
        const anchor = await get(docKeys[0], anchorId);
        if (anchor) anchors.set(anchorId, anchor);
      } catch (error) {
        errors.set(anchorId, error);
      }
    }
    return { anchors, errors };
  }

  return Object.freeze({ root, directoryFor, pathFor, create, get, list, findById, findManyById, migrateDocument });
}

module.exports = {
  ROOT,
  parseReaderLinkFragment,
  parseReaderLinkDestination,
  encodeReaderLinkFragment,
  validateSelectionAnchor,
  createReaderAnchorStore,
};
