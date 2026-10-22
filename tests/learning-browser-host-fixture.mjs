// Browser fixture: only Obsidian Modal/Workspace and the DataAdapter are replaced.
// Learning Host, drafts, sharded store, coordinator, History and Workbench are real.
import { VocabularyMemoryAdapter } from './vocabulary-v2-memory-adapter.mjs';
import hostModule from '../plugin/learning/host.cjs';
import transactions from '../plugin/vocabulary/transactions.cjs';
import historyModule from '../plugin/vocabulary/history.cjs';
import workbenchModule from '../plugin/vocabulary/workbench.cjs';

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
}
