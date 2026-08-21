'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const VirtualGridDom = require('../renderer/virtual-grid-dom');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  ✓ ' + name); passed++; };

class FakeNode {
  constructor(name) {
    this.name = name;
    this.parentNode = null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    const index = siblings.indexOf(this);
    return index >= 0 ? (siblings[index + 1] || null) : null;
  }
}

class FakeParent extends FakeNode {
  constructor(...children) {
    super('parent');
    this.childNodes = [];
    this.insertCalls = 0;
    this.removeCalls = 0;
    children.forEach((child) => this.insertBefore(child, null));
    this.insertCalls = 0;
  }
  get firstChild() { return this.childNodes[0] || null; }
  insertBefore(node, reference) {
    this.insertCalls += 1;
    if (node.parentNode) {
      const old = node.parentNode.childNodes.indexOf(node);
      if (old >= 0) node.parentNode.childNodes.splice(old, 1);
    }
    const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
    assert.ok(index >= 0, 'reference node belongs to parent');
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    assert.ok(index >= 0, 'removed node belongs to parent');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    this.removeCalls += 1;
    return node;
  }
}

const names = (parent) => parent.childNodes.map((node) => node.name).join(',');
const top = new FakeNode('top');
const a = new FakeNode('a');
const b = new FakeNode('b');
const c = new FakeNode('c');
const bottom = new FakeNode('bottom');
const parent = new FakeParent(top, a, b, c, bottom);

const stable = VirtualGridDom.reconcileChildren(parent, [top, a, b, c, bottom]);
ok('an unchanged virtual window performs no DOM insert or move',
  stable.inserted === 0 && stable.moved === 0 && stable.removed === 0 && parent.insertCalls === 0);
ok('an unchanged virtual window preserves every node identity', names(parent) === 'top,a,b,c,bottom');

const d = new FakeNode('d');
const expanded = VirtualGridDom.reconcileChildren(parent, [top, a, b, c, d, bottom]);
ok('expanding the window inserts only the new boundary card',
  expanded.inserted === 1 && expanded.moved === 0 && expanded.removed === 0 && parent.insertCalls === 1);
ok('existing cards stay attached and ordered during expansion', names(parent) === 'top,a,b,c,d,bottom');

const contracted = VirtualGridDom.reconcileChildren(parent, [top, b, c, d, bottom]);
ok('contracting the window removes only the stale boundary card',
  contracted.removed === 1 && contracted.inserted === 0 && contracted.moved === 0 && parent.removeCalls === 1);
ok('overlapping cards are reused after contraction', names(parent) === 'top,b,c,d,bottom');

const reordered = VirtualGridDom.reconcileChildren(parent, [top, c, b, d, bottom]);
ok('a genuine order change moves only the out-of-order node',
  reordered.moved === 1 && reordered.inserted === 0 && reordered.removed === 0);
ok('a genuine order change produces the requested order', names(parent) === 'top,c,b,d,bottom');

const rendererHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const modulePos = rendererHtml.indexOf('<script src="virtual-grid-dom.js"></script>');
const unifiedPos = rendererHtml.indexOf('<script src="unified-grid.js"></script>');
const rendererPos = rendererHtml.indexOf('<script src="renderer.js"></script>');
ok('virtual-grid-dom runtime loads before renderer.js', modulePos >= 0 && rendererPos > modulePos);
ok('unified grid runtime loads after its DOM helper and before renderer.js',
  unifiedPos > modulePos && rendererPos > unifiedPos);
const rendererCss = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
ok('paint override applies to every virtualized Library grid',
  /\.lib-grid\.is-virtualized\s+\.lib-card\s*\{\s*content-visibility:\s*visible/.test(rendererCss));
const unifiedJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'unified-grid.js'), 'utf8');
ok('virtualized paint scope is added and cleared by the shared lifecycle',
  unifiedJs.includes("grid.classList.add('is-virtualized')")
  && unifiedJs.includes("grid.classList.remove('is-virtualized')"));

console.log('\nAll ' + passed + ' virtual-grid DOM tests passed.');
