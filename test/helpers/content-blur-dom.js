'use strict';

// Minimal DOM surface consumed by the real controller, with capture before the
// original card action. No controller behavior is reimplemented here.
class Element {
  constructor(doc, tag = 'div') {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.dataset = {};
    this.children = []; this.listeners = {}; this.className = ''; this.attributes = {};
    this.isConnected = true;
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
      remove: name => { this.className = this.className.split(/\s+/).filter(n => n !== name).join(' '); },
      toggle: (name, on) => {
        this.className = this.className.split(/\s+/).filter(n => n && n !== name).join(' ');
        if (on) this.className += ' ' + name;
      },
    };
    doc.elements.push(this);
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || ''; }
  appendChild(el) { this.children.push(el); el.parentElement = this; }
  querySelector(selector) {
    const name = selector.replace(':scope > ', '').replace(/^\./, '');
    return this.children.find(el => el.classList.contains(name)) || null;
  }
  addEventListener(name, fn, capture) {
    (this.listeners[name] ||= []).push({ fn, capture: !!capture });
  }
  closest(selector) {
    const matches = selector.split(',').some(part => {
      const s = part.trim();
      return s.startsWith('.') ? this.classList.contains(s.slice(1))
        : s.startsWith('[') ? false : s.toUpperCase() === this.tagName;
    });
    return matches ? this : this.parentElement ? this.parentElement.closest(selector) : null;
  }
  async click(extra = {}) {
    let stopped = false;
    const event = { target: this, preventDefault() {}, stopImmediatePropagation() { stopped = true; }, ...extra };
    const listeners = [...(this.listeners.click || [])].sort((a, b) => Number(b.capture) - Number(a.capture));
    for (const { fn } of listeners) { if (stopped) break; await fn(event); }
    return stopped;
  }
}
function document() {
  return { elements: [], createElement(tag) { return new Element(this, tag); },
    querySelectorAll() { return this.elements.filter(el => el.isConnected && el.dataset.contentBlurHost); },
    getElementById(id) { return this.elements.find(el => el.id === id) || null; } };
}
module.exports = { Element, document };
