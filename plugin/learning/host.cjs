"use strict";

const { canonicalHash } = require("../vocabulary/canonical.cjs");
const { fromAnnotation, fromContext, fromMarkdown, matchesMarkdownSourceSlice,
  createSemanticSourceResolver } = require("../semantic/semantic-anchor.cjs");
const { createSemanticAnchorContractV1 } = require("../semantic/semantic-contracts.cjs");
const { createLearningService, createLearningDraftModal, createTodayReviewAggregator, LEARNING_ROOT } = require("./workspace.cjs");
const { createMarkdownRouting, normalizeVaultPath, normalizeMarkdownPath, MARKDOWN_ROUTE_ROOT } = require("./markdown-routing.cjs");
const { parseReaderLinkDestination } = require("../reader-anchor-store.cjs");

const unresolved = (reason) => Object.assign(new Error(reason === "save-highlight-before-review"
  ? "请等待批注自动保存并确认后重试（save-highlight-before-review）。"
  : `来源暂不可精确定位：${reason}`), { code: "TARGET_UNRESOLVED" });
const rowsOf = (snapshot) => Array.isArray(snapshot?.annotations)
  ? snapshot.annotations : Object.values(snapshot?.annotations || {});
const movedPath = (path, fromPath, toPath) => path === fromPath ? toPath
  : path.startsWith(`${fromPath}/`) ? `${toPath}${path.slice(fromPath.length)}` : null;
function parseMarkdownReaderLink(sourceText) {
  if (typeof sourceText !== "string") return null;
  const match = /^\[\[([^\]\r\n]+)\]\]$/.exec(sourceText);
  if (!match) return null;
  const pipe = match[1].indexOf("|");
  const destination = (pipe < 0 ? match[1] : match[1].slice(0, pipe)).trim();
  return destination ? parseReaderLinkDestination(destination) : null;
}

