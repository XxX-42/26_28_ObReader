"use strict";

function requireOperations(name, input, operations) {
  if (!input || typeof input !== "object") throw new TypeError(`${name} requires delegated operations.`);
  for (const operation of operations) {
    if (typeof input[operation] !== "function") throw new TypeError(`${name}.${operation} must be a function.`);
  }
  return Object.freeze(Object.fromEntries(operations.map((operation) => [operation,
    (...args) => input[operation](...args)])));
}

// These facades add no cache or persistence. Each call delegates directly to
// the existing effective-row, Reader, or backlink implementation supplied by
// the host integration.
function createAnnotationSidebarService(operations) {
  return requireOperations("AnnotationSidebarService", operations,
    ["list", "get", "navigate", "createReviewDraft"]);
}

function createBacklinkService(operations) {
  return requireOperations("BacklinkService", operations,
    ["resolve", "openPdfTarget", "openMarkdownSource", "listSources"]);
}

module.exports = { createAnnotationSidebarService, createBacklinkService };
