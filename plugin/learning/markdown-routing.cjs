"use strict";

const { canonicalStringify, hashText } = require("../vocabulary/canonical.cjs");

const MARKDOWN_ROUTE_ROOT = "00_Archive/21_VocabularyData/routing/markdown";
const MARKDOWN_OWNER_ROOT = `${MARKDOWN_ROUTE_ROOT}/owners`;
const MARKDOWN_BINDING_ROOT = `${MARKDOWN_ROUTE_ROOT}/bindings`;
const MARKDOWN_ROUTE_STORE_ID = "markdown-source-routing-v1";
const OWNER_FACT_KIND = "markdown-owner-binding-fact";
const BINDING_FACT_KIND = "markdown-binding-route-fact";

function routeError(code, message, details) {
  const error = new Error(message);
  error.name = "MarkdownRoutingError";
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function safeText(value, name, { max = 256, allow = /^[^\\/\u0000-\u001f\u007f]+$/ } = {}) {
  if (typeof value !== "string" || !value || value.length > max || !allow.test(value)) {
    throw routeError("MARKDOWN_ROUTE_ID_INVALID", `A stable ${name} is required.`);
  }
  return value;
}

function normalizeVaultPath(value, name = "Markdown path") {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.startsWith("\\") ||
      /[\u0000-\u001f\u007f#?]/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    throw routeError("MARKDOWN_ROUTE_PATH_INVALID", `${name} must be a safe vault-relative path.`);
  }
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw routeError("MARKDOWN_ROUTE_PATH_INVALID", `${name} must be a safe vault-relative path.`);
  }
  return parts.join("/");
}

function normalizeMarkdownPath(value, name = "Markdown path") {
  const path = normalizeVaultPath(value, name);
  if (!/\.md$/i.test(path)) throw routeError("MARKDOWN_ROUTE_PATH_INVALID", `${name} must identify a Markdown file.`);
  return path;
}

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function ownerKey(ownerKind, ownerId) { return `${ownerKind}\u0000${ownerId}`; }
function digest(value) { return hashText(value).slice("sha256-v1:".length); }
function ownerHash(ownerKind, ownerId) { return digest(`${ownerKind}\u0000${ownerId}`); }
function ownerDirectory(ownerKind, ownerId) {
  const hash = ownerHash(ownerKind, ownerId);
  return `${MARKDOWN_OWNER_ROOT}/${hash.slice(0, 2)}/${hash}`;
}
function bindingHash(bindingId) { return digest(bindingId); }
function bindingDirectory(bindingId) {
  const hash = bindingHash(bindingId);
  return `${MARKDOWN_BINDING_ROOT}/${hash.slice(0, 2)}/${hash}`;
}
function bindingIdFor(actorId, ownerKind, ownerId, currentPath) {
  return `markdown-binding-v1:${digest(`${actorId}\u0000${ownerKind}\u0000${ownerId}\u0000${currentPath}`)}`;
}
function factIdFor(fact) {
  const { factId: _factId, revision: _revision, ...identity } = fact;
  return digest(canonicalStringify(identity));
}
function filePathFor(fact) {
  const directory = fact.kind === OWNER_FACT_KIND
    ? ownerDirectory(fact.ownerKind, fact.ownerId)
    : bindingDirectory(fact.bindingId);
  return `${directory}/${fact.factId}.json`;
}

function validateOwnerKind(value) {
  return safeText(value, "owner kind", { max: 80, allow: /^[A-Za-z][A-Za-z0-9._-]*$/ });
}

function makeFact(kind, fields) {
  const fact = { schemaVersion: 1, kind, revision: 1, ...fields };
  fact.factId = factIdFor(fact);
  return fact;
}

