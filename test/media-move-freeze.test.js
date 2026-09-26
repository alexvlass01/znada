'use strict';

// DATA-006 step 3. While the move rewrites every path in the library, nothing may change
// the library underneath it.
//
// The window that explains this is not the protection — a modal cannot stop the tray, a
// hotkey or the second window — so the rule lives at the IPC door in main.js, and this
// suite exercises it there: a real move, running, while every editing channel is called
// for real through the same guarded door a window would use.
//
// The second half is a coverage gate. A future handler that touches the pool and is not
// on the list would be frozen by nothing at all, and no behavioural test would notice,
// because the test would not know the channel exists.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./helpers/main-harness');

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok ${name}`);
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `znada-freeze-${label}-`));
}

// Which handlers change the library, read out of main.js itself rather than from a list
// someone has to remember to update. A block is everything from one `ipcMain.handle(` to
// the next.
function channelsThatMutateThePool() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const marks = [...source.matchAll(/ipcMain\.handle\('([^']+)'/g)];
  const mutating = [];
  for (let i = 0; i < marks.length; i += 1) {
    const channel = marks[i][1];
    const from = marks[i].index;
    // The end of THIS handler, not the start of the next one: a handler registered
    // inside another block (diagnostics does that) would otherwise swallow a page of
    // unrelated code and read as a pool write.
    const nextHandler = i + 1 < marks.length ? marks[i + 1].index : source.length;
    const ends = ['\n});\n', '\n}));\n', '\n}));\r\n', '\n});\r\n']
      .map((mark) => source.indexOf(mark, from))
      .filter((at) => at > 0)
      .map((at) => at + 5);
    const to = Math.min(nextHandler, ...(ends.length ? ends : [nextHandler]));
    const block = source.slice(from, to);
    const touchesPool = /addToPool\(|saveConfig\(\)|dropFromLibraryTrash\(|removeFromLibrary\(|library\.addTag\(|library\.removeTag\(|library\.toggleFavorite\(|config\.libraryTrash =/.test(block);
    if (touchesPool) mutating.push(channel);
  }
  return mutating;
}

// Channels that touch the pool but are deliberately NOT frozen, each with the reason.
// Kept explicit so the next person has to make the same decision on purpose.
const NOT_FROZEN = new Map([
  // Settings, not library content. Writing a setting while the move runs is harmless:
  // the move rewrites paths and placement, and saveConfig here only carries the fields
  // the settings channel is allowed to change (BUG-022).
  ['set-config', 'settings only; the move does not rewrite them'],
  ['set-autostart', 'a Windows login item, nothing to do with the pool'],
  ['set-start-minimized', 'a Windows login item flag'],
  ['set-slideshow', 'slideshow settings, not the records they play'],
  ['set-slideshow-index', 'a position inside a playlist that is not being rewritten'],
  ['cycle-theme-override', 'the theme, saved through the same config file'],
  ['set-hotkey', 'a global shortcut'],
  ['next-wallpaper', 'applies a wallpaper; changes no record'],
  ['apply-now', 'applies a wallpaper; changes no record'],
  ['event-log-clear', 'the event journal, a different file'],
]);

(async () => {
  const userData = H.makeTempProfile('media-move-freeze');
  H.writeJson(path.join(userData, 'config.json'), { monitors: {} });
  const main = H.loadMain(userData);
  main.__test.loadConfig();

  const source = tempDir('src');
  const photo = (name, body) => {
    fs.writeFileSync(path.join(source, name), body);
    return path.join(source, name);
  };
  const added = await main.invoke('library-add-paths', [
    photo('one.png', 'first photo bytes'),
    photo('two.png', 'second photo bytes'),
    photo('three.png', 'third photo bytes'),
  ], '');
  assert.strictEqual(added.added, 3, 'setup: three photos in the library');

  await check('every channel that can change the library is refused while a move runs', async () => {
    const channels = main.__test.libraryEditChannels();
    assert.ok(channels.length >= 20, 'the list must actually cover the editing channels');
    const chosen = tempDir('dest');
    const answers = new Map();
    let asked = false;

    await main.__test.moveManagedFolder(chosen, {
      onProgress: async (state) => {
        // Once, in the middle of the copying, ask every editing channel for real.
        if (asked || state.phase !== 'copying' || !state.done) return;
        asked = true;
        for (const channel of channels) {
          // Arguments do not matter: the refusal happens at the door, before the handler
          // is reached. That IS the property under test.
          answers.set(channel, await main.invoke(channel, [], {}, ''));
        }
      },
    });

    assert.ok(asked, 'the move has to reach the copying phase for this to prove anything');
    for (const channel of channels) {
      const answer = answers.get(channel);
      assert.ok(answer, `${channel} must answer while frozen`);
      assert.strictEqual(answer.error, 'media_move_running', `${channel} must refuse while a move runs`);
    }
    // And nothing got through: the pool still holds exactly the three photos.
    assert.strictEqual(Object.keys(main.__test.getConfig().library).length, 3);
  });

  await check('the same channels work again once the move is over', async () => {
    const again = await main.invoke('library-refresh', null, '');
    assert.notStrictEqual(again.error, 'media_move_running', 'the freeze must end with the move');
    assert.strictEqual(Object.keys(main.__test.getConfig().library).length, 3,
      'and nothing was pruned: every file moved with the library');
  });

  await check('every handler that touches the pool is either frozen or excused by name', () => {
    const frozen = new Set(main.__test.libraryEditChannels());
    const unguarded = channelsThatMutateThePool()
      .filter((channel) => !frozen.has(channel) && !NOT_FROZEN.has(channel));
    assert.deepStrictEqual(unguarded, [],
      `these handlers change the library and nothing freezes them: ${unguarded.join(', ')}`);
  });

  await check('the settings row can say where the files are', () => {
    const state = main.__test.mediaFolderState();
    assert.strictEqual(state.custom, true);
    assert.strictEqual(state.state, 'ready');
    assert.strictEqual(state.moving, false);
    assert.ok(state.root && state.folder, 'both the chosen folder and the one in use are named');
  });

  H.unloadMain();
  console.log(`PASS media-move-freeze: ${checks} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
