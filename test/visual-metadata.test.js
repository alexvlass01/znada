'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const library = require('../src/library');
const lookup = require('../src/metadata-lookup');
const service = require('../src/metadata-lookup-service');
const CardMetadata = require('../renderer/card-metadata');
const { matchesDeclaration } = require('../src/provider-registry');
const { makeTempDir } = require('./helpers/temp-dir');
const html = require('./fixtures/iqdb-best');
const REMOTE_HASH = 'a'.repeat(32);

// Drive the real shared DOM flow with controllable network completion/image events.
// Reuse the project's small DOM surface; these additions model browser primitives.
function noticeDocument(viewer = false) {
  const { Element } = require('./helpers/content-blur-dom');
  const doc = { elements: [], activeElement: null };
  class Node extends Element {
    constructor(tag) { super(doc, tag); this.hidden = false; this.textContent = ''; }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    remove() {
      this.isConnected = false;
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
    }
    querySelectorAll(selector) {
      return this.children.flatMap(node => [
        ...(selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : node.tagName === selector.toUpperCase()) ? [node] : [],
        ...node.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() { doc.activeElement = this; }
  }
  doc.createElement = tag => new Node(tag);
  doc.body = new Node('body');
  doc.querySelector = selector => doc.body.querySelector(selector);
  doc.getElementById = id => doc.elements.find(node => node.id === id && node.isConnected) || null;
  const root = viewer ? new Node('main') : doc.body;
  if (viewer) { root.id = 'viewerRoot'; doc.body.appendChild(root); }
  const stack = new Node('div'); stack.id = 'notificationStack'; stack.className = 'notification-stack';
  const lookups = new Node('div'); lookups.id = 'lookupNotices'; lookups.className = 'lookup-notices';
  stack.appendChild(lookups);
  const ordinary = new Node('div'); ordinary.className = viewer ? 'media-notice' : 'toast show';
  const undo = new Node('button'); undo.textContent = 'Undo';
  ordinary.appendChild(undo);
  stack.appendChild(ordinary);
  root.appendChild(stack);
  return doc;
}

async function checkVisibleFlow() {
  const oldDocument = global.document;
  try {
    for (const viewer of [false, true]) {
    const doc = global.document = noticeDocument(viewer);
    let ordinary = doc.getElementById('notificationStack').children[1];
    if (viewer) {
      ordinary.remove();
      const source = fs.readFileSync(path.join(__dirname, '../renderer/viewer.js'), 'utf8').replace(/\r\n/g, '\n');
      const functions = ['stopViewerNoticeClock', 'dismissViewerNotice', 'createViewerNotice', 'showViewerAction'].map(name => {
        const match = source.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
        assert.ok(match, name);
        return match[0];
      });
      const context = { document: doc, $: selector => doc.getElementById(selector.slice(1)),
        VIEWER_NOTICE: { element: null, timer: null, deadline: null }, clearTimeout() {}, setTimeout() { return 1; } };
      ordinary = require('node:vm').runInNewContext(functions.join('\n') + '\nshowViewerAction("ordinary", "Undo", () => {}); VIEWER_NOTICE.element;', context);
      assert.equal(ordinary.parentElement, doc.getElementById('notificationStack'), 'real viewer notices join the shared stack');
    }
    let finishExact;
    const exact = new Promise(resolve => { finishExact = resolve; });
    const flow = CardMetadata.run({ id: 'progress', label: 'photo.jpg', t: key => key,
      bridge: { itemLookupMetadata: () => exact } });
    const row = doc.querySelector('.metadata-lookup');
    assert.equal(row.attributes['aria-busy'], 'true');
    assert.equal(row.querySelector('strong'), null, 'no filename/title row');
    assert.ok(row.classList.contains(viewer ? 'media-notice' : 'toast'), 'existing notice appearance');
    assert.equal(row.querySelector('span').textContent, '', 'spinner has no identifying text');
    assert.equal(row.querySelector('button').hidden, true);
    assert.ok(row.querySelector('.metadata-lookup-spinner'));
    finishExact({ status: 'error', reason: 'network' });
    await flow;
    assert.equal(row.attributes['aria-busy'], 'false');
    assert.equal(row.querySelectorAll('span').find(node => node.attributes.role === 'status').textContent, 'card.lookupNetwork');
    assert.equal(row.querySelector('button').hidden, false);
    assert.ok(doc.querySelector('.metadata-lookup'), 'final outcome stays visible until dismissed');
    await row.querySelector('button').click();
    assert.equal(doc.querySelector('.metadata-lookup'), null);
    assert.ok(doc.querySelector('.notification-stack'), 'the shared host survives operation dismissal');
    assert.equal(doc.getElementById('notificationStack').children[1], ordinary, 'dismissing an operation never removes the ordinary notice or Undo');
    assert.equal(ordinary.querySelector('button').textContent, 'Undo');

    for (const [permanentlyBroken, explicitReject] of [[false, false], [true, false], [false, true]]) {
      let decision;
      const pending = CardMetadata.run({ id: 'comparison', t: key => key, bridge: {
        itemLookupMetadata: async () => ({ status: 'absent' }),
        itemLookupVisualMetadata: async () => ({ status: 'candidate', token: 'test',
          original: 'local', thumb: 'large', fallbackThumb: 'small', blur: true }),
        itemConfirmVisualMetadata: async (id, token, accept) => { decision = accept; return { status: 'cancelled', reason: accept === null ? 'dismissed' : '' }; },
      } });
      await new Promise(resolve => { setImmediate(resolve); });
      const dialog = doc.querySelector('.metadata-compare');
      const [local, remote] = dialog.querySelectorAll('img');
      const apply = dialog.querySelector('.metadata-compare-apply');
      if (permanentlyBroken) local.listeners.error[0].fn();
      else local.listeners.load[0].fn();
      remote.listeners.error[0].fn();
      assert.equal(remote.src, 'small', 'large preview errors fall back to the small validated preview');
      remote.listeners.load[0].fn();
      assert.equal(apply.disabled, true, 'blur must be revealed before accepting');
      const reveal = dialog.querySelectorAll('button').find(node => node.textContent === 'card.lookupReveal');
      await reveal.click();
      assert.equal(apply.disabled, permanentlyBroken, 'late load/reveal cannot override a permanent image error');
      if (explicitReject) await dialog.querySelectorAll('button').find(node => node.textContent === 'card.lookupCompareCancel').click();
      else dialog.listeners.cancel[0].fn({ preventDefault() {} });
      await pending;
      assert.equal(decision, explicitReject ? false : null, 'only the explicit button rejects the match');
      assert.equal(doc.body.querySelectorAll('span').filter(node => node.attributes.role === 'status').at(-1).textContent,
        explicitReject ? 'card.lookupCancelled' : 'card.lookupDismissed');
      assert.ok(doc.querySelector('.metadata-lookup-done'), 'cancellation is visible too');
    }
    }
  } finally { global.document = oldDocument; }
}

function setup(options = {}) {
  const provider = options.provider || 'danbooru';
  const page = provider === 'gelbooru' ? 'https://gelbooru.com/index.php?page=post&s=view&id=9999999'
    : 'https://danbooru.donmai.us/posts/9999999';
  const dir = makeTempDir('znada-visual-');
  const photo = path.join(dir, 'photo.png');
  fs.writeFileSync(photo, 'A local image, different bytes from the remote original');
  const config = { library: {}, onlinePurity: { sfw: true }, contentBlur: {} };
  const id = library.addPath(config.library, 'image', photo, { addedAt: 1 });
  const state = { saves: 0, moving: false, authorized: true, uploads: 0, calls: 0 };
  const descriptor = {
    id: provider, status: 'active', hosts: {
      thumb: provider === 'gelbooru' ? [{ pattern: /^img\d*\.gelbooru\.com$/i }] : ['cdn.donmai.us'],
      image: provider === 'gelbooru' ? ['img3.gelbooru.com'] : ['cdn.donmai.us'],
    },
    lookup: async () => {
      state.calls++;
      if (options.onLookup) options.onLookup({ state, config, photo, id });
      if (options.lookupError) return { error: options.lookupError };
      return { item: { id: provider + ':9999999', md5: REMOTE_HASH,
        thumb: provider === 'gelbooru' ? 'https://img3.gelbooru.com/thumbnails/test.jpg' : 'https://cdn.donmai.us/360x360/test.jpg', ...options.remote } };
    },
    findByFingerprint: async (kind, hash, ctx) => {
      assert.equal(kind, 'md5');
      assert.equal(hash, REMOTE_HASH);
      if (options.blockFingerprint) {
        ctx.state.blocked = { reason: 'rate', retryAfterMs: 45000 };
        return { error: options.fingerprintError };
      }
      if (options.fingerprintError) return { error: options.fingerprintError };
      if (options.emptyFingerprint) return { result: null };
      if (options.blockedWithResult) ctx.state.blocked = { reason: 'rate', retryAfterMs: 45000 };
      return { result: {
        postId: '9999999', md5: REMOTE_HASH, page,
        author: 'source artist', rating: 'general', tags: ['sky', 'blue'], ...options.summary,
      } };
    },
  };
  const thumbnail = async () => {
    if (options.onThumbnail) options.onThumbnail({ state, config, photo, id });
    return { mime: 'image/png', width: 360, height: 360, dataBase64: Buffer.from('test thumbnail').toString('base64') };
  };
  const reopen = () => service.create({
    configPath: path.join(dir, 'config.json'), getConfig: () => config,
    library, lookup, registry: { active: () => [descriptor], byId: () => descriptor, matchesDeclaration },
    providers: { credentials: () => null }, userAgent: 'Znada/test',
    isAuthorizedItemPath: () => state.authorized, isMoveRunning: () => state.moving,
    savePoolOnly: () => { state.saves++; }, thumbnail,
  });
  return { svc: reopen(), reopen, state, config, photo, id, dir, html: html.replace('//danbooru.donmai.us/posts/9999999', page) };
}

async function main() {
  const originalFetch = global.fetch;
  let current;
  global.fetch = async (url, init) => {
    assert.equal(url, 'https://iqdb.org/');
    assert.equal(init.body.get('file').name, 'image.png');
    current.state.uploads++;
    return new Response(current.html, { headers: { 'content-type': 'text/html' } });
  };
  try {
    // Explicit rejection survives reload, without resetting the answer's upload TTL.
    const now = Date.now;
    try {
      let clock = now();
      Date.now = () => clock;
      current = setup();
      let svc = current.svc;
      const first = await svc.visualItem(current.id, 7);
      assert.equal((await svc.applyVisual(current.id, first.token, 7, null)).status, 'cancelled');
      svc.flush(); svc.dispose(); svc = current.reopen();
      const second = await svc.visualItem(current.id, 7);
      assert.equal(second.status, 'candidate', 'dismissal permits the same comparison after restart');
      const stale = await svc.visualItem(current.id, 8);
      const before = JSON.stringify(current.config.library);
      clock += 60000; // A later rejection must not extend the original answer's TTL.
      assert.equal((await svc.applyVisual(current.id, second.token, 7, false)).status, 'cancelled');
      assert.equal((await svc.visualItem(current.id, 7)).status, 'absent', 'explicitly rejected cached candidate stays dismissed');
      assert.equal((await svc.applyVisual(current.id, stale.token, 8, true)).reason, 'changed', 'other windows cannot apply an already rejected answer');
      assert.equal(JSON.stringify(current.config.library), before, 'no silent metadata writes');
      svc.flush(); svc.dispose(); svc = current.reopen();
      clock += lookup.RETRY.absentMs - 60000 - 1;
      assert.equal((await svc.visualItem(current.id, 7)).status, 'absent', 'rejection survives restart until original expiry');
      assert.equal(current.state.uploads, 1);
      assert.equal(current.state.calls, 3, 'suppression never fetches catalogue metadata');
      const copy = path.join(current.dir, 'copy.png');
      fs.copyFileSync(current.photo, copy);
      const copyId = library.addPath(current.config.library, 'image', copy, { addedAt: 1 });
      assert.equal((await svc.visualItem(copyId, 8)).status, 'absent', 'same bytes at another path share the rejection');
      assert.equal(current.state.uploads, 1);
      clock++;
      assert.equal((await svc.visualItem(current.id, 7)).status, 'candidate', 'new manual attempt after expiry can query the updated index');
      assert.equal(current.state.uploads, 2);
      assert.equal(current.state.saves, 0);
      svc.dispose();
    } finally { Date.now = now; }
    // Rejection is a durable mutation: the same identity, authority and freeze
    // guards as applying metadata must hold, and another window cannot consume it.
    for (const change of ['file', 'removed', 'authority', 'move', 'expiry']) {
      current = setup();
      const decision = await current.svc.visualItem(current.id, 7);
      assert.equal((await current.svc.applyVisual(current.id, decision.token, 8, false)).reason, 'denied');
      const journal = JSON.stringify(current.svc.cache().lookups);
      if (change === 'file') fs.appendFileSync(current.photo, 'changed');
      if (change === 'removed') library.removeItem(current.config.library, current.id);
      if (change === 'authority') current.state.authorized = false;
      if (change === 'move') current.state.moving = true;
      const realNow = Date.now;
      if (change === 'expiry') { const later = realNow() + 5 * 60000; Date.now = () => later; }
      try {
        assert.equal((await current.svc.applyVisual(current.id, decision.token, 7, false)).status, 'error', change);
        assert.equal(JSON.stringify(current.svc.cache().lookups), journal, 'invalid rejection cannot change journal: ' + change);
        assert.equal(current.state.saves, 0);
        assert.equal((await current.svc.applyVisual(current.id, decision.token, 7, false)).reason, 'denied', 'token consumed once');
      } finally { Date.now = realNow; current.svc.dispose(); }
    }
    // Execute the actual IPC callback: null must survive the main bridge rather
    // than being coerced to the boolean false used by the rejection button.
    const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const handler = mainSource.match(/ipcMain.handle\('item-lookup-metadata', (async \(e, id, options\) => \{[\s\S]*?\n\})\);/);
    assert.ok(handler);
    const confirm = require('node:vm').runInNewContext('(' + handler[1] + ')', {
      metadataService: { applyVisual: (id, token, owner, accept) => ({ id, token, owner, accept }) },
    });
    for (const value of [true, false, null, undefined, 'false', 0]) {
      const reply = await confirm({ sender: { id: 7 } }, 'photo', { action: 'confirm', token: 'token', accept: value });
      assert.equal(reply.accept, typeof value === 'boolean' ? value : null);
      assert.equal(reply.owner, 7);
    }
    await checkVisibleFlow();
    current = setup();
    const { svc, config, state, id } = current;
    library.addTag(config.library, id, 'manual');
    library.updateItem(config.library, id, { author: 'my artist', source: 'https://example.org/my-source' });
    const candidate = await svc.visualItem(id, 7);
    assert.equal(candidate.status, 'candidate');
    assert.ok(candidate.thumb.startsWith('znada-media://'), 'comparison uses the existing bounded media proxy and CSP');
    assert.equal(state.uploads, 1);
    assert.equal(state.saves, 0);
    assert.deepEqual(library.getItem(config.library, id).tags, ['manual']);
    assert.equal((await svc.applyVisual(id, candidate.token, 8, true)).reason, 'denied');
    const applied = await svc.applyVisual(id, candidate.token, 7, true);
    assert.equal(applied.status, 'found');
    assert.equal(applied.addedTags, 2);
    assert.deepEqual(library.getItem(config.library, id).tags, ['manual', 'sky', 'blue']);
    assert.equal(library.getItem(config.library, id).author, 'my artist');
    assert.equal(library.getItem(config.library, id).source, 'https://example.org/my-source');
    assert.equal((await svc.applyVisual(id, candidate.token, 7, true)).reason, 'denied');
    const again = await svc.visualItem(id, 7);
    assert.equal(again.status, 'candidate');
    assert.equal(state.uploads, 1, 'same local bytes do not upload twice');
    assert.equal((await svc.applyVisual(id, again.token, 7, null)).status, 'cancelled');
    assert.equal(state.saves, 1, 'cancel writes nothing');
    svc.flush();
    svc.dispose();
    // A new service instance reads the same derived journal after restart.
    const second = service.create({
      configPath: path.join(current.dir, 'config.json'), getConfig: () => config,
      library, lookup, registry: { active: () => [], byId: () => null }, providers: { credentials: () => null },
      userAgent: 'Znada/test', isAuthorizedItemPath: () => true, isMoveRunning: () => false,
      savePoolOnly: () => {}, thumbnail: async () => ({ mime: 'image/png', width: 360, height: 360, dataBase64: 'eA==' }),
    });
    assert.equal((await second.visualItem(id, 7)).reason, 'unavailable');
    assert.equal(state.uploads, 1, 'restart uses visual journal, not MD5 provider journal');
    second.dispose();

    // The decision's five-minute boundary must prevent writes, including replay.
    const realNow = Date.now;
    try {
      for (const elapsed of [5 * 60000 - 1, 5 * 60000, 5 * 60000 + 1]) {
        let clock = realNow();
        Date.now = () => clock;
        current = setup();
        const decision = await current.svc.visualItem(current.id, 7);
        assert.equal(decision.status, 'candidate');
        clock += elapsed;
        const reply = await current.svc.applyVisual(current.id, decision.token, 7, true);
        assert.equal(reply.status, elapsed < 5 * 60000 ? 'found' : 'error');
        if (elapsed >= 5 * 60000) assert.equal(reply.reason, 'changed');
        assert.equal(current.state.saves, elapsed < 5 * 60000 ? 1 : 0);
        if (elapsed >= 5 * 60000) assert.deepEqual(library.getItem(current.config.library, current.id).tags, []);
        assert.equal((await current.svc.applyVisual(current.id, decision.token, 7, true)).reason, 'denied');
        current.svc.dispose();
      }
    } finally { Date.now = realNow; }

    // Preserve catalogue transport failures at either stage, without another upload
    // or write; absence/malformed identity must remain distinct from transport.
    for (const stage of ['lookupError', 'fingerprintError']) {
      for (const reason of ['network', 'timeout', '503']) {
        current = setup({ [stage]: reason });
        for (let attempt = 0; attempt < 2; attempt++) {
          const reply = await current.svc.visualItem(current.id, 7);
          assert.equal(reply.status, 'error', stage);
          assert.equal(reply.reason, reason, stage);
          assert.equal(CardMetadata.outcomeMessage(reply).key, {
            network: 'card.lookupNetwork', timeout: 'card.lookupTimeout', '503': 'card.lookupHttpError',
          }[reason], 'visible catalogue error caption');
          assert.equal(current.state.saves, 0);
        }
        assert.equal(current.state.uploads, 1, 'catalogue errors reuse the visual candidate');
        current.svc.dispose();
      }
    }
    current = setup({ emptyFingerprint: true });
    assert.equal((await current.svc.visualItem(current.id, 7)).reason, 'mismatch');
    assert.equal(current.state.saves, 0);
    current.svc.dispose();
    current = setup({ blockedWithResult: true });
    assert.equal((await current.svc.visualItem(current.id, 7)).status, 'candidate', 'usable result survives a partial budget refusal');
    assert.equal(current.state.saves, 0);
    current.svc.dispose();

    current = setup({ blockFingerprint: true, fingerprintError: 'timeout' });
    const limited = await current.svc.visualItem(current.id, 7);
    assert.equal(limited.status, 'busy', 'catalogue budget refusal is not an identity mismatch');
    assert.equal(limited.retryAfterMs, 45000);
    assert.equal(current.state.saves, 0);
    assert.equal((await current.svc.visualItem(current.id, 7)).status, 'busy');
    assert.equal(current.state.uploads, 1, 'catalogue retry reuses the visual candidate');
    current.svc.dispose();

    current = setup();
    const successfulFetch = global.fetch;
    global.fetch = async () => { current.state.uploads++; throw new DOMException('timeout', 'TimeoutError'); };
    try {
      assert.equal((await current.svc.visualItem(current.id, 7)).reason, 'timeout');
      assert.equal((await current.svc.visualItem(current.id, 7)).reason, 'errorRecently');
      assert.equal(current.state.uploads, 1, 'a cached error makes no new upload');
      assert.equal(current.state.saves, 0);
    } finally { global.fetch = successfulFetch; current.svc.dispose(); }

    current = setup({ provider: 'gelbooru' });
    const gelbooru = await current.svc.visualItem(current.id, 7);
    assert.equal(gelbooru.status, 'candidate', 'Gelbooru regex-declared thumbnail hosts are supported');
    assert.equal(gelbooru.provider, 'gelbooru');
    assert.equal((await current.svc.applyVisual(current.id, gelbooru.token, 7, true)).status, 'found');
    current.svc.dispose();

    for (const [label, options, reason] of [
      ['remote ID', { remote: { id: 'danbooru:42' } }, 'unavailable'],
      ['full metadata ID', { summary: { postId: '42' } }, 'mismatch'],
      ['full metadata hash', { summary: { md5: 'b'.repeat(32) } }, 'mismatch'],
      ['foreign thumbnail host', { remote: { thumb: 'https://evil.invalid/test.jpg' } }, 'thumbnail'],
      ['file changed during request', { onLookup: ({ photo }) => fs.appendFileSync(photo, 'changed') }, 'changed'],
      ['removed during request', { onLookup: ({ config, id }) => library.removeItem(config.library, id) }, 'changed'],
      ['move during request', { onLookup: ({ state }) => { state.moving = true; } }, 'media_move_running'],
      ['authority revoked', { onLookup: ({ state }) => { state.authorized = false; } }, 'changed'],
      ['move before upload', { onThumbnail: ({ state }) => { state.moving = true; } }, 'media_move_running'],
    ]) {
      current = setup(options);
      const result = await current.svc.visualItem(current.id, 7);
      assert.equal(result.reason, reason, label);
      assert.equal(current.state.saves, 0, label);
      if (label === 'move before upload') assert.equal(current.state.uploads, 0);
      current.svc.dispose();
    }
    for (const rating of ['general', 'sensitive', 'explicit', '']) {
      current = setup({ summary: { rating } });
      current.config.onlinePurity = { sfw: false, sketchy: false, nsfw: false };
      current.config.contentBlur = { nsfw: true, sketchy: true };
      const result = await current.svc.visualItem(current.id, 7);
      assert.equal(result.status, 'candidate', 'Online admission does not hide a local match: ' + rating);
      if (rating === 'explicit') assert.equal(result.blur, true, 'independent content blur remains effective');
      assert.equal(current.state.saves, 0);
      assert.equal((await current.svc.applyVisual(current.id, result.token, 7, true)).status, 'found');
      current.svc.dispose();
    }
    for (const [remote, expected] of [
      [{ sample: 'https://cdn.donmai.us/sample/test.jpg', full: 'https://cdn.donmai.us/original/test.jpg' }, '/sample/'],
      [{ full: 'https://cdn.donmai.us/original/test.jpg' }, '/original/'],
      [{ sample: 'https://evil.invalid/sample.jpg', full: 'https://cdn.donmai.us/original/test.jpg' }, '/original/'],
      [{ sample: 'https://user@cdn.donmai.us/sample.jpg', full: 'http://cdn.donmai.us/original.jpg' }, '/360x360/'],
    ]) {
      current = setup({ remote });
      const result = await current.svc.visualItem(current.id, 7);
      assert.equal(result.status, 'candidate');
      assert.ok(decodeURIComponent(result.thumb).includes(expected), 'safe best preview: ' + expected);
      assert.ok(decodeURIComponent(result.fallbackThumb).includes('/360x360/'));
      current.svc.dispose();
    }
    for (const change of [
      ({ state }) => { state.moving = true; },
      ({ state }) => { state.authorized = false; },
      ({ photo }) => fs.appendFileSync(photo, 'changed while comparing'),
      ({ config, id }) => library.removeItem(config.library, id),
    ]) {
      current = setup();
      const result = await current.svc.visualItem(current.id, 7);
      assert.equal(result.status, 'candidate');
      change(current);
      assert.equal((await current.svc.applyVisual(current.id, result.token, 7, true)).status, 'error');
      assert.equal(current.state.saves, 0);
      current.svc.dispose();
    }

    for (const accept of [false, true]) {
      const calls = [];
      const response = await CardMetadata.run({
        id: 'test', notify: () => {}, confirmCandidate: async () => accept,
        bridge: {
          itemLookupMetadata: async () => { calls.push('md5'); return { status: 'absent' }; },
          itemLookupVisualMetadata: async () => { calls.push('visual'); return { status: 'candidate', token: 'opaque' }; },
          itemConfirmVisualMetadata: async (id, token, confirmed) => {
            assert.equal(id, 'test'); assert.equal(token, 'opaque'); assert.equal(confirmed, accept);
            calls.push('decision'); return { status: confirmed ? 'found' : 'cancelled', addedTags: confirmed ? 2 : 0 };
          },
        },
      });
      assert.deepEqual(calls, ['md5', 'visual', 'decision']);
      assert.equal(response.status, accept ? 'found' : 'cancelled');
    }
    for (const status of ['error', 'busy', 'found']) {
      let visualCalls = 0;
      await CardMetadata.run({ id: 'test', bridge: {
        itemLookupMetadata: async () => ({ status }),
        itemLookupVisualMetadata: async () => { visualCalls++; },
      } });
      assert.equal(visualCalls, 0, 'only a definite MD5 miss uploads');
    }
    console.log('Visual metadata: confirmation, journal/reload, identity, authority, freeze, source ID/hash and renderer flow PASS');
  } finally { global.fetch = originalFetch; }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