function validateFact(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 ||
      ![OWNER_FACT_KIND, BINDING_FACT_KIND].includes(value.kind) || value.revision !== 1 ||
      typeof value.factId !== "string" || !/^[a-f0-9]{64}$/.test(value.factId) ||
      typeof value.actorId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.actorId) ||
      !Array.isArray(value.parentFactIds) || value.parentFactIds.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) ||
      value.parentFactIds.some((id, index) => index > 0 && compareText(value.parentFactIds[index - 1], id) >= 0)) {
    throw routeError("MARKDOWN_ROUTE_FACT_INVALID", "A Markdown routing fact is malformed.");
  }
  if (canonicalStringify(value) !== path.text || factIdFor(value) !== value.factId || filePathFor(value) !== path.path) {
    throw routeError("MARKDOWN_ROUTE_FACT_IDENTITY_MISMATCH", "A Markdown routing fact failed its content-addressed path check.");
  }
  if (value.kind === OWNER_FACT_KIND) {
    const ownerKind = validateOwnerKind(value.ownerKind);
    const ownerId = safeText(value.ownerId, "owner ID");
    safeText(value.bindingId, "binding ID");
    if (!new Set(["bind", "rebind"]).has(value.operation) ||
        (value.operation === "bind" && value.parentFactIds.length !== 0) ||
        (value.operation === "rebind" && value.parentFactIds.length === 0) ||
        ownerHash(ownerKind, ownerId) !== path.path.split("/").at(-2)) {
      throw routeError("MARKDOWN_ROUTE_FACT_INVALID", "A Markdown owner binding fact failed validation.");
    }
  } else {
    const bindingId = safeText(value.bindingId, "binding ID");
    const currentPath = normalizeMarkdownPath(value.currentPath);
    if (!new Set(["bind", "move"]).has(value.operation) ||
        (value.operation === "bind" && value.parentFactIds.length !== 0) ||
        (value.operation === "move" && value.parentFactIds.length === 0) ||
        (value.operation === "bind" && value.fromPath !== null) ||
        (value.operation === "move" && normalizeMarkdownPath(value.fromPath, "Rename source path") === currentPath) ||
        bindingHash(bindingId) !== path.path.split("/").at(-2)) {
      throw routeError("MARKDOWN_ROUTE_FACT_INVALID", "A Markdown binding route fact failed validation.");
    }
  }
  return value;
}

function resolveFactHeads(facts, stateFor, { validateMove = null } = {}) {
  if (!facts.length) return { status: "unresolved", code: "TARGET_UNRESOLVED", reason: "binding-facts-missing", heads: [] };
  const byId = new Map(facts.map((fact) => [fact.factId, fact]));
  const superseded = new Set();
  for (const fact of facts) {
    for (const parentId of fact.parentFactIds) {
      const parent = byId.get(parentId);
      if (!parent) return { status: "unresolved", code: "TARGET_UNRESOLVED", reason: "binding-parent-missing", heads: [] };
      if (fact.kind !== parent.kind ||
          (fact.kind === BINDING_FACT_KIND && fact.bindingId !== parent.bindingId)) {
        return { status: "unresolved", code: "TARGET_UNRESOLVED", reason: "binding-parent-mismatch", heads: [] };
      }
      const error = validateMove?.(fact, parent);
      if (error) return { status: "unresolved", code: "TARGET_UNRESOLVED", reason: error, heads: [] };
      superseded.add(parentId);
    }
  }
  const heads = facts.filter((fact) => !superseded.has(fact.factId));
  if (!heads.length) return { status: "unresolved", code: "TARGET_UNRESOLVED", reason: "binding-head-missing", heads: [] };
  const states = new Map(heads.map((fact) => [canonicalStringify(stateFor(fact)), stateFor(fact)]));
  if (states.size !== 1) return { status: "unresolved", code: "TARGET_UNRESOLVED", reason: "binding-route-conflict", heads };
  return { status: "verified", code: null, ...[...states.values()][0], heads };
}

