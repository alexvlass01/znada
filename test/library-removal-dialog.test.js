'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const H = require('./helpers/main-harness');
const library = require('../src/library');
const { createLibraryRemovalQuestion } = require('../src/library-removal-question');
const Dialog = require('../renderer/library-removal-dialog');

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('  OK ' + name); }
function windowFixture() {
  const win = new EventEmitter();
  win.isDestroyed = () => false;
  win.webContents = new EventEmitter();
  win.webContents.isDestroyed = () => false;
  const sent = [];
  win.webContents.send = (channel, payload) => sent.push({ channel, payload });
  let sequence = 0;
  const broker = createLibraryRemovalQuestion({ getWindow: () => win, nextId: () => 'q' + (++sequence) });
  return { win, sent, broker };
}
function domFixture() {
  const document = new EventEmitter();
  document.addEventListener = document.on.bind(document);
  document.removeEventListener = document.removeListener.bind(document);
  const nodes = [];
  document.createElement = (tag) => {
    const node = new EventEmitter();
    Object.assign(node, {
      tagName: tag, children: [], attributes: {}, isConnected: true, textContent: '',
      append(...children) { this.children.push(...children); },
      setAttribute(key, value) { this.attributes[key] = value; },
      focus() { document.activeElement = this; },
      showModal() { this.open = true; },
      close() { this.open = false; },
      remove() { this.isConnected = false; },
      getBoundingClientRect: () => ({ left: 100, right: 560, top: 100, bottom: 500 }),
    });
    node.addEventListener = node.on.bind(node);
    nodes.push(node);
    return node;
  };
  document.body = document.createElement('body');
  const previous = document.createElement('button');
  previous.focus();
  const replies = [];
  const ui = Dialog.create({ document, reply: (id, yes) => { replies.push({ id, yes }); } });
  const key = (value, shiftKey = false) => {
    const event = { key: value, shiftKey, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    document.emit('keydown', event);
    return event;
  };
  return { document, nodes, previous, ui, replies, key };
}
const question = (count = 1, requestId = 'first') => ({ requestId, count, more: Math.max(0, count - 10),
  names: Array.from({ length: Math.min(count, 10) }, (_, i) => ({ name: 'photo-' + i + '.png', type: 'image' })),
  title: 'Remove', message: 'Remove ' + count + '?', countLabel: 'Items: ' + count,
  detail: 'Recoverable in library trash', cancelLabel: 'Cancel', yesLabel: 'Remove',
});

async function mainFixture(run, options = {}) {
  const dir = H.makeTempProfile('lib019');
  const photo = H.writeImage(path.join(dir, 'photos', 'keep.png'));
  const id = library.idFor(photo);
  H.writeJson(path.join(dir, 'config.json'), { autoSwitch: false, monitors: {} });
  H.writeJson(path.join(dir, 'config.library.json'), { version: 1,
    library: { [id]: { id, path: photo, type: 'image', rev: 1, addedAt: 1 } }, trash: [] });
  const m = H.loadMain(dir, { onLibraryRemovalQuestion: () => false, ...options });
  m.__test.loadConfig();
  try { await run(m, { photo, id }); }
  finally { H.unloadMain(); fs.rmSync(dir, { recursive: true, force: true }); }
}

(async () => {
  console.log('LIB-019: in-app question, IPC ownership and keyboard cancellation');
  await test('only the exact pending request and WebContents can answer', async () => {
    const { broker, win, sent } = windowFixture();
    const result = broker.ask(question());
    const id = sent[0].payload.requestId;
    assert.strictEqual(broker.answer({}, id, true), false);
    assert.strictEqual(broker.answer(win.webContents, 'stale', true), false);
    assert.strictEqual(broker.answer(win.webContents, id, 1), false);
    assert.strictEqual(broker.answer(win.webContents, id, false), true);
    assert.strictEqual(await result, false);
    assert.strictEqual(broker.answer(win.webContents, id, true), false);
    const next = broker.ask(question());
    assert.strictEqual(broker.answer(win.webContents, id, true), false);
    assert.strictEqual(broker.answer(win.webContents, sent[2].payload.requestId, true), true);
    assert.strictEqual(await next, true);
    assert.strictEqual(win.listenerCount('hide'), 0);
    assert.strictEqual(win.webContents.listenerCount('did-start-navigation'), 0);
  });
  for (const event of ['hide', 'closed', 'destroyed', 'render-process-gone', 'did-start-navigation']) {
    await test(event + ' cancels rather than confirming', async () => {
      const { broker, win } = windowFixture();
      const result = broker.ask(question());
      const target = ['hide', 'closed'].includes(event) ? win : win.webContents;
      target.emit(event, {}, 'file:///reload', false, true);
      assert.strictEqual(await result, false);
      assert.strictEqual(target.listenerCount(event), 0);
    });
  }
  await test('subframe/hash navigation and a second request cannot replace the first', async () => {
    const { broker, win, sent } = windowFixture();
    const first = broker.ask(question());
    assert.strictEqual(await broker.ask(question(50)), false);
    win.webContents.emit('did-start-navigation', {}, '', false, false);
    win.webContents.emit('did-start-navigation', {}, '', true, true);
    assert.strictEqual(sent.length, 1);
    broker.answer(win.webContents, sent[0].payload.requestId, true);
    assert.strictEqual(await first, true);
  });
  await test('missing window and failed delivery cancel', async () => {
    const missing = createLibraryRemovalQuestion({ getWindow: () => null, nextId: () => 'x' });
    assert.strictEqual(await missing.ask(question()), false);
    const { broker, win } = windowFixture();
    win.webContents.send = () => { throw new Error('crashed'); };
    assert.strictEqual(await broker.ask(question()), false);
    assert.strictEqual(win.listenerCount('hide'), 0);
  });
  await test('Cancel is initially focused, Tab wraps and Escape restores focus', () => {
    const f = domFixture(); f.ui.show(question(50));
    assert.strictEqual(f.document.activeElement.textContent, 'Cancel');
    assert.strictEqual(f.key('Tab').prevented, true);
    assert.strictEqual(f.document.activeElement.textContent, 'Remove');
    f.key('Tab'); assert.strictEqual(f.document.activeElement.className, 'lib-modal-close');
    f.key('Tab', true); assert.strictEqual(f.document.activeElement.textContent, 'Remove');
    assert.strictEqual(f.key('Escape').stopped, true);
    assert.deepStrictEqual(f.replies, [{ id: 'first', yes: false }]);
    assert.strictEqual(f.document.activeElement, f.previous);
    assert.strictEqual(f.document.listenerCount('keydown'), 0);
  });
  for (const method of ['cancel', 'x', 'backdrop', 'nativeCancel', 'yes', 'dismiss']) {
    await test(method + ' settles only once with the intended result', () => {
      const f = domFixture(); f.ui.show(question());
      const modal = f.nodes.find(n => n.tagName === 'dialog');
      const button = f.nodes.find(n => n.className === (method === 'x' ? 'lib-modal-close' : method === 'yes' ? 'pill danger' : 'pill library-remove-cancel'));
      if (method === 'dismiss') f.ui.dismiss('first');
      else if (method === 'nativeCancel') modal.emit('cancel', { preventDefault() {} });
      else if (method === 'backdrop') modal.emit('click', { target: modal, clientX: 0, clientY: 0 });
      else button.emit('click');
      f.ui.dismiss('first'); button.emit('click');
      assert.deepStrictEqual(f.replies, method === 'dismiss' ? [] : [{ id: 'first', yes: method === 'yes' }]);
      assert.strictEqual(modal.isConnected, false);
    });
  }
  await test('50 names stay bounded; the extra count is outside the list; markup remains text', () => {
    const f = domFixture(); const q = question(50); q.names[0].name = '<img src=x onerror=alert(1)>';
    f.ui.show(q);
    const list = f.nodes.find(n => n.tagName === 'ul');
    assert.strictEqual(list.children.length, 10);
    assert.strictEqual(list.children[0].children[1].textContent, q.names[0].name);
    const more = f.nodes.find(n => n.className === 'library-remove-more');
    assert.strictEqual(more.textContent, '… +40');
    assert.ok(!list.children.includes(more));
    list.focus(); f.key('Enter');
    assert.deepStrictEqual(f.replies, [{ id: 'first', yes: false }]);
  });
  await test('main cancellation preserves the library, files and Undo', () => mainFixture(async (m, { photo, id }) => {
    const before = JSON.stringify(m.__test.getConfig().library);
    const result = await m.invoke('library-remove-many', [{ id, path: photo }], { confirm: true });
    assert.strictEqual(result.cancelled, true); assert.strictEqual(result.undo, null);
    assert.strictEqual(JSON.stringify(m.__test.getConfig().library), before);
    assert.ok(fs.existsSync(photo)); assert.strictEqual(m.calls.dialogs.length, 0);
    assert.strictEqual(m.calls.removalQuestions[0].names[0].name, 'keep.png');
  }));
  await test('main confirmation removes, library trash and Undo still recover the original', () => mainFixture(async (m, { photo, id }) => {
    const result = await m.invoke('library-remove-many', [{ id, path: photo }], { confirm: true });
    assert.strictEqual(result.removed, 1); assert.ok(result.undo);
    assert.ok(!m.__test.getConfig().library[id]); assert.ok(fs.existsSync(photo));
    const restored = await m.invoke('library-undo-remove', result.undo.token);
    assert.strictEqual(restored.error, null); assert.ok(m.__test.getConfig().library[id]);
    assert.strictEqual(m.calls.dialogs.length, 0);
  }, { onLibraryRemovalQuestion: () => true }));
  await test('viewer, unknown sender and child frame cannot answer; correct reply completes removal', () => mainFixture(async (m, { photo, id }) => {
    const removal = m.invoke('library-remove-many', [{ id, path: photo }], { confirm: true });
    const requestId = m.calls.removalQuestions[0].requestId;
    assert.throws(() => m.invokeAs('viewer', 'library-removal-answer', requestId, true), /E_IPC_DENIED/);
    assert.throws(() => m.invokeRaw({ sender: {}, senderFrame: {} }, 'library-removal-answer', requestId, true), /E_IPC_DENIED/);
    assert.throws(() => m.invokeRaw({ sender: m.senders.main.sender, senderFrame: { parent: {}, url: m.senders.main.senderFrame.url } }, 'library-removal-answer', requestId, true), /E_IPC_DENIED/);
    assert.strictEqual(await m.invoke('library-removal-answer', 'stale', true), false);
    assert.ok(m.__test.getConfig().library[id]);
    assert.strictEqual(await m.invoke('library-removal-answer', requestId, true), true);
    assert.strictEqual((await removal).removed, 1);
    assert.strictEqual(await m.invoke('library-removal-answer', requestId, true), false);
  }, { holdRemovalQuestion: true }));
  await test('main hide releases the request and cancels without mutating', () => mainFixture(async (m, { photo, id }) => {
    const removal = m.invoke('library-remove-many', [{ id, path: photo }], { confirm: true });
    m.questionWindow.emit('hide');
    assert.strictEqual((await removal).cancelled, true); assert.ok(m.__test.getConfig().library[id]);
  }, { holdRemovalQuestion: true }));
  await test('main sends 10 basenames and a total of 50, including folder type', () => mainFixture(async (m) => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ path: path.join('C:\\Pictures', 'photo-' + i + '.png'), type: i ? 'image' : 'folder' }));
    await m.invoke('library-remove-many', rows, { confirm: true });
    const q = m.calls.removalQuestions[0];
    assert.strictEqual(q.count, 50); assert.strictEqual(q.more, 40); assert.strictEqual(q.names.length, 10);
    assert.strictEqual(q.names[0].type, 'folder'); assert.ok(!q.names[0].name.includes('Pictures'));
  }));
  console.log('PASS ' + passed + ' LIB-019 checks');
})().catch(error => { console.error(error); process.exitCode = 1; });
