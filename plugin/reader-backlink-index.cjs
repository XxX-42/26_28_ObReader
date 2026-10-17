/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { parseReaderLinkDestination } = require("./reader-anchor-store.cjs");

function targetKey(docKey, target, documentId = "") {
  if (!docKey || !target?.kind || typeof target.id !== "string") return null;
  return `${docKey}:${documentId || "*"}:${target.kind}:${target.id}`;
}

function normalizePdfRoutePath(routePath, markdownSourcePath = "") {
  if (typeof routePath !== "string" || !routePath.trim()) return null;
  let value = routePath.trim().replaceAll("\\", "/").normalize("NFC");
  try { value = decodeURIComponent(value); } catch { /* Preserve a literal malformed/legacy route. */ }
  // Obsidian treats explicit ./ and ../ destinations relative to the Markdown
  // note. Generated Reader links use vault-relative PDF paths, so bare paths
  // are deliberately kept vault-relative instead of being prefixed by the note.
  if (/^(?:\.\/|\.\.\/)/.test(value)) {
    const source = typeof markdownSourcePath === "string" ? markdownSourcePath.replaceAll("\\", "/") : "";
    const slash = source.lastIndexOf("/");
    value = `${slash >= 0 ? source.slice(0, slash + 1) : ""}${value}`;
  }
  const parts = [];
  for (const part of value.replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (parts.length) parts.pop(); continue; }
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

function routeTargetKey(routePath, target) {
  if (!routePath || !target?.kind || typeof target.id !== "string") return null;
  return `route:${routePath}:${target.kind}:${target.id}`;
}

function rowSort(left, right) {
  return left.sourcePath.localeCompare(right.sourcePath) || (left.offset ?? -1) - (right.offset ?? -1);
}

function occurrenceKey(pageIdentity, start, end) {
  if (typeof pageIdentity !== "string" || !pageIdentity ||
      !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end <= start) return null;
  return `${pageIdentity}\0${start}\0${end}`;
}

async function buildReaderBacklinkPageIndex({
  index,
  anchorStore,
  docKey,
  documentId,
  sourcePath = null,
  pageIdentities,
  annotations = [],
  tombstones = [],
  onInvalidAnchor = null,
} = {}) {
  if (!index || !docKey || !documentId || !Array.isArray(pageIdentities)) {
    throw new TypeError("A document identity, page identities, and backlink index are required.");
  }
  const pages = new Map();
  const occurrences = new Map();
  const anchorsById = new Map();
  const validPages = new Set(pageIdentities);
  const getPage = (pageIdentity) => {
    let page = pages.get(pageIdentity);
    if (!page) pages.set(pageIdentity, (page = { rows: [], markers: new Map() }));
    return page;
  };
  const buildStartedAt = Date.now();
  const lookupStartedAt = Date.now();
  const identityRows = index.getDocument(docKey, documentId);
  const routeRows = typeof sourcePath === "string" && sourcePath &&
      typeof index.getByPdfPath === "function"
    ? index.getByPdfPath(sourcePath) : [];
  // Old links may have both identity parameters and a route. Collapse those
  // duplicate index entries before counting markers or resolving Anchors.
  const uniqueRows = new Map();
  for (const row of [...identityRows, ...routeRows]) {
    uniqueRows.set(`${row.sourcePath}\0${row.offset}\0${row.target.kind}\0${row.target.id}`, row);
  }
  const rows = [...uniqueRows.values()].sort(rowSort);
  const backlinkLookupMs = Math.max(0, Date.now() - lookupStartedAt);
  const anchorStartedAt = Date.now();
  const selectionRows = new Map();
  const liveAnnotations = new Map();
  const deletedAnnotations = new Map();
  for (const annotation of Array.isArray(annotations) ? annotations : []) {
    if (typeof annotation?.uuid === "string") liveAnnotations.set(annotation.uuid, annotation);
  }
  for (const tombstone of Array.isArray(tombstones) ? tombstones : []) {
    if (typeof tombstone?.uuid === "string") deletedAnnotations.set(tombstone.uuid, tombstone);
  }

  for (const row of rows) {
    if (row.target.kind === "page") {
      if (!validPages.has(row.target.id)) continue;
      const page = getPage(row.target.id);
      page.rows.push(row);
      const key = `page:${row.target.id}`;
      const marker = page.markers.get(key) || { kind: "page", id: row.target.id, backlinkCount: 0 };
      marker.backlinkCount += 1;
      page.markers.set(key, marker);
    } else if (row.target.kind === "selection") {
      let linked = selectionRows.get(row.target.id);
      if (!linked) selectionRows.set(row.target.id, (linked = []));
      linked.push(row);
    } else if (row.target.kind === "annotation") {
      const annotation = liveAnnotations.get(row.target.id);
      const tombstone = deletedAnnotations.get(row.target.id);
      const state = annotation || tombstone;
      const pageIndex = state?.pageIndex;
      const pageIdentity = Number.isSafeInteger(pageIndex) ? pageIdentities[pageIndex] : null;
      if (!pageIdentity) continue;
      const page = getPage(pageIdentity);
      page.rows.push(annotation ? row : { ...row, targetStatus: "deleted" });
      if (annotation) {
        const key = `annotation:${annotation.uuid}`;
        const marker = page.markers.get(key) || { kind: "annotation", id: annotation.uuid, backlinkCount: 0 };
        marker.backlinkCount += 1;
        page.markers.set(key, marker);
      }
    }
  }

  for (const [anchorId, linkedRows] of selectionRows) {
    let anchor = null;
    try {
      anchor = await anchorStore?.get?.(docKey, anchorId, documentId) || null;
    } catch (error) {
      onInvalidAnchor?.(error, anchorId);
      continue;
    }
    if (!anchor || anchor.documentId !== documentId || anchor.docKey !== docKey ||
        !validPages.has(anchor.pageIdentity)) continue;
    const page = getPage(anchor.pageIdentity);
    page.rows.push(...linkedRows);
    page.markers.set(`selection:${anchorId}`, {
      kind: "selection", id: anchorId, anchor,
      backlinkCount: linkedRows.length,
    });
    const key = occurrenceKey(anchor.pageIdentity, anchor.textPosition?.start, anchor.textPosition?.end);
    if (key) {
      let occurrence = occurrences.get(key);
      if (!occurrence) occurrences.set(key, (occurrence = { anchorIds: [], rows: [] }));
      occurrence.anchorIds.push(anchorId);
      occurrence.rows.push(...linkedRows);
    }
    anchorsById.set(anchorId, { anchor, rows: linkedRows });
  }

  const immutablePage = (pageIdentity) => {
    const page = pages.get(pageIdentity);
    if (!page) return { rows: [], markers: [] };
    return { rows: [...page.rows], markers: [...page.markers.values()] };
  };
  const anchorResolveMs = Math.max(0, Date.now() - anchorStartedAt);
  const buildMs = Math.max(0, Date.now() - buildStartedAt);
  const normalizeRows = (values) => {
    const unique = new Map();
    for (const row of values || []) unique.set(`${row.sourcePath}\0${row.offset}\0${row.target.kind}\0${row.target.id}`, row);
    return [...unique.values()].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath) ||
      (left.offset ?? -1) - (right.offset ?? -1));
  };
  return Object.freeze({
    documentId,
    docKey,
    pageCount: pageIdentities.length,
    backlinkLookupMs,
    anchorResolveMs,
    buildMs,
    forPage(pageIdentity) {
      const page = immutablePage(pageIdentity);
      return { rows: normalizeRows(page.rows), markers: page.markers };
    },
    forOccurrence(pageIdentity, start, end) {
      const value = occurrences.get(occurrenceKey(pageIdentity, start, end));
      return value ? { anchorIds: [...new Set(value.anchorIds)], rows: normalizeRows(value.rows) } :
        { anchorIds: [], rows: [] };
    },
    forAnchorIds(anchorIds) {
      const values = [];
      for (const anchorId of Array.isArray(anchorIds) ? anchorIds : []) {
        values.push(...(anchorsById.get(anchorId)?.rows || []));
      }
      return normalizeRows(values);
    },
    anchorCount: anchorsById.size,
  });
}

