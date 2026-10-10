'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const LibrarySearch = require('../../src/library-search');
const source = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8').replace(/\r\n/g, '\n');

function harness(library = {}) {
  const document = { activeElement: null, handlers: {}, querySelectorAll: () => [],
    addEventListener(event, handler) { this.handlers[event] = handler; } };
  function element(id = '') {
    const classes = new Set();
    return {
      id, dataset: {}, attrs: {}, style: {}, children: [], handlers: {}, parent: null, hidden: false,
      value: '', selectionStart: 0, scrollTop: 0,
      classList: { toggle(key, on) { if (on) classes.add(key); else classes.delete(key); }, contains: (key) => classes.has(key) },
      setAttribute(key, value) { this.attrs[key] = value; },
      set innerHTML(_value) { this.children.forEach((node) => { node.parent = null; }); this.children = []; },
      addEventListener(event, handler) { this.handlers[event] = handler; },
      append(...nodes) { nodes.forEach((node) => this.insertBefore(node, null)); },
      appendChild(node) { this.insertBefore(node, null); },
      insertBefore(node, before) {
        if (node.parent) node.remove();
        const index = before ? this.children.indexOf(before) : this.children.length;
        this.children.splice(index, 0, node); node.parent = this;
      },
      remove() { const parent = this.parent; if (parent) parent.children.splice(parent.children.indexOf(this), 1); this.parent = null; },
      contains(node) { return !!node && (node === this || this.children.some((child) => child.contains(node))); },
      focus() { if (document.activeElement !== this) { document.activeElement = this; this.handlers.focus?.({ target: this }); } },
      setSelectionRange(start) { this.selectionStart = start; },
      getBoundingClientRect: () => ({ top: 10, bottom: 50 }),
      closest(selector) {
        for (let node = this; node; node = node.parent) {
          if (selector.split(',').some((part) => part.trim() === '#' + node.id
            || (part.includes('button') && node.type === 'button' && (part.includes('data-tag') ? node.dataset.tag !== undefined : true))
            || (part === '.lib-toolbar' && node.id === 'toolbar'))) return node;
        }
        return null;
      },
    };
  }
  document.createElement = () => element();
  const nodes = Object.fromEntries(['libTags', 'libTagSection', 'libTagEmpty', 'libTagsPanel', 'libTagHeading',
    'libActiveTags', 'libQueryClear', 'libSearch', 'libQueryBox', 'toolbar'].map((id) => ['#' + id, element(id)]));
  nodes['#toolbar'].append(nodes['#libQueryBox'], nodes['#libTagSection']);
  nodes['#libTagSection'].append(nodes['#libTagsPanel']);
  nodes['#libTagsPanel'].append(nodes['#libTags']);
  const ctx = { LIB: { filter: 'all', q: '', tags: [], tagMenu: '', availableTags: null }, config: { library },
    LibrarySearch, document, $: (id) => nodes[id], t: (key, vars) => key === 'library.photosCount' ? vars.n + ' фото' : key, baseName: (name) => name.split('/').pop(),
    inRemovedView: () => ctx.LIB.filter === 'removed', libOpenSection: () => ctx.LIB.filter,
    closeLibPopup() {}, clearSelection() { ctx.clears++; }, syncSelectionUI() {},
    renders: 0, clears: 0, tops: 0, scrollOpenViewToTop() { ctx.tops++; },
    window: { handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; }, api: { setConfig: async () => {} } },
  };
  vm.createContext(ctx);
  function bind(name) {
    const match = source.match(new RegExp('function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}'));
    if (!match) throw Error('Missing renderer function ' + name);
    vm.runInContext(match[0], ctx);
  }
  ['libTagCounts', 'libSectionItems', 'libQueryItems', 'libMatchesTag', 'libNarrow', 'setLibraryTag', 'openLibraryTagOrTop',
    'renderLibQueryChips', 'positionLibTagPicker', 'renderLibRailTags', 'updateLibAvailableTags',
    'chooseLibTagSuggestion', 'closeLibTagPicker', 'focusLibQuery', 'initLibQueryPicker'].forEach(bind);
  ctx.renderLibrary = () => { ctx.renders++; ctx.renderLibRailTags(); };
  function event(target, extra = {}) {
    return { target, prevented: false, stopped: false, preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; }, ...extra };
  }
  function fire(node, type, extra) { const e = event(node, extra); node.handlers[type](e); return e; }
  return { ctx, nodes, document, bind, element, event, fire };
}

module.exports = { harness };