// A lazy host facade. It consumes existing verified routes and effective rows;
// it never owns an annotation index, persistence engine, or PDF write path.
function createLearningHost({ plugin, Modal, Notice } = {}) {
  if (!plugin?.app) throw new TypeError("Learning host requires the existing plugin.");
  const DraftModal = createLearningDraftModal({ Modal, Notice });
  let servicePromise = null;
  let routingPromise = null;
  let disposed = false;
  const drafts = new Set();
  const liveView = (anchor) => [...plugin.views].find(view => !view.teardownStarted &&
    view.annotationHydrationAllowed === true && view.annotationSourceMismatch !== true &&
    view.annotationSyncPending !== true && view.annotationStorageUnavailable !== true &&
    view.annotationDocument?.documentId === anchor.documentId &&
    view.annotationDocument?.docKey === anchor.docKey && view.annotationSourceHash === anchor.sourceHash &&
    view.annotationPageIdentity?.orderedPageIdentities?.[anchor.pageIndex] === anchor.pageIdentity);
  const verified = anchor => ({ status: "verified", sourceCurrent: true, pageCurrent: true, anchor });
  const failed = code => ({ status: "unresolved", code, sourceCurrent: false, pageCurrent: false });

  async function routeFor(anchor) {
    const route = await plugin.annotationHost.store.documentForIdentity(anchor);
    if (!route || route.documentId !== anchor.documentId || route.docKey !== anchor.docKey ||
        route.source?.sourceHash !== anchor.sourceHash ||
        route.source?.orderedPageIdentities?.[anchor.pageIndex] !== anchor.pageIdentity ||
        !plugin.app.vault.getAbstractFileByPath(route.sourcePath)) throw unresolved("source-or-page-mismatch");
    return route;
  }

  async function annotationRow(anchor) {
    const view = liveView(anchor);
    if (!view || view.annotationSyncPending || view.annotationStorageUnavailable) return null;
    return rowsOf(view.annotationSnapshot).find(row => row.uuid === anchor.target.id &&
      row.deleted !== true && row.pageIndex === anchor.pageIndex) || null;
  }

  async function markdownValue(anchor, sourcePath = anchor.sourcePath) {
    const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!file || file.path !== sourcePath || !/\.md$/i.test(sourcePath)) return null;
    // An open editor can be newer than disk. Do not confirm a stale excerpt.
    const leaf = plugin.app.workspace.getLeavesOfType?.("markdown")?.find(entry =>
      entry.view?.file?.path === sourcePath && entry.view.editor);
    return leaf ? leaf.view.editor.getValue() : plugin.app.vault.read(file);
  }

  async function getMarkdownRouting() {
    if (!routingPromise) {
      const pending = plugin.getVocabularyRuntime().then((runtime) =>
        createMarkdownRouting({ transaction: runtime.coordinator }));
      routingPromise = pending;
      pending.catch(() => { if (routingPromise === pending) routingPromise = null; });
    }
    return routingPromise;
  }

  async function markdownPathFor(anchor, ownerContext = null) {
    // A caller that supplies routing context has opted into the durable route
    // contract. Never reinterpret malformed or incomplete context as a legacy
    // sourcePath lookup: that could verify a stale canonical path after the
    // binding facts were lost or the item was rebound elsewhere.
    if (ownerContext !== null) {
      if (!ownerContext || typeof ownerContext !== "object" || Array.isArray(ownerContext)) {
        throw unresolved("markdown-owner-context-invalid");
      }
      let route;
      try {
        // resolve() owns validation of ownerKind and ownerId, including their
        // stable-ID constraints. Preserve its fail-closed behavior at the Host
        // boundary as the standard unresolved target result.
        route = await (await getMarkdownRouting()).resolve(ownerContext);
      } catch {
        throw unresolved("markdown-owner-context-invalid");
      }
      if (route.status !== "verified") throw unresolved("markdown-binding-missing");
      return route;
    }
    return { status: "verified", currentPath: anchor?.sourcePath || null, bindingId: null };
  }

  async function markdownSliceIsCurrent(anchor, sourcePath) {
    const text = await markdownValue(anchor, sourcePath);
    return matchesMarkdownSourceSlice({ ...anchor, sourcePath }, text);
  }

  function isMarkdownAnchor(anchor) {
    return anchor?.target?.kind === "markdown" || anchor?.evidenceKind === "markdown" || anchor?.evidenceKind === "backlink";
  }

  async function verifyBacklink(anchor, ownerContext = null) {
    const routed = await markdownPathFor(anchor, ownerContext);
    const sourcePath = routed.currentPath;
    if (!sourcePath || !await markdownSliceIsCurrent(anchor, sourcePath)) return failed("backlink-markdown-span-mismatch");
    const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!file || file.path !== sourcePath || !/\.md$/i.test(sourcePath)) return failed("backlink-markdown-source-missing");
    const range = anchor.sourceRange || {};
    const link = parseMarkdownReaderLink(range.text);
    if (!link?.target || link.target.kind !== anchor.target?.kind || link.target.id !== anchor.target?.id ||
        (link.docKey && link.docKey !== anchor.docKey) ||
        (link.documentId && link.documentId !== anchor.documentId)) return failed("backlink-reader-link-mismatch");
    if (typeof plugin.readerBacklinkSourceEvidence === "function") {
      const row = { sourcePath, target: anchor.target, docKey: anchor.docKey, documentId: anchor.documentId,
        routePath: link.routePath, offset: range.startOffset, endOffset: range.endOffset,
        line: range.line, sourceText: range.text };
      if (!plugin.readerBacklinkSourceEvidence(row, file)) return failed("backlink-route-mismatch");
    }
    return verified(anchor);
  }

  const resolve = createSemanticSourceResolver({
    verifyRouting: async anchor => {
      await routeFor(anchor);
      return liveView(anchor) ? verified(anchor) : failed("source-not-currently-verified");
    },
    verifyAnnotation: async anchor => {
      const row = await annotationRow(anchor);
      if (!row) return failed("annotation-deleted-or-unavailable");
      const currentVersion = fromAnnotation(row)?.annotationVersion || null;
      return canonicalHash(currentVersion) === canonicalHash(anchor.annotationVersion || null)
        ? verified(anchor) : failed("annotation-version-changed");
    },
    verifyReaderAnchor: async anchor => {
      const stored = await plugin.readerAnchorStore.get(anchor.docKey, anchor.target.id, anchor.documentId);
      return liveView(anchor) && stored && stored.sourceHash === anchor.sourceHash && stored.pageIdentity === anchor.pageIdentity
        ? verified(anchor) : failed("selection-anchor-mismatch");
    },
    verifyContext: async anchor => {
      const runtime = await plugin.getVocabularyRuntime();
      const context = await runtime.contexts.getContext(anchor.contextId);
      if (!context || context.anchorId !== anchor.target.id || context.documentId !== anchor.documentId ||
          context.sourceFingerprint !== anchor.sourceHash || context.pageIdentity !== anchor.pageIdentity) {
        return failed("context-source-mismatch");
      }
      const stored = await plugin.readerAnchorStore.get(anchor.docKey, anchor.target.id, anchor.documentId);
      return liveView(anchor) && stored && stored.sourceHash === anchor.sourceHash && stored.pageIdentity === anchor.pageIdentity
        ? verified(anchor) : failed("context-anchor-mismatch");
    },
    verifyBacklink,
    verifyMarkdown: async (anchor, ownerContext) => {
      const routed = await markdownPathFor(anchor, ownerContext);
      return await markdownSliceIsCurrent(anchor, routed.currentPath)
        ? verified(anchor) : failed("markdown-excerpt-changed");
    },
  });

  async function getService() {
    if (!servicePromise) {
      const pending = plugin.getVocabularyRuntime().then(async runtime => {
        await getMarkdownRouting();
        return createLearningService({ runtime, verifySource: resolve });
      });
      servicePromise = pending;
      pending.catch(() => { if (servicePromise === pending) servicePromise = null; });
    }
    return servicePromise;
  }

  async function openDraft(source, guard = async () => true, { markdownFile = null } = {}) {
    if (disposed || plugin.isUnloading) throw unresolved("workspace-closed");
    if (!source?.targetText?.trim()) throw unresolved("target-text-unavailable");
    const service = await getService();
    if (disposed || plugin.isUnloading || !(await guard())) throw unresolved("source-changed-before-draft");
    const sourceGuard = async () => !disposed && !plugin.isUnloading && await guard();
    let confirmedResult = null;
    const checkedService = { ...service, confirmDraft: async (draftId, options = {}) => {
      if (disposed || plugin.isUnloading || !(await guard())) throw Object.assign(new Error("来源已变化，草稿已保留；请重新核对来源。"), { code: "LEARNING_SOURCE_STALE" });
      // A canonical item can commit before its separate Markdown routing facts.
      // Retain that result so the same modal can retry only the route write after
      // a routing failure; the service has already consumed its draft by then.
      const draft = confirmedResult ? null : service.getDraft(draftId);
      const sourceVerifier = async (anchor) => {
        if (anchor?.evidenceKind === "backlink") return resolve(anchor);
        if (isMarkdownAnchor(anchor)) {
          const sourcePath = markdownFile?.path || anchor.sourcePath;
          return await markdownSliceIsCurrent(anchor, sourcePath) ? verified(anchor) : failed("markdown-excerpt-changed");
        }
        return resolve(anchor);
      };
      const result = confirmedResult || await service.confirmDraft(draftId, { ...options, sourceGuard, sourceVerifier });
      if (!confirmedResult && ["committed", "duplicate"].includes(result.status)) confirmedResult = result;
      if (["committed", "duplicate"].includes(result.status) && isMarkdownAnchor(source)) {
        const ownerId = result.item?.itemId || draft?.itemId;
        const sourcePath = markdownFile?.path || source.sourcePath;
        try {
          if (!ownerId || !sourcePath || !await markdownSliceIsCurrent(source, sourcePath)) {
            result.sourceStatus = { status: "TARGET_UNRESOLVED", exact: false, code: "markdown-route-not-current" };
          } else {
            const routing = await getMarkdownRouting();
            const route = await routing.bindCaptured({
              ownerKind: "learning-item", ownerId, currentPath: normalizeVaultPath(sourcePath),
            });
            const currentRoute = await routing.resolve({ ownerKind: "learning-item", ownerId });
            const contract = await resolveContract(source, { ownerKind: "learning-item", ownerId });
            if (currentRoute.status === "verified" && currentRoute.currentPath === normalizeVaultPath(sourcePath) &&
                contract?.status === "VERIFIED" && await markdownSliceIsCurrent(source, sourcePath)) {
              result.sourceStatus = { ...route, currentPath: currentRoute.currentPath,
                bindingId: currentRoute.bindingId, status: "VERIFIED", exact: true };
            } else {
              result.sourceStatus = { status: "TARGET_UNRESOLVED", exact: false, code: "markdown-route-not-current" };
            }
          }
        } catch (error) {
          result.sourceStatus = { status: "TARGET_UNRESOLVED", exact: false,
            code: error?.code || "markdown-route-bind-failed" };
        }
      }
      return result;
    } };
    const modal = new DraftModal(plugin.app, { service: checkedService, source });
    const onClose = modal.onClose?.bind(modal);
    modal.onClose = () => { drafts.delete(modal); onClose?.(); };
    drafts.add(modal);
    modal.open();
    return modal;
  }

  async function fromAnnotationRequest(view, message) {
    const identity = { documentId: view.documentId, openRequest: view.openRequest,
      rendererGeneration: view.rendererGeneration };
    const isCurrent = () => view.isCurrentReaderAnchorIdentity(identity) &&
      message.documentId === identity.documentId && message.openRequest === identity.openRequest &&
      message.rendererGeneration === identity.rendererGeneration &&
      view.annotationHydrationAllowed === true && !view.annotationSourceMismatch &&
      message.sourceHash === view.annotationSourceHash &&
      view.annotationPageIdentity?.orderedPageIdentities?.[message.pageIndex] === message.pageIdentity;
    if (!isCurrent() || typeof message.uuid !== "string" || message.uuid.length > 512 ||
        !Number.isSafeInteger(message.pageIndex) || message.pageIndex < 0 ||
        typeof message.targetText !== "string" || message.targetText.length > 100_000 ||
        !["captured", "stored", "recovered"].includes(message.targetTextSource)) throw unresolved("reader-session-mismatch");
    if (!Number.isSafeInteger(message.revision) || message.revision < 0 ||
        !Number.isSafeInteger(message.confirmedRevision) || message.confirmedRevision < 0 ||
        message.revision !== message.confirmedRevision || message.dirty !== false || message.pending !== false) {
      throw unresolved("save-highlight-before-review");
    }
    const row = rowsOf(view.annotationSnapshot).find(entry => entry.uuid === message.uuid &&
      entry.deleted !== true && entry.kind === "Highlight" && entry.pageIndex === message.pageIndex);
    if (!row) throw unresolved("save-highlight-before-review");
    const before = canonicalHash(row);
    // Stored text wins. Geometry recovery is a display/answer suggestion, not
    // evidence permitting a different source UUID or page to be rebound.
    const source = fromAnnotation({ ...row, targetText: row.payload?.editor?.text || message.targetText,
      targetTextSource: row.payload?.editor?.text ? "stored" : message.targetTextSource }, {
      documentId: view.annotationDocument.documentId, docKey: view.annotationDocument.docKey,
      sourcePath: view.documentFile?.path || view.file?.path, sourceHash: view.annotationSourceHash,
      pageIdentity: message.pageIdentity,
    });
    return openDraft(source, async () => isCurrent() &&
      canonicalHash(await annotationRow(source)) === before);
  }

  async function fromContextId(contextId) {
    const runtime = await plugin.getVocabularyRuntime();
    const context = await runtime.contexts.getContext(contextId);
    if (!context) throw unresolved("context-missing");
    const route = await plugin.annotationHost.store.documentForIdentity(context);
    const source = fromContext(context, { sourcePath: route.sourcePath });
    const expected = canonicalHash(context);
    if (!liveView(source)) await plugin.openVocabularyContext(contextId);
    return openDraft(source, async () => canonicalHash(await runtime.contexts.getContext(contextId)) === expected);
  }

  async function fromMarkdownEditor(editor, view) {
    const start = editor.getCursor("from"), end = editor.getCursor("to");
    const source = fromMarkdown({ sourcePath: view.file?.path, offset: editor.posToOffset(start),
      endOffset: editor.posToOffset(end), line: start.line, text: editor.getSelection() });
    if (!source) throw unresolved("select-markdown-excerpt-first");
    return openDraft(source, async () => {
      const sourcePath = view.file?.path || source.sourcePath;
      return matchesMarkdownSourceSlice({ ...source, sourcePath }, await markdownValue(source, sourcePath));
    }, { markdownFile: view.file });
  }

  async function preparePdfTargetOpen(anchor, ownerContext = null) {
    if (anchor?.evidenceKind === "backlink") {
      const backlink = await verifyBacklink(anchor, ownerContext);
      if (backlink.status !== "verified") {
        throw unresolved(backlink.reason || "backlink-markdown-source-unverified");
      }
    }
    const route = await routeFor(anchor);
    const file = plugin.app.vault.getAbstractFileByPath(route.sourcePath);
    if (!file || file.path !== route.sourcePath) throw unresolved("source-file-missing");
    if (anchor.evidenceKind === "context") {
      const context = await (await plugin.getVocabularyRuntime()).contexts.getContext(anchor.contextId);
      if (!context || context.anchorId !== anchor.target.id || context.sourceFingerprint !== anchor.sourceHash) {
        throw unresolved("context-source-missing-or-changed");
      }
    }
    if (anchor.target.kind === "annotation") {
      const view = liveView(anchor);
      // An open Reader can reject stale/deleted rows immediately. A closed
      // Reader performs its normal single byte-validation and target replay.
      if (view && (view.annotationSyncPending || view.annotationStorageUnavailable ||
          !rowsOf(view.annotationSnapshot).some(row => row.uuid === anchor.target.id &&
            row.deleted !== true && row.pageIndex === anchor.pageIndex))) {
        throw unresolved("annotation-deleted-or-unavailable");
      }
    } else if (anchor.target.kind === "selection") {
      const stored = await plugin.readerAnchorStore.get(anchor.docKey, anchor.target.id, anchor.documentId);
      if (!stored || stored.sourceHash !== anchor.sourceHash || stored.pageIdentity !== anchor.pageIdentity) {
        throw unresolved("selection-anchor-mismatch");
      }
    }
    return { route, file };
  }

  async function openItemSource(itemId) {
    const item = await (await getService()).getItem(itemId);
    if (!item) throw unresolved("learning-item-missing");
    const anchor = item.source;
    if (isMarkdownAnchor(anchor)) {
      const routed = await (await getMarkdownRouting()).resolve({ ownerKind: "learning-item", ownerId: itemId });
      if (routed.status !== "verified") throw unresolved("markdown-binding-missing");
      if (!matchesMarkdownSourceSlice({ ...anchor, sourcePath: routed.currentPath },
        await markdownValue(anchor, routed.currentPath))) throw unresolved("markdown-excerpt-changed");
      const range = anchor.sourceRange || {};
      const link = anchor.evidenceKind === "backlink" ? parseMarkdownReaderLink(range.text) : null;
      const sourceRow = { sourcePath: routed.currentPath,
        ...(link?.target ? { target: anchor.target, docKey: anchor.docKey, documentId: anchor.documentId,
          routePath: link.routePath } : {}),
        offset: range.startOffset, endOffset: range.endOffset, line: range.line, sourceText: range.text };
      const opened = await plugin.openReaderBacklinkSource(sourceRow, { source: "learning-item", requireExact: true });
      if (!opened) throw unresolved('markdown-excerpt-changed-during-open');
      return { status:'opening', message:'已定位到来源摘录。' };
    }
    const { route, file } = await preparePdfTargetOpen(anchor);
    // openPdf/applyPendingReaderTarget performs the current-byte and exact
    // UUID/Selection validation. We do not present an opening request as ACK.
    await plugin.openPdf(file, { ...anchor.target, docKey: anchor.docKey, documentId: anchor.documentId });
    return { status: "opening", message: "已请求打开来源；Reader 将再次验证 PDF 与精确目标。" };
  }

  async function resolveContract(anchor, ownerContext = null, { explicitPageFallback = false } = {}) {
    const resolution = await resolve(anchor, ownerContext);
    let bindingId = null;
    let currentPath = null;
    if (ownerContext && isMarkdownAnchor(anchor)) {
      const route = await (await getMarkdownRouting()).resolve(ownerContext);
      if (route.status === "verified") {
        bindingId = route.bindingId;
        currentPath = route.currentPath;
      }
    }
    return createSemanticAnchorContractV1(anchor, { ownerKind: ownerContext?.ownerKind,
      ownerId: ownerContext?.ownerId, bindingId, currentPath, resolution, explicitPageFallback });
  }

  async function getSourceContract(itemId, { explicitPageFallback = false } = {}) {
    const item = await (await getService()).getItem(itemId);
    if (!item) return null;
    return resolveContract(item.source, { ownerKind: "learning-item", ownerId: itemId }, { explicitPageFallback });
  }

  async function bindMarkdownSource(itemId, currentPath) {
    const item = await (await getService()).getItem(itemId);
    if (!item || !isMarkdownAnchor(item.source)) throw unresolved("markdown-source-unavailable");
    const path = normalizeMarkdownPath(currentPath);
    const anchor = { ...item.source, sourcePath: path };
    if (!await markdownSliceIsCurrent(anchor, path)) throw unresolved("markdown-excerpt-changed");
    if (anchor.evidenceKind === "backlink") {
      const result = await resolve(anchor);
      if (result.status !== "verified" || result.exact !== true) throw unresolved("backlink-route-unverified");
    }
    await (await getMarkdownRouting()).bindManual({
      ownerKind: "learning-item", ownerId: itemId, currentPath: path,
    });
    return resolveContract(anchor, { ownerKind: "learning-item", ownerId: itemId });
  }

  async function openMarkdownSource(anchor, ownerContext = null) {
    const routed = await markdownPathFor(anchor, ownerContext);
    const sourcePath = normalizeMarkdownPath(routed.currentPath);
    if (!await markdownSliceIsCurrent(anchor, sourcePath)) throw unresolved("markdown-excerpt-changed");
    const range = anchor.sourceRange || {};
    const link = anchor.evidenceKind === "backlink" ? parseMarkdownReaderLink(range.text) : null;
    const row = { sourcePath,
      ...(link?.target ? { target: anchor.target, docKey: anchor.docKey, documentId: anchor.documentId,
        routePath: link.routePath } : {}),
      offset: range.startOffset, endOffset: range.endOffset, line: range.line, sourceText: range.text };
    if (typeof plugin.openReaderBacklinkSource !== "function" ||
        !await plugin.openReaderBacklinkSource(row, { source: "backlink", requireExact: true })) {
      throw unresolved("markdown-source-open-failed");
    }
    return { status: "opening", sourcePath };
  }

  async function openPdfTarget(anchor, ownerContext = null) {
    const { route, file } = await preparePdfTargetOpen(anchor, ownerContext);
    await plugin.openPdf(file, { ...anchor.target, docKey: anchor.docKey, documentId: anchor.documentId });
    return { status: "opening", sourcePath: route.sourcePath };
  }

  async function createReviewSession() {
    const runtime = await plugin.getVocabularyRuntime();
    // Match the existing workbench's shared-runtime serialization contract.
    // Do not put an outer exclusive around the aggregator: learning.listDue
    // already enters that runtime and would otherwise self-deadlock.
    const vocabulary = Object.fromEntries(["listDue", "remember", "forget", "skip"].map(method =>
      [method, (...args) => runtime.exclusive(async () => (await runtime.ensureReviewSession())[method](...args))]));
    const learning = await getService();
    return createTodayReviewAggregator({ vocabulary, learning }).openSession();
  }

  async function createWorkbenchReviewPager() {
    let session = await createReviewSession();
    let epoch = 0, index = -1, pageSize = null, page = null, highestIssuedPage = 0;
    let serial = Promise.resolve();
    const enqueue = task => {
      const pending = serial.then(task);
      serial = pending.catch(() => undefined);
      return pending;
    };
    const flatten = row => ({ ...row.item, providerId: row.providerId, itemId: row.itemId, dueAt: row.dueAt,
      ...(row.providerId==='learning'?{reviewState:row.item.state}:{}), });
    const reset = () => { epoch++; index = -1; page = null; pageSize = null; highestIssuedPage = 0; session.invalidate(); };
    return Object.freeze({
      listDue: options => enqueue(async () => {
        const { limit = 100, cursor = null } = options || {};
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Review page size must be 1–100.");
        let requested = 0;
        if (cursor != null) {
          const match = /^learning-review:(\d+):(\d+):(\d+)$/.exec(cursor);
          if (!match || Number(match[1]) !== epoch || Number(match[2]) !== limit ||
              !Number.isSafeInteger(Number(match[3])) || Number(match[3]) > highestIssuedPage) {
            throw new TypeError("Review cursor is invalid or belongs to a previous generation.");
          }
          requested = Number(match[3]);
        }
        if (pageSize !== null && pageSize !== limit) {
          if (cursor != null) throw new TypeError("Review cursor page size changed.");
          reset();
        }
        if (requested < index) {
          // Previous-page navigation reconstructs only bounded provider pages.
          // It does not retain a second, whole-document Review queue.
          session = await createReviewSession(); index = -1; page = null;
        }
        pageSize = limit;
        while (index < requested) {
          const result = await session.nextPage({ limit });
          if (typeof result.hasMore !== "boolean") throw new TypeError("Review provider pagination evidence is missing.");
          page = { items: result.items.map(flatten), hasMore: result.hasMore };
          index++;
          if (index < requested && page.items.length < limit) throw new TypeError("Review cursor is past the available pages.");
        }
        if (page.hasMore) highestIssuedPage = Math.max(highestIssuedPage, index + 1);
        return { items: [...page.items], nextCursor: page.hasMore
          ? `learning-review:${epoch}:${limit}:${index + 1}` : null };
      }),
      rate: input => enqueue(async () => {
        const { providerId = "vocabulary", itemId, familyKey, kind, actionId } = input || {};
        const result = await session.rate(providerId, itemId || familyKey, kind, { actionId });
        reset();
        return result;
      }),
      invalidate: () => enqueue(reset),
    });
  }

  async function openVocabularySource(familyKey) {
    const runtime = await plugin.getVocabularyRuntime();
    const page = await runtime.contexts.listFamily(familyKey, { limit: 2 });
    if (!page.contexts.length) return { status: "missing", message: "这个词族尚未关联来源语境。" };
    if (page.contexts.length === 1 && !page.nextCursor) return plugin.openVocabularyContext(page.contexts[0].contextId);
    // Let the existing paged Context tab be the chooser; no second source UI.
    return { status: "choose-context", familyKey, message: "请选择一个已保存语境作为来源。" };
  }

  async function renamed(fromPath, toPath) {
    if (disposed || typeof fromPath !== "string" || typeof toPath !== "string" || fromPath === toPath) return { status: "noop" };
    const from = normalizeVaultPath(fromPath, "Rename source path");
    const to = normalizeVaultPath(toPath, "Rename destination path");
    const hasLearning = await plugin.app.vault.adapter.exists(`${LEARNING_ROOT}/manifest.json`);
    const hasRouting = await plugin.app.vault.adapter.exists(MARKDOWN_ROUTE_ROOT);
    if (!hasLearning && !hasRouting) return { status: "noop" };
    const routing = await getMarkdownRouting();
    if (!hasLearning && !(await routing.hasRecords())) return { status: "noop" };
    const legacyOwners = [];
    if (hasLearning) {
      const items = await (await getService()).listAllItems();
      for (const item of items) {
        const anchor = item.source;
        if (!isMarkdownAnchor(anchor) || !anchor.sourcePath) continue;
        const destination = movedPath(anchor.sourcePath, from, to);
        if (!destination || !await markdownSliceIsCurrent({ ...anchor, sourcePath: destination }, destination)) continue;
        if (anchor.evidenceKind === "backlink" &&
            (await verifyBacklink({ ...anchor, sourcePath: destination })).status !== "verified") continue;
        legacyOwners.push({ ownerKind: "learning-item", ownerId: item.itemId, sourcePath: anchor.sourcePath });
      }
    }
    return routing.recordRename({ fromPath: from, toPath: to,
      eventProof: { kind: "vault-rename", fromPath: from, toPath: to }, legacyOwners });
  }

  async function endReviewSession() {
    if (!servicePromise) return { status: "noop", writes: 0 };
    return (await servicePromise).endReviewSession();
  }

  function dispose() {
    disposed = true;
    for (const modal of drafts) modal.close();
    drafts.clear();
  }

  return Object.freeze({ getService, getMarkdownRouting, resolveSource: resolve, resolveContract,
    getSourceContract, bindMarkdownSource, fromAnnotationRequest, fromContextId, fromMarkdownEditor,
    openItemSource, openMarkdownSource, openPdfTarget, openVocabularySource, createReviewSession,
    createWorkbenchReviewPager, endReviewSession, renamed, dispose });
}

module.exports = { createLearningHost };