function createReaderBacklinkIndex() {
  const byTarget = new Map();
  const byPdfRoute = new Map();
  const bySource = new Map();
  let revision = 0;

  function removeFile(sourcePath) {
    const prior = bySource.get(sourcePath);
    if (!prior) return false;
    for (const [key, rowIds] of prior) {
      const rows = byTarget.get(key) || byPdfRoute.get(key);
      if (!rows) continue;
      for (const rowId of rowIds) rows.delete(rowId);
      if (rows.size === 0) {
        byTarget.delete(key);
        byPdfRoute.delete(key);
      }
    }
    bySource.delete(sourcePath);
    revision += 1;
    return true;
  }

  function replaceFile(file, cache) {
    const sourcePath = typeof file === "string" ? file : file?.path;
    if (!sourcePath) return false;
    removeFile(sourcePath);
    const links = Array.isArray(cache?.links) ? cache.links : [];
    const sourceTargets = new Map();
    for (const link of links) {
      if (typeof link?.link !== "string") continue;
      const parsed = parseReaderLinkDestination(link.link);
      if (!parsed.target) continue;
      const routePath = normalizePdfRoutePath(parsed.routePath, sourcePath);
      const identityIndexKey = targetKey(parsed.docKey, parsed.target, parsed.documentId || "*");
      const routeIndexKey = routeTargetKey(routePath, parsed.target);
      if (!identityIndexKey && !routeIndexKey) continue;
      const start = Number.isSafeInteger(link.position?.start?.offset) ? link.position.start.offset : -1;
      const row = Object.freeze({
        sourcePath,
        target: parsed.target,
        routePath,
        docKey: parsed.docKey,
        documentId: parsed.documentId,
        pageNumber: parsed.pageNumber,
        selection: parsed.selection,
        displayText: typeof link.displayText === "string" && link.displayText ? link.displayText : null,
        line: Number.isSafeInteger(link.position?.start?.line) ? link.position.start.line : null,
        offset: start,
      });
      const indexes = identityIndexKey
        ? [[byTarget, identityIndexKey]]
        : [[byPdfRoute, routeIndexKey]];
      for (const [table, key] of indexes) {
        if (!key) continue;
        const rowId = `${sourcePath}\0${start}\0${key}`;
        let rows = table.get(key);
        if (!rows) table.set(key, (rows = new Map()));
        rows.set(rowId, row);
        let sourceRows = sourceTargets.get(key);
        if (!sourceRows) sourceTargets.set(key, (sourceRows = new Set()));
        sourceRows.add(rowId);
      }
    }
    if (sourceTargets.size) bySource.set(sourcePath, sourceTargets);
    revision += 1;
    return true;
  }

  function get(docKey, target, documentId = null) {
    const keys = [targetKey(docKey, target, documentId || "*")];
    return keys.filter(Boolean).flatMap((key) => [...(byTarget.get(key)?.values() || [])])
      .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath) ||
        (left.offset ?? -1) - (right.offset ?? -1));
  }

  function getDocument(docKey, documentId = null) {
    const prefixes = documentId ? [`${docKey}:${documentId}:`, `${docKey}:*:`] : [`${docKey}:`];
    const result = [];
    for (const [key, rows] of byTarget) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) result.push(...rows.values());
    }
    return result.sort(rowSort);
  }

  function getByPdfPath(sourcePath, target = null) {
    const normalizedPath = normalizePdfRoutePath(sourcePath);
    if (!normalizedPath) return [];
    if (target) {
      const key = routeTargetKey(normalizedPath, target);
      return key ? [...(byPdfRoute.get(key)?.values() || [])].sort(rowSort) : [];
    }
    const prefix = `route:${normalizedPath}:`;
    const result = [];
    for (const [key, rows] of byPdfRoute) {
      if (key.startsWith(prefix)) result.push(...rows.values());
    }
    return result.sort(rowSort);
  }

  return Object.freeze({ replaceFile, removeFile, get, getDocument, getByPdfPath,
    get size() { return byTarget.size + byPdfRoute.size; }, get revision() { return revision; } });
}

module.exports = { buildReaderBacklinkPageIndex, createReaderBacklinkIndex, occurrenceKey,
  normalizePdfRoutePath };
