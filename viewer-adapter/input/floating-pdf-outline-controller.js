(() => {
  "use strict";
  class FloatingPdfOutlineController {
    constructor(app, isCurrent) {
      this.app = app; this.document = app.pdfDocument; this.isCurrent = isCurrent;
      this.abort = new AbortController(); this.nodes = []; this.active = null;
      this.expanded = new Set(); this.searchCollapsed = new Set(); this.explicit = false; this.timer = null; this.peekTimer = null; this.disposed = false;
      this.hoverCapable = matchMedia('(hover: hover) and (pointer: fine)').matches;
    }
    current() { return !this.disposed && this.isCurrent() && this.app.pdfDocument === this.document; }
    async start() {
      let outline;
      try { outline = await this.document.getOutline(); } catch { return; }
      if (!this.current() || !Array.isArray(outline) || !outline.length) return;
      const walk = (items, parent = null) => items.map(item => {
        const node = { title: typeof item.title === 'string' ? item.title : '', dest: item.dest, parent, children: [], page: null, order: this.nodes.length };
        this.nodes.push(node); node.children = walk(Array.isArray(item.items) ? item.items : [], node); return node;
      });
      this.roots = walk(outline);
      let next = 0;
      const resolveNode = async node => {
        try {
          let dest = node.dest;
          if (typeof dest === 'string' && dest) dest = await this.document.getDestination(dest);
          if (!this.current() || !Array.isArray(dest) || !dest.length) return;
          const first = dest[0];
          const index = Number.isInteger(first) ? first : await this.document.getPageIndex(first);
          if (this.current() && Number.isInteger(index) && index >= 0 && index < this.document.numPages) node.page = index + 1;
        } catch { /* An invalid destination remains non-navigable. */ }
      };
      await Promise.all(Array.from({ length: Math.min(4, this.nodes.length) }, async () => {
        while (this.current() && next < this.nodes.length) await resolveNode(this.nodes[next++]);
      }));
      if (!this.current() || !this.nodes.some(node => node.page !== null)) return;
      this.mount(); this.updateActive(this.app.pdfViewer?.currentPageNumber || 1, false);
    }
    mount() {
      const signal = this.abort.signal;
      const root = this.root = document.createElement('div'); root.className = 'pdf-reader-floating-outline';
      const rail = this.rail = document.createElement('button'); rail.className = 'pdf-reader-outline-rail'; rail.type = 'button'; rail.textContent = '目录'; rail.setAttribute('aria-expanded', 'false');
      const panel = this.panel = document.createElement('section'); panel.className = 'pdf-reader-outline-panel'; panel.hidden = true; panel.setAttribute('aria-label', 'PDF 目录');
      const search = this.search = document.createElement('input'); search.type = 'search'; search.placeholder = '搜索目录'; search.setAttribute('aria-label', '搜索 PDF 目录');
      const header = document.createElement('div'); header.className = 'pdf-reader-outline-header';
      const pin = this.pin = document.createElement('button'); pin.type = 'button'; pin.className = 'pdf-reader-outline-pin'; pin.textContent = '固定'; pin.setAttribute('aria-pressed', 'false');
      const close = document.createElement('button'); close.type = 'button'; close.className = 'pdf-reader-outline-close'; close.textContent = '×'; close.setAttribute('aria-label', '关闭目录');
      const peek = this.peek = document.createElement('div'); peek.className = 'pdf-reader-outline-peek'; peek.hidden = true;
      const tree = this.tree = document.createElement('div'); tree.className = 'pdf-reader-outline-tree';
      header.append(search, pin, close); panel.append(header, tree); root.append(panel, peek, rail); document.body.append(root);
      rail.addEventListener('click', () => { this.explicit = !this.explicit; this.setOpen(this.explicit); this.syncPin(); }, { signal });
      pin.addEventListener('click', () => { this.explicit = !this.explicit; this.syncPin(); if (!this.explicit) this.setOpen(false); }, { signal });
      close.addEventListener('click', () => { this.explicit = false; this.syncPin(); this.setOpen(false); }, { signal });
      if (this.hoverCapable) {
        root.addEventListener('pointerenter', event => { if (event.pointerType === 'touch') return; clearTimeout(this.timer); this.setOpen(true); }, { signal });
        root.addEventListener('pointerleave', () => { clearTimeout(this.timer); if (!this.explicit) this.timer = setTimeout(() => this.setOpen(false), 250); }, { signal });
      }
      document.addEventListener('pointerdown', event => { if (!root.contains(event.target) && (!this.explicit || event.pointerType === 'touch' || !this.hoverCapable)) { this.explicit = false; this.syncPin(); this.setOpen(false); } }, { signal, capture: true });
      document.addEventListener('keydown', event => { if (event.key === 'Escape' && !this.panel.hidden) { this.explicit = false; this.syncPin(); this.setOpen(false); } }, { signal });
      tree.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        const buttons = [...tree.querySelectorAll('.pdf-reader-outline-title:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement); if (index < 0 || !buttons.length) return;
        event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
      }, { signal });
      search.addEventListener('input', () => { this.searchCollapsed.clear(); this.render(); }, { signal });
      this.onPage = event => { if (this.current() && Number.isInteger(event.pageNumber)) this.updateActive(event.pageNumber); };
      this.app.eventBus._on('pagechanging', this.onPage); this.render();
    }
    syncPin() { this.pin?.setAttribute('aria-pressed', String(this.explicit)); if (this.pin) this.pin.textContent = this.explicit ? '取消固定' : '固定'; }
    setOpen(open) { if (!this.current() || !this.panel) return; this.panel.hidden = !open; this.rail.setAttribute('aria-expanded', String(open)); if (open) { clearTimeout(this.peekTimer); this.peek.hidden = true; this.keepActiveVisible(); } }
    render() {
      if (!this.current() || !this.tree) return;
      const query = this.search.value.normalize('NFKC').toLocaleLowerCase().trim();
      const matched = new Set();
      if (query) for (const node of this.nodes) if (node.title.normalize('NFKC').toLocaleLowerCase().includes(query)) for (let n = node; n; n = n.parent) matched.add(n);
      const fragment = document.createDocumentFragment();
      const renderNode = (node, target, depth) => {
        if (query && !matched.has(node)) return;
        const row = document.createElement('div'); row.className = 'pdf-reader-outline-row'; row.style.setProperty('--outline-depth', depth);
        const expander = document.createElement('button'); expander.type = 'button'; expander.className = 'pdf-reader-outline-expand';
        if (node.children.length) { const open = query ? !this.searchCollapsed.has(node) : this.expanded.has(node); expander.textContent = open ? '▾' : '▸'; expander.setAttribute('aria-label', open ? '折叠' : '展开'); expander.addEventListener('click', () => { const set = query ? this.searchCollapsed : this.expanded; set.has(node) ? set.delete(node) : set.add(node); this.render(); }); }
        else { expander.disabled = true; expander.textContent = ' '; }
        const button = document.createElement('button'); button.type = 'button'; button.className = 'pdf-reader-outline-title'; button.textContent = node.title || '未命名'; button.title = node.title; button.disabled = node.page === null;
        if (node === this.active) button.classList.add('is-active');
        button.addEventListener('click', () => { if (this.current() && node.page !== null) this.app.pdfLinkService.goToDestination(node.dest); });
        node.element = button; row.append(expander, button); target.append(row);
        if (node.children.length && (query ? !this.searchCollapsed.has(node) : this.expanded.has(node))) for (const child of node.children) renderNode(child, target, depth + 1);
      };
      for (const node of this.nodes) node.element = null;
      for (const root of this.roots) renderNode(root, fragment, 0);
      this.tree.replaceChildren(fragment); this.keepActiveVisible();
    }
    updateActive(page, showPeek = true) {
      let best = null; for (const node of this.nodes) if (node.page !== null && node.page <= page && (!best || node.page > best.page || node.page === best.page && node.order > best.order)) best = node;
      if (best === this.active) return;
      this.active?.element?.classList.remove('is-active'); this.active = best; best?.element?.classList.add('is-active'); this.keepActiveVisible();
      if (showPeek && best && this.panel?.hidden && this.peek) { this.peek.textContent = best.title; this.peek.hidden = false; clearTimeout(this.peekTimer); this.peekTimer = setTimeout(() => { if (this.current() && this.peek) this.peek.hidden = true; }, 1600); }
    }
    keepActiveVisible() {
      const element = this.active?.element; if (!element || this.panel.hidden) return;
      const item = element.getBoundingClientRect(), viewport = this.tree.getBoundingClientRect();
      if (item.top < viewport.top || item.bottom > viewport.bottom) element.scrollIntoView({ block: 'nearest' });
    }
    dispose() {
      if (this.disposed) return; this.disposed = true; clearTimeout(this.timer); clearTimeout(this.peekTimer); this.abort.abort();
      if (this.onPage) this.app.eventBus._off('pagechanging', this.onPage);
      this.root?.remove(); this.nodes = []; this.roots = []; this.active = null; this.document = null; this.app = null;
      this.expanded.clear(); this.searchCollapsed.clear();
    }
  }
  window.PdfReaderInputRuntime = Object.assign(window.PdfReaderInputRuntime || {}, { FloatingPdfOutlineController });
})();
