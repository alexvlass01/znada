'use strict';

// BUG-068. An IPC reply that carries the config must carry the config as it is when the
// reply is sent. `{ config, id: await work() }` reads `config` BEFORE the await: if
// `set-config` replaces the global object meanwhile, the window is handed the old
// settings and overwrites its fresh state with them.
//
// Two halves:
//   * the real main process through the shared harness: library-materialize waits on
//     fs.stat while set-config runs, and the reply must hold the new setting;
//   * the class: no expression in main.js or src/ reads the config and then awaits
//     inside the same object, array, call or operator, so the next handler written
//     this way fails here instead of in a window.
//
// Run: node test/ipc-reply-config.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const espree = require('espree');
const H = require('./helpers/main-harness');
const L = require('../src/library');

let checks = 0;
async function check(name, fn) {
  await fn(); checks++; console.log(`PASS ${name}`);
}

// ---- the class, statically ----

const ROOT = path.join(__dirname, '..');
const parse = text => espree.parse(text, { ecmaVersion: 'latest', sourceType: 'script', loc: true });

function containsAwait(node) {
  let found = false;
  (function walk(n) {
    if (found || !n || typeof n.type !== 'string') return;
    if (n.type === 'AwaitExpression') { found = true; return; }
    // An await inside a nested function runs later, in its own evaluation.
    if (/Function/.test(n.type)) return;
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(node);
  return found;
}

// `config`, `config.x`, `getConfig()` and `getConfig().x` all read the current object.
function readsConfig(node) {
  let n = node;
  while (n && n.type === 'MemberExpression') n = n.object;
  if (!n) return false;
  if (n.type === 'Identifier') return n.name === 'config';
  return n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'getConfig';
}

function staleReads(source) {
  const hits = [];
  (function walk(n) {
    if (!n || typeof n.type !== 'string') return;
    let parts = null;
    if (n.type === 'ObjectExpression') parts = n.properties.map(p => (p.type === 'SpreadElement' ? p.argument : p.value));
    else if (n.type === 'ArrayExpression') parts = n.elements;
    else if (n.type === 'CallExpression' || n.type === 'NewExpression') parts = n.arguments;
    else if (n.type === 'BinaryExpression' || n.type === 'LogicalExpression') parts = [n.left, n.right];
    if (parts) {
      let read = false;
      for (const part of parts) {
        if (!part) continue;
        if (read && containsAwait(part)) { hits.push(n.loc.start.line); break; }
        if (readsConfig(part)) read = true;
      }
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc') continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(parse(source));
  return hits;
}

(async () => {
  await check('the scanner sees the stale shapes and passes the safe ones', async () => {
    assert.deepStrictEqual(staleReads('async () => ({ config, id: await f() })'), [1]);
    assert.deepStrictEqual(staleReads('async () => ({ cfg: getConfig(), id: await f() })'), [1]);
    assert.deepStrictEqual(staleReads('async () => send(config.theme, await f())'), [1]);
    assert.deepStrictEqual(staleReads('async () => [config, await f()]'), [1]);
    assert.deepStrictEqual(staleReads('async () => { const id = await f(); return { config, id }; }'), []);
    assert.deepStrictEqual(staleReads('async () => ({ id: await f(), config })'), [], 'read after the await is current');
    assert.deepStrictEqual(staleReads('({ config, later: async () => await f() })'), [], 'a nested function awaits later');
  });

  await check('no handler in main.js or src/ reads the config before an await in one expression', async () => {
    const files = ['main.js'].concat(fs.readdirSync(path.join(ROOT, 'src'), { recursive: true })
      .filter(f => String(f).endsWith('.js')).map(f => path.join('src', String(f))));
    const found = [];
    for (const rel of files) {
      for (const line of staleReads(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) found.push(`${rel}:${line}`);
    }
    assert.deepStrictEqual(found, [], 'config read before an await; read it after the await instead');
  });

  // ---- the real main process ----

  await check('library-materialize replies with the config set while it was validating', async () => {
    const dir = H.makeTempProfile('ipc-reply-config');
    const watched = path.join(dir, 'папка с фото');
    const photo = H.writeImage(path.join(watched, 'inside photo.png'));
    const folderId = L.idFor(watched), photoId = L.idFor(photo);
    H.writeJson(path.join(dir, 'config.json'), {
      autoSwitch: false, wallpaperSchedule: { mode: 'off' }, themeSchedule: { mode: 'off' },
      gameModeBlock: false, viewerBackground: 'ambient', monitors: {},
    });
    H.writeJson(path.join(dir, 'config.library.json'), { version: 1, trash: [], library: {
      [folderId]: { id: folderId, type: 'folder', path: watched, addedAt: 1, tags: [] },
    } });
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    const stat = fs.promises.stat;
    let release, started, held = false;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    fs.promises.stat = async (...args) => {
      if (args[0] === photo && !held) { held = true; started(); await gate; }
      return stat(...args);
    };
    try {
      const old = m.__test.getConfig();
      assert.strictEqual(old.viewerBackground, 'ambient');
      const pending = m.invoke('library-materialize', photo, 'image');
      await entered;
      const changed = await m.invoke('set-config', { viewerBackground: 'charcoal' });
      assert.notStrictEqual(changed, old, 'set-config replaces the config object');
      release();
      const reply = await pending;
      assert.strictEqual(reply.id, photoId, 'the photo was materialized');
      assert.strictEqual(reply.config, m.__test.getConfig(), 'the reply carries the current config');
      assert.strictEqual(reply.config.viewerBackground, 'charcoal', 'not the settings from before the await');
      assert.ok(reply.config.library[photoId], 'and it holds the new record');
      const disk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
      assert.strictEqual(disk.viewerBackground, 'charcoal');
      const pool = JSON.parse(fs.readFileSync(path.join(dir, 'config.library.json'), 'utf8'));
      assert.ok(pool.library[photoId], 'the record is saved');
    } finally {
      release(); fs.promises.stat = stat; H.unloadMain();
    }
  });

  console.log(`${checks} ipc-reply-config checks PASS`);
})().catch(err => { console.error(err); process.exitCode = 1; });