function createMarkdownRouting({ transaction } = {}) {
  if (!transaction || typeof transaction.readSnapshot !== "function" || typeof transaction.commit !== "function" ||
      !transaction.adapter || typeof transaction.adapter.list !== "function") {
    throw new TypeError("Markdown routing requires the existing coordinator and DataAdapter.list().");
  }
  const adapter = transaction.adapter;
  const actorId = safeText(transaction.deviceId, "routing device ID", { max: 128, allow: /^[A-Za-z0-9_-]+$/ });

  async function readFact(path) {
    const snapshot = await transaction.readSnapshot(path);
    if (!snapshot.exists) return null;
    return validateFact(snapshot.value, { path, text: snapshot.text });
  }

  async function listFacts(directory, kind) {
    if (!(await adapter.exists(directory))) return [];
    const listing = await adapter.list(directory);
    if (!Array.isArray(listing.files) || !Array.isArray(listing.folders) || listing.folders.length) {
      throw routeError("MARKDOWN_ROUTE_LIST_INVALID", `The DataAdapter returned an invalid listing for ${directory}.`);
    }
    const facts = [];
    for (const path of listing.files.slice().sort(compareText)) {
      if (!path.startsWith(`${directory}/`) || path.slice(directory.length + 1).includes("/") || !path.endsWith(".json")) {
        throw routeError("MARKDOWN_ROUTE_LIST_INVALID", `The DataAdapter returned an unexpected Markdown route entry under ${directory}.`);
      }
      const fact = await readFact(path);
      if (!fact || fact.kind !== kind) throw routeError("MARKDOWN_ROUTE_FACT_MISSING", `A listed Markdown route fact is missing or malformed at ${path}.`);
      facts.push(fact);
    }
    return facts;
  }

  async function listOwnerFacts(ownerKind, ownerId) {
    return listFacts(ownerDirectory(ownerKind, ownerId), OWNER_FACT_KIND);
  }

  async function listBindingFacts(bindingId) {
    return listFacts(bindingDirectory(bindingId), BINDING_FACT_KIND);
  }

  async function listIdentityDirectories(root) {
    if (!(await adapter.exists(root))) return [];
    const buckets = await adapter.list(root);
    if (!Array.isArray(buckets.files) || !Array.isArray(buckets.folders) || buckets.files.length) {
      throw routeError("MARKDOWN_ROUTE_LIST_INVALID", `The DataAdapter returned an invalid directory listing for ${root}.`);
    }
    const directories = [];
    for (const bucket of buckets.folders.slice().sort(compareText)) {
      if (!bucket.startsWith(`${root}/`) || bucket.slice(root.length + 1).includes("/") ||
          !/^[a-f0-9]{2}$/.test(bucket.slice(root.length + 1))) {
        throw routeError("MARKDOWN_ROUTE_LIST_INVALID", `The DataAdapter returned an unexpected directory under ${root}.`);
      }
      const listing = await adapter.list(bucket);
      if (!Array.isArray(listing.files) || !Array.isArray(listing.folders) || listing.files.length) {
        throw routeError("MARKDOWN_ROUTE_LIST_INVALID", `The DataAdapter returned an invalid bucket listing for ${bucket}.`);
      }
      for (const directory of listing.folders.slice().sort(compareText)) {
        if (!directory.startsWith(`${bucket}/`) || directory.slice(bucket.length + 1).includes("/") ||
            !/^[a-f0-9]{64}$/.test(directory.slice(bucket.length + 1)) ||
            directory.slice(bucket.length + 1, bucket.length + 3) !== bucket.slice(root.length + 1)) {
          throw routeError("MARKDOWN_ROUTE_LIST_INVALID", `The DataAdapter returned an unexpected identity directory under ${bucket}.`);
        }
        directories.push(directory);
      }
    }
    return directories;
  }

  async function listAllBindingFacts() {
    const directories = await listIdentityDirectories(MARKDOWN_BINDING_ROOT);
    const facts = [];
    for (const directory of directories) facts.push(...await listFacts(directory, BINDING_FACT_KIND));
    return facts;
  }

  async function listAllOwnerFacts() {
    const directories = await listIdentityDirectories(MARKDOWN_OWNER_ROOT);
    const facts = [];
    for (const directory of directories) facts.push(...await listFacts(directory, OWNER_FACT_KIND));
    return facts;
  }

  function resolveOwnerFacts(ownerKind, ownerId, facts) {
    for (const fact of facts) {
      if (fact.ownerKind !== ownerKind || fact.ownerId !== ownerId) {
        return { status: "unresolved", code: "TARGET_UNRESOLVED", reason: "owner-fact-identity-mismatch", heads: [] };
      }
    }
    return resolveFactHeads(facts, (fact) => ({ bindingId: fact.bindingId }));
  }

  async function resolveBinding(bindingId) {
    const facts = await listBindingFacts(bindingId);
    return resolveFactHeads(facts, (fact) => ({ bindingId: fact.bindingId, currentPath: fact.currentPath }), {
      validateMove: (fact, parent) => fact.operation === "move" && parent.currentPath !== fact.fromPath
        ? "binding-move-parent-path-mismatch" : null,
    });
  }

  async function resolve(ownerKindOrInput, maybeOwnerId) {
    const input = typeof ownerKindOrInput === "object" && ownerKindOrInput !== null
      ? ownerKindOrInput : { ownerKind: ownerKindOrInput, ownerId: maybeOwnerId };
    const ownerKind = validateOwnerKind(input.ownerKind);
    const ownerId = safeText(input.ownerId, "owner ID");
    const ownerFacts = await listOwnerFacts(ownerKind, ownerId);
    if (!ownerFacts.length) return { status: "unresolved", code: "TARGET_UNRESOLVED", reason: "owner-binding-missing",
      ownerKind, ownerId, bindingId: null, currentPath: null };
    const owner = resolveOwnerFacts(ownerKind, ownerId, ownerFacts);
    if (owner.status !== "verified") return { ...owner, ownerKind, ownerId, bindingId: null, currentPath: null };
    const bindingId = owner.bindingId;
    const binding = await resolveBinding(bindingId);
    if (binding.status !== "verified") return { ...binding, ownerKind, ownerId, bindingId, currentPath: null };
    const allBindingFacts = await listAllBindingFacts();
    const bindingIds = [...new Set(allBindingFacts.map((fact) => fact.bindingId))];
    for (const otherId of bindingIds) {
      if (otherId === bindingId) continue;
      const other = await resolveBinding(otherId);
      if (other.status !== "verified") {
        return { status: "unresolved", code: "TARGET_UNRESOLVED", reason: other.reason || "other-binding-unresolved",
          ownerKind, ownerId, bindingId, currentPath: null };
      }
      if (other.currentPath === binding.currentPath) {
        return { status: "unresolved", code: "TARGET_UNRESOLVED", reason: "path-binding-conflict",
          ownerKind, ownerId, bindingId, currentPath: null };
      }
    }
    return { status: "verified", code: null, ownerKind, ownerId, bindingId, currentPath: binding.currentPath,
      ownerFactIds: owner.heads.map((fact) => fact.factId), bindingFactIds: binding.heads.map((fact) => fact.factId) };
  }

  async function allBindingRoutes() {
    const facts = await listAllBindingFacts();
    const ids = [...new Set(facts.map((fact) => fact.bindingId))].sort(compareText);
    const routes = [];
    for (const bindingId of ids) routes.push({ bindingId, ...(await resolveBinding(bindingId)) });
    return routes;
  }

  async function commitFacts(facts, actionSeed) {
    const writes = [];
    for (const fact of facts) {
      const path = filePathFor(fact);
      const current = await transaction.readSnapshot(path);
      const text = canonicalStringify(fact);
      if (current.exists) {
        if (current.text === text && current.value?.factId === fact.factId) continue;
        throw routeError("MARKDOWN_ROUTE_FACT_COLLISION", "A content-addressed Markdown routing fact path contains different data.");
      }
      writes.push({ path, storeId: MARKDOWN_ROUTE_STORE_ID, expectedRevision: 0, expectedHash: null, text });
    }
    if (!writes.length) return { status: "duplicate", writes: 0 };
    const actionId = `markdown-route:${digest(`${actorId}\u0000${actionSeed}\u0000${writes.map((write) => write.path).sort(compareText).join("\u0000")}`)}`;
    const result = await transaction.commit({ actionId, historySummary: null, writes });
    if (result.status === "conflict") return { status: "conflict", result, writes: 0 };
    if (result.status !== "committed") throw routeError("MARKDOWN_ROUTE_COMMIT_FAILED", "Markdown route facts could not be committed.", result);
    return { status: "committed", writes: writes.length };
  }

  function ownerFact(ownerKind, ownerId, bindingId, parentFactIds = []) {
    const parents = [...parentFactIds].sort(compareText);
    return makeFact(OWNER_FACT_KIND, { actorId, operation: parents.length ? "rebind" : "bind",
      ownerKind, ownerId, bindingId, parentFactIds: parents });
  }

  function bindingFact(bindingId, currentPath, { fromPath = null, parentFactIds = [] } = {}) {
    const parents = [...parentFactIds].sort(compareText);
    return makeFact(BINDING_FACT_KIND, { actorId, operation: parents.length ? "move" : "bind", bindingId,
      fromPath: parents.length ? fromPath : null, currentPath, parentFactIds: parents });
  }

  async function bind(input = {}, { manual = false, maxAttempts = 3 } = {}) {
    const ownerKind = validateOwnerKind(input.ownerKind);
    const ownerId = safeText(input.ownerId, "owner ID");
    const currentPath = normalizeMarkdownPath(input.currentPath);
    const requestedBindingId = input.bindingId == null ? null : safeText(input.bindingId, "binding ID");
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const ownerFacts = await listOwnerFacts(ownerKind, ownerId);
      const owner = ownerFacts.length ? resolveOwnerFacts(ownerKind, ownerId, ownerFacts) : null;
      if (owner?.status === "verified") {
        const binding = await resolveBinding(owner.bindingId);
        if (binding.status === "verified" && binding.currentPath === currentPath) {
          return { status: "duplicate", ownerKind, ownerId, bindingId: owner.bindingId, currentPath, writes: 0 };
        }
        if (!manual) throw routeError("MARKDOWN_ROUTE_OWNER_CONFLICT", "This owner already has a different Markdown route.");
        if (binding.status !== "verified") {
          throw routeError("MARKDOWN_ROUTE_BINDING_UNRESOLVED", "The existing Markdown route cannot be manually moved while its history is incomplete.");
        }
      } else if (ownerFacts.length) {
        throw routeError("MARKDOWN_ROUTE_OWNER_UNRESOLVED", "The existing Markdown owner binding is ambiguous and cannot be overwritten.");
      }

      const routes = await allBindingRoutes();
      if (routes.some((route) => route.status !== "verified")) {
        throw routeError("MARKDOWN_ROUTE_BINDING_UNRESOLVED", "Existing Markdown route facts are incomplete or conflicting.");
      }
      const existingAtPath = routes.filter((route) => route.status === "verified" && route.currentPath === currentPath);
      const distinct = [...new Set(existingAtPath.map((route) => route.bindingId))];
      if (distinct.length > 1) throw routeError("MARKDOWN_ROUTE_PATH_CONFLICT", "The Markdown path is already associated with different bindings.");
      if (requestedBindingId && distinct.length === 1 && requestedBindingId !== distinct[0]) {
        throw routeError("MARKDOWN_ROUTE_PATH_CONFLICT", "The Markdown path is already associated with a different binding.");
      }
      for (const route of routes) {
        if (route.status !== "verified" && route.heads?.some((fact) => fact.currentPath === currentPath)) {
          throw routeError("MARKDOWN_ROUTE_PATH_CONFLICT", "An unresolved Markdown binding may already own this path.");
        }
      }
      const selectedBindingId = (manual && owner?.status === "verified"
        ? requestedBindingId || distinct[0] || owner.bindingId : null) ||
        requestedBindingId || distinct[0] || bindingIdFor(actorId, ownerKind, ownerId, currentPath);
      const bindingFacts = await listBindingFacts(selectedBindingId);
      const binding = bindingFacts.length ? resolveFactHeads(bindingFacts,
        (fact) => ({ bindingId: fact.bindingId, currentPath: fact.currentPath }), {
          validateMove: (fact, parent) => fact.operation === "move" && parent.currentPath !== fact.fromPath
            ? "binding-move-parent-path-mismatch" : null,
        }) : null;
      const facts = [];
      if (binding?.status === "verified") {
        if (binding.currentPath !== currentPath) {
          if (!manual) throw routeError("MARKDOWN_ROUTE_BINDING_CONFLICT", "The Markdown binding already points to another path.");
          facts.push(bindingFact(selectedBindingId, currentPath, { fromPath: binding.currentPath,
            parentFactIds: binding.heads.map((fact) => fact.factId) }));
        }
      } else if (!bindingFacts.length) {
        facts.push(bindingFact(selectedBindingId, currentPath));
      } else {
        throw routeError("MARKDOWN_ROUTE_BINDING_UNRESOLVED", "The Markdown route facts are incomplete or conflicting.");
      }
      if (!ownerFacts.length) facts.push(ownerFact(ownerKind, ownerId, selectedBindingId));
      else if (owner?.bindingId !== selectedBindingId) facts.push(ownerFact(ownerKind, ownerId, selectedBindingId,
        owner.heads.map((fact) => fact.factId)));
      const result = await commitFacts(facts, `bind:${ownerKind}:${ownerId}:${selectedBindingId}:${currentPath}`);
      if (result.status === "committed" || result.status === "duplicate") {
        return { status: result.status === "duplicate" ? "duplicate" : "bound", ownerKind, ownerId,
          bindingId: selectedBindingId, currentPath, writes: result.writes, explicitManual: manual };
      }
      const concurrent = await resolve({ ownerKind, ownerId });
      if (concurrent.status === "verified" && concurrent.currentPath === currentPath) {
        return { status: "duplicate", ...concurrent, writes: 0 };
      }
    }
    throw routeError("MARKDOWN_ROUTE_CONFLICT", "Markdown routing changed concurrently; no route was overwritten.");
  }

  function movedPath(path, fromPath, toPath) {
    if (path === fromPath) return toPath;
    const prefix = `${fromPath}/`;
    return path.startsWith(prefix) ? `${toPath}${path.slice(fromPath.length)}` : null;
  }

  async function recordRename(input = {}, { maxAttempts = 3 } = {}) {
    const fromPath = normalizeVaultPath(input.fromPath, "Rename source path");
    const toPath = normalizeVaultPath(input.toPath, "Rename destination path");
    if (fromPath === toPath) return { status: "unchanged", movedBindings: 0, boundOwners: 0, writes: 0 };
    if (toPath.startsWith(`${fromPath}/`)) throw routeError("MARKDOWN_ROUTE_MOVE_INVALID", "A folder cannot be moved inside itself.");
    const legacyOwners = (input.legacyOwners || []).map((owner) => ({
      ownerKind: validateOwnerKind(owner.ownerKind),
      ownerId: safeText(owner.ownerId, "owner ID"),
      sourcePath: normalizeVaultPath(owner.sourcePath, "Legacy source path"),
    })).filter((owner) => movedPath(owner.sourcePath, fromPath, toPath));
    const proof = input.eventProof;
    if (legacyOwners.length && (!proof || proof.kind !== "vault-rename" ||
        normalizeVaultPath(proof.fromPath, "Rename proof source") !== fromPath ||
        normalizeVaultPath(proof.toPath, "Rename proof destination") !== toPath)) {
      throw routeError("MARKDOWN_ROUTE_EVENT_PROOF_REQUIRED", "Legacy Markdown sources can be bound only from a matching observed rename event.");
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const routes = await allBindingRoutes();
      if (routes.some((route) => route.status !== "verified")) {
        throw routeError("MARKDOWN_ROUTE_BINDING_UNRESOLVED", "Existing Markdown route facts are incomplete or conflicting.");
      }
      const moving = routes.filter((route) => route.status === "verified" && movedPath(route.currentPath, fromPath, toPath));
      const movingIds = new Set(moving.map((route) => route.bindingId));
      const targetPaths = new Set(moving.map((route) => movedPath(route.currentPath, fromPath, toPath)));
      for (const route of routes) {
        if (route.status === "verified" && !movingIds.has(route.bindingId) && targetPaths.has(route.currentPath)) {
          throw routeError("MARKDOWN_ROUTE_PATH_CONFLICT", "The renamed Markdown destination already belongs to another binding.");
        }
      }

      const ownerFacts = await listAllOwnerFacts();
      const ownerKeys = new Set(ownerFacts.map((fact) => ownerKey(fact.ownerKind, fact.ownerId)));
      const bindingByOldPath = new Map(moving.map((route) => [route.currentPath, route.bindingId]));
      const bindingByNewPath = new Map(moving.map((route) => [movedPath(route.currentPath, fromPath, toPath), route.bindingId]));
      const facts = [];
      for (const route of moving) {
        facts.push(bindingFact(route.bindingId, movedPath(route.currentPath, fromPath, toPath), {
          fromPath: route.currentPath, parentFactIds: route.heads.map((fact) => fact.factId),
        }));
      }

      const newLegacyRoutes = new Map();
      const allBindingFacts = await listAllBindingFacts();
      const existingOwnerState = new Map();
      for (const legacy of legacyOwners) {
        const key = ownerKey(legacy.ownerKind, legacy.ownerId);
        if (ownerKeys.has(key)) {
          if (!existingOwnerState.has(key)) existingOwnerState.set(key, await resolve(legacy.ownerKind, legacy.ownerId));
          continue;
        }
        const destination = movedPath(legacy.sourcePath, fromPath, toPath);
        let selectedBindingId = bindingByOldPath.get(legacy.sourcePath) || bindingByNewPath.get(destination) || newLegacyRoutes.get(legacy.sourcePath);
        if (!selectedBindingId) {
          const retired = allBindingFacts.some((fact) => fact.operation === "move" &&
            (fact.fromPath === legacy.sourcePath || fact.fromPath.startsWith(`${legacy.sourcePath}/`)));
          if (retired) continue;
          selectedBindingId = `markdown-binding-v1:${digest(`${actorId}\u0000vault-rename\u0000${legacy.sourcePath}\u0000${destination}`)}`;
          const bindingFacts = await listBindingFacts(selectedBindingId);
          if (!bindingFacts.length) facts.push(bindingFact(selectedBindingId, destination));
          else {
            const existing = resolveFactHeads(bindingFacts, (fact) => ({ bindingId: fact.bindingId, currentPath: fact.currentPath }), {
              validateMove: (fact, parent) => fact.operation === "move" && parent.currentPath !== fact.fromPath
                ? "binding-move-parent-path-mismatch" : null,
            });
            if (existing.status !== "verified" || existing.currentPath !== destination) continue;
          }
          newLegacyRoutes.set(legacy.sourcePath, selectedBindingId);
        }
        facts.push(ownerFact(legacy.ownerKind, legacy.ownerId, selectedBindingId));
      }
      for (const [key, state] of existingOwnerState) {
        if (state.status !== "verified") continue;
        const legacy = legacyOwners.find((entry) => ownerKey(entry.ownerKind, entry.ownerId) === key);
        const expected = legacy && movedPath(legacy.sourcePath, fromPath, toPath);
        if (expected && state.currentPath !== expected && !movingIds.has(state.bindingId)) {
          // Existing route facts are authoritative; a rename event cannot move
          // a legacy owner whose binding points elsewhere.
          continue;
        }
      }

      const uniqueFacts = new Map(facts.map((fact) => [fact.factId, fact]));
      if (!uniqueFacts.size) return { status: "unchanged", movedBindings: 0, boundOwners: 0, writes: 0 };
      const result = await commitFacts([...uniqueFacts.values()], `rename:${fromPath}:${toPath}`);
      if (result.status === "committed" || result.status === "duplicate") {
        return { status: result.status, fromPath, toPath, movedBindings: moving.length,
          boundOwners: [...uniqueFacts.values()].filter((fact) => fact.kind === OWNER_FACT_KIND).length,
          writes: result.writes };
      }
      const after = await allBindingRoutes();
      const stillMoving = after.some((route) => route.status === "verified" && movedPath(route.currentPath, fromPath, toPath));
      const stillLegacy = await Promise.all(legacyOwners.map((owner) => resolve(owner.ownerKind, owner.ownerId)))
        .then((owners) => owners.some((owner) => owner.status !== "verified"));
      if (!stillMoving && !stillLegacy) return { status: "duplicate", fromPath, toPath, movedBindings: 0, boundOwners: 0, writes: 0 };
    }
    throw routeError("MARKDOWN_ROUTE_CONFLICT", "Markdown routing changed concurrently; no route was overwritten.");
  }

  return Object.freeze({
    root: MARKDOWN_ROUTE_ROOT,
    ownersRoot: MARKDOWN_OWNER_ROOT,
    bindingsRoot: MARKDOWN_BINDING_ROOT,
    resolve,
    bindCaptured(input) { return bind(input, { manual: false }); },
    bindManual(input) { return bind(input, { manual: true }); },
    recordRename,
    async hasRecords() {
      return (await adapter.exists(MARKDOWN_OWNER_ROOT)) || (await adapter.exists(MARKDOWN_BINDING_ROOT));
    },
    async listBindings() {
      return allBindingRoutes();
    },
    async listOwners() {
      const facts = await listAllOwnerFacts();
      const keys = [...new Set(facts.map((fact) => ownerKey(fact.ownerKind, fact.ownerId)))].sort(compareText);
      const owners = [];
      for (const key of keys) {
        const [ownerKind, ownerId] = key.split("\u0000");
        owners.push(await resolve(ownerKind, ownerId));
      }
      return owners;
    },
  });
}

module.exports = { MARKDOWN_ROUTE_ROOT, MARKDOWN_OWNER_ROOT, MARKDOWN_BINDING_ROOT,
  MARKDOWN_ROUTE_STORE_ID, OWNER_FACT_KIND, BINDING_FACT_KIND, createMarkdownRouting, normalizeVaultPath, normalizeMarkdownPath };
