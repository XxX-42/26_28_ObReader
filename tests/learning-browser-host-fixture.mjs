// Browser fixture: only Obsidian Modal/Workspace and the DataAdapter are replaced.
// Learning Host, drafts, sharded store, coordinator, History and Workbench are real.
import { VocabularyMemoryAdapter } from './vocabulary-v2-memory-adapter.mjs';
import hostModule from '../plugin/learning/host.cjs';
import transactions from '../plugin/vocabulary/transactions.cjs';
import historyModule from '../plugin/vocabulary/history.cjs';
import workbenchModule from '../plugin/vocabulary/workbench.cjs';
import vocabularyModule from '../plugin/vocabulary/service.cjs';
import runtimeModule from '../plugin/vocabulary/runtime.cjs';
import contextSourceModule from '../plugin/vocabulary/context-source.cjs';
import anchorModule from '../plugin/reader-anchor-store.cjs';
import canonical from '../plugin/vocabulary/canonical.cjs';

export function installLearningBrowserHost({ documentId, docKey, rendererGeneration, sourcePath }) {
  Object.assign(HTMLElement.prototype, {
    empty() { this.replaceChildren(); },
    addClass(value) { this.classList.add(...value.split(' ')); },
    createEl(tag, options = {}) {
      const node = document.createElement(tag);
      if (options.text) node.textContent = options.text;
      if (options.cls) node.className = options.cls;
      for (const [name, value] of Object.entries(options.attr || {})) node.setAttribute(name, value);
      this.append(node); return node;
    },
    createDiv(options) { return this.createEl('div', options); },
  });
  class Modal {
    constructor() {
      this.modalEl = document.createElement('section');
      this.modalEl.style.cssText = 'position:fixed;inset:25px;background:white;z-index:10000;overflow:auto;padding:20px';
      this.titleEl = this.modalEl.createEl('h2'); this.contentEl = this.modalEl.createDiv();
    }
    open() { document.body.append(this.modalEl); this.onOpen?.(); }
    close() { this.onClose?.(); this.modalEl.remove(); }
  }
  const adapter = new VocabularyMemoryAdapter({ hook: event => {
    if (/\.pdf$/i.test(event.path || '')) throw Error('PDF source writes forbidden');
  } });
  const coordinator = new transactions.VocabularyTransactionCoordinator({ adapter, deviceId: 'browser-learning', sessionId: 'browser-session' });
  const history = new historyModule.VocabularyHistory({ coordinator });
  let serial = Promise.resolve();
  const runtime = { coordinator, history, exclusive(task) {
    const pending = serial.then(task); serial = pending.catch(() => {}); return pending;
  }, ensureReviewSession: async () => ({ listDue: async () => ({ items: [], nextCursor: null }) }) };
  const opened = [];
  const view = { documentId, openRequest: 1, rendererGeneration, annotationHydrationAllowed: true,
    isCurrentReaderAnchorIdentity: value => value.documentId === documentId && value.openRequest === 1 && value.rendererGeneration === rendererGeneration };
  const route = { documentId, docKey, sourcePath };
  const file = { path: sourcePath, extension: 'pdf' };
  const plugin = { views: new Set([view]), app: { vault: { adapter, getAbstractFileByPath: p => p === sourcePath ? file : null }, workspace: {} },
    getVocabularyRuntime: async () => runtime,
    annotationHost: { store: { documentForIdentity: async () => route } },
    readerAnchorStore: { get: async () => null },
    openPdf: async (file, target) => {
      opened.push({ path: file.path, target });
      window.__readerHostPost({ type: 'reader-anchor-navigate', documentId, openRequest: 1,
        target: { ...target, pageIndex: 0, pageIdentity: route.source.orderedPageIdentities[0] } });
    },
  };
  const host = hostModule.createLearningHost({ plugin, Modal });
  const state = window.__learningBrowser = { adapter, host, opened, errors: [], draft: null, view, route };
  window.addEventListener('message', async event => {
    const message = event.data;
    if (event.source !== document.querySelector('iframe').contentWindow || message?.type !== 'learning-review-draft-request') return;
    try {
      const identity = window.__readerBacklinkE2E.identity;
      route.source = { sourceHash: identity.sourceHash, orderedPageIdentities: identity.orderedPageIdentities };
      Object.assign(view, { annotationSourceHash: identity.sourceHash, annotationDocument: route,
        annotationPageIdentity: identity, documentFile: file,
        annotationSnapshot: window.__browserSidecarHost.snapshotFor(documentId) });
      state.request = message;
      state.draft = await host.fromAnnotationRequest(view, message);
    } catch (error) { state.errors.push(error.stack); }
  });
  state.openReview = async () => {
    const pager = await host.createWorkbenchReviewPager();
    const Workbench = workbenchModule.createVocabularyWorkbench({ Modal });
    state.workbench = new Workbench(plugin.app, { listDueReview: options => pager.listDue(options),
      openReviewSource: item => host.openItemSource(item.itemId) });
    state.workbench.activeTab = 'review'; state.workbench.open();
  };
  // E2E-5 preparation is opt-in: production methods come verbatim from main.js.
  // No initial word, Review state, Context or Anchor is seeded by this fixture.
  state.enableRealVocabulary = async ({ methodSource, fingerprint }) => {
    const methods = new Function('CHANNEL', 'Notice', 'makeToken', 'normalizeVocabularyTermKey',
      'canonicalHash', 'isPdfFile', 'VocabularyEntryModal', methodSource)(
      'pdf-web-reader', class Notice {}, () => crypto.randomUUID(), vocabularyModule.normalizeTermKey,
      canonical.canonicalHash, value => value?.extension === 'pdf', class UnsupportedEntryModal {
        constructor() { throw Error('E2E-5 must use the real LingQ pill status control'); }
      });
    const identity = window.__readerBacklinkE2E.identity;
    route.source = { sourceHash: identity.sourceHash, pageCount: identity.pageCount, orderedPageIdentities: identity.orderedPageIdentities };
    Object.assign(view, methods.view, { plugin, ready: true, openAcknowledged: true,
      iframe: document.querySelector('iframe'), token: window.__readerBacklinkE2E.messages[0]?.token,
      pendingReaderAnchorCaptures: new Map(), pendingVocabularyContextCaptures: new Map(),
      pendingVocabularyEntryLookups: new Map(), pendingVocabularySelections: new Map(),
      annotationSourceHash: identity.sourceHash, annotationDocument: route, annotationPageIdentity: identity,
      annotationSnapshot: window.__browserSidecarHost.snapshotFor(documentId), documentFile: file,
      readerTargetApplySequence: 0, postToViewer: message => { window.__readerHostPost(message); return true; } });
    Object.assign(plugin, methods.plugin, { settings: { vocabularyEnabled: true },
      pdfHashRuntime: { fingerprint },
      readerAnchorStore: anchorModule.createReaderAnchorStore({ adapter, hash: fingerprint, makeId: () => crypto.randomUUID() }),
      getVocabularyDictionary: () => ({ lookup: async () => {
        throw Object.assign(Error('External ECDICT resource is outside this fixture'), { code: 'dictionary-unavailable' });
      } }),
      setVocabularyEnabled: async enabled => { plugin.settings.vocabularyEnabled = enabled;
        window.__readerHostPost({ type: 'vocab-set-enabled', documentId, openRequest: 1, enabled }); },
    });
    const personalService = new vocabularyModule.VocabularyService({ adapter });
    const verifySource = contextSourceModule.createContextSourceVerifier({
      anchorStore: plugin.readerAnchorStore, documentStore: plugin.annotationHost.store,
      getFileByPath: plugin.app.vault.getAbstractFileByPath,
      getVerifiedSource: async () => ({ documentId, docKey, sourcePath, sourceHash: identity.sourceHash,
        orderedPageIdentities: identity.orderedPageIdentities, verified: true }),
      hashOrderedPages: pages => fingerprint(new TextEncoder().encode(JSON.stringify(pages))),
    });
    const vocabularyRuntime = runtimeModule.createVocabularyRuntime({ adapter, personalService,
      deviceId: 'browser-vocabulary', sessionId: 'browser-context', verifySource });
    plugin.getVocabularyService = () => personalService;
    plugin.getVocabularyRuntime = async () => vocabularyRuntime;
    plugin.initializeVocabulary = () => vocabularyRuntime.ready();
    plugin.openPdf = async (file, target) => { opened.push({ path: file.path, target });
      view.pendingReaderTarget = target; return view.applyPendingReaderTarget(); };
    const vocabularyHost = hostModule.createLearningHost({ plugin, Modal });
    Object.assign(state, { vocabularyRuntime, personalService, vocabularyHost });
    window.addEventListener('message', async event => {
      const message = event.data;
      if (event.source !== view.iframe.contentWindow || message?.documentId !== documentId ||
          message.openRequest !== 1 || message.rendererGeneration !== rendererGeneration) return;
      try {
        if (message.type.startsWith('vocab-')) await view.handleVocabularyBridgeMessage(message);
        else if (message.type === 'reader-vocabulary-context-capture-request') {
          view.requestReaderAnchorCapture('quote', null, message.requestId, {
            clientResponseType: 'reader-vocabulary-context-preview',
            contextRequest: { surface: message.expectedSurface, pageNumber: message.pageNumber } });
        } else if (message.type === 'reader-anchor-capture') await plugin.handleReaderAnchorCapture(view, message);
        else if (message.type === 'reader-vocabulary-context-save-request') await plugin.handleReaderVocabularyContextSave(view, message);
      } catch (error) { state.errors.push(error.stack); }
    });
    state.openVocabularyReview = async (activeTab = 'review', familyKey = null) => {
      const pager = await vocabularyHost.createWorkbenchReviewPager();
      const Workbench = workbenchModule.createVocabularyWorkbench({ Modal });
      state.workbench = new Workbench(plugin.app, {
        listFamilies: options => personalService.listFamilies(options),
        getFamilyDetails: async familyKey => ({ family: await personalService.getFamilyByKey(familyKey), dictionary: null }),
        setReviewEnrollment: (keys, { enrolled }) => vocabularyRuntime.exclusive(async () => {
          const review = await vocabularyRuntime.ensureReviewSession();
          const results = [];
          for (const familyKey of keys) results.push({ familyKey, ...await review[enrolled ? 'enroll' : 'unenroll'](familyKey) });
          await review.flush(); return { results };
        }),
        listDueReview: options => pager.listDue(options),
        openReviewSource: item => item.providerId === 'vocabulary'
          ? vocabularyHost.openVocabularySource(item.familyKey) : vocabularyHost.openItemSource(item.itemId),
        listContexts: (familyKey, options) => vocabularyRuntime.contexts.listFamily(familyKey, options),
        openContext: contextId => plugin.openVocabularyContext(contextId),
        addContextToReview: async contextId => { state.contextDraft = await vocabularyHost.fromContextId(contextId); return { status: 'draft' }; },
      });
      state.workbench.activeTab = activeTab; state.workbench.selectedFamilyKey = familyKey; state.workbench.open();
    };
    await vocabularyRuntime.ready();
    await plugin.setVocabularyEnabled(true);
  };
}
