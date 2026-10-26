'use strict';

// ONL-002 stage 4. The real renderer functions behind the mockup the owner accepted,
// run on a tiny fake DOM: what the line
// under the account name says, when the red dot shows, which row the popover gets,
// the retry button, the held count and the one-time message.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8').replace(/\r\n/g, '\n');
function code(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, name); return match[0];
}

function element(tag = 'div') {
  const classes = new Set();
  return {
    tag, children: [], hidden: false, disabled: false, textContent: '', innerHTML: '', listeners: {},
    set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    get className() { return [...classes].join(' '); },
    classList: { toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); }, contains: (name) => classes.has(name) },
    append(...nodes) { this.children.push(...nodes); },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute() {},
  };
}
const text = (node) => [node.textContent, ...node.children.map(text)].join(' ').trim();

const nodes = { '#libAccountName': element(), '#libAccountStatus': element('small'), '#libAccountAvatar': element(), '#libAccountToggle': element() };
const toasts = [];
let renders = 0, retries = 0;
const context = {
  $: (selector) => nodes[selector],
  document: { createElement: element },
  t: (key, params) => key + (params ? JSON.stringify(params) : ''),
  toast: (message) => toasts.push(message),
  renderCloudAccount: () => { renders += 1; },
  window: { api: { bookmarkSyncRetry: async () => { retries += 1; return { state: 'ok', held: 0 }; } } },
  CLOUDAUTH: { state: { signedIn: true, user: { id: 'u', display_name: 'Test User' } } },
};
vm.createContext(context);
vm.runInContext(['const BOOKMARK_SYNC = { state: \'off\', held: 0 };', 'globalThis.BOOKMARK_SYNC = BOOKMARK_SYNC;',
  code('accountInitials'), code('paintAccountAvatar'), code('renderLibraryAccountTrigger'),
  code('bookmarkSyncCaption'), code('bookmarkSyncRows'), code('applyBookmarkSync')].join('\n'), context);
const run = (expr) => vm.runInContext(expr, context);
const caption = () => (nodes['#libAccountStatus'].hidden ? '' : nodes['#libAccountStatus'].textContent);
const dot = () => nodes['#libAccountToggle'].classList.contains('sync-error');

(async () => {
  // Off (signed out or no server): nothing anywhere.
  run('renderLibraryAccountTrigger()');
  assert.equal(caption(), '');
  assert.equal(run('bookmarkSyncRows().length'), 0);

  // The six accepted states.
  const expect = {
    ok: { caption: '', dot: false, row: 'online.syncOk' },
    syncing: { caption: 'online.syncingCaption', dot: false, row: 'online.syncing' },
    offline: { caption: 'online.syncOfflineCaption', dot: false, row: 'online.syncOffline' },
    error: { caption: 'online.syncErrorCaption', dot: true, row: 'online.syncError' },
    paused: { caption: '', dot: false, row: 'online.syncPaused' },
  };
  for (const [state, want] of Object.entries(expect)) {
    run(`applyBookmarkSync({ state: '${state}', held: 0 })`);
    run('renderLibraryAccountTrigger()');
    assert.equal(caption(), want.caption, `${state}: line under the name`);
    assert.equal(dot(), want.dot, `${state}: red dot`);
    const rows = run('bookmarkSyncRows()');
    assert.ok(text(rows[0]).includes(want.row), `${state}: popover row`);
    assert.equal(rows.some((r) => r.textContent === 'online.syncRetry'), state === 'error', `${state}: retry only on error`);
  }

  // Retry calls main and applies its answer.
  run(`applyBookmarkSync({ state: 'error', held: 0 })`);
  const retry = run('bookmarkSyncRows()').find((r) => r.textContent === 'online.syncRetry');
  await retry.listeners.click();
  assert.equal(retries, 1);
  assert.equal(run('BOOKMARK_SYNC.state'), 'ok');

  // Held links: a counted row while they exist; the message only when main hands a notice.
  run(`applyBookmarkSync({ state: 'ok', held: 37, notice: 37 })`);
  assert.deepEqual(toasts, ['online.syncHeldToast{"n":37}']);
  assert.ok(run('bookmarkSyncRows()').some((r) => text(r).includes('online.syncHeld{"n":37}')));
  run(`applyBookmarkSync({ state: 'ok', held: 37 })`);
  assert.equal(toasts.length, 1, 'no second message without a new notice');

  // A signed-out window shows no sync line even if a stale state arrives.
  context.CLOUDAUTH.state = { signedIn: false };
  run(`applyBookmarkSync({ state: 'error', held: 0 })`);
  run('renderLibraryAccountTrigger()');
  assert.equal(caption(), '');
  assert.equal(dot(), false);
  // Garbage from the bridge is ignored.
  run('applyBookmarkSync(null); applyBookmarkSync({ held: 3 })');
  assert.equal(run('BOOKMARK_SYNC.state'), 'error');
  assert.ok(renders > 0, 'every change repaints the account popover');
  console.log('bookmark-sync-ui: caption, dot, popover rows, retry, held notice PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
