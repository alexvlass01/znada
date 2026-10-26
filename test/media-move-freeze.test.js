'use strict';

// DATA-006: real move, every declared editing channel refused, normal calls resume.
// CODE-001: effects are reviewed explicitly; changing a discovered source requires
// refreshing its review snapshot. No JavaScript alias/identity inference lives here.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const { mainProcessSources } = require('./helpers/main-process-sources');
const { inventory, assertReviewed } = require('./helpers/main-process-contract');
const approved = require('./fixtures/main-process-contract.json');
const { makeTempDir } = require('./helpers/temp-dir');

let checks = 0;
async function check(name, fn) { await fn(); checks += 1; console.log('  ok ' + name); }
function tempDir(label) { return makeTempDir('znada-freeze-' + label + '-'); }

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

  await check('every declared editing channel is refused while a move runs', async () => {
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
          // Compare during copying: the move itself rewrites paths at commit. A
          // refused call must preserve every record, including tags/revisions; a
          // count alone misses edits and replacements that keep the pool size.
          const before = structuredClone(main.__test.getConfig().library);
          // Arguments do not matter: the refusal happens at the door, before the handler
          // is reached. That IS the property under test.
          answers.set(channel, await main.invoke(channel, [], {}, ''));
          assert.deepStrictEqual(main.__test.getConfig().library, before,
            `${channel} must not change any pool record while frozen`);
        }
      },
    });

    assert.ok(asked, 'the move has to reach the copying phase for this to prove anything');
    for (const channel of channels) {
      const answer = answers.get(channel);
      assert.ok(answer, `${channel} must answer while frozen`);
      assert.strictEqual(answer.error, 'media_move_running', `${channel} must refuse while a move runs`);
    }
    // DATA-009. The two channels whose callers read a shape of their own get it.
    assert.deepStrictEqual(answers.get('card-ensure-record'), { id: '', error: 'media_move_running' },
      'the viewer is told there is no record, and is not handed the config it never holds');
    const lookup = answers.get('item-lookup-metadata');
    assert.ok(lookup, 'the tag lookup must be on the frozen list');
    assert.strictEqual(lookup.status, 'error');
    assert.strictEqual(lookup.reason, 'media_move_running', 'a lookup ending both windows can word');
    assert.strictEqual(lookup.addedTags, 0);
    // A refused assignment reads as not done to a caller that checks `ok` (the viewer did
    // not, and said "Assigned").
    assert.strictEqual(answers.get('library-assign').ok, false);
    // And nothing got through: the pool still holds exactly the three photos.
    assert.strictEqual(Object.keys(main.__test.getConfig().library).length, 3);
  });

  await check('the same channels work again once the move is over', async () => {
    const again = await main.invoke('library-refresh', null, '');
    assert.notStrictEqual(again.error, 'media_move_running', 'the freeze must end with the move');
    assert.strictEqual(Object.keys(main.__test.getConfig().library).length, 3,
      'and nothing was pruned: every file moved with the library');
  });

  // DATA-009. The door only stops a lookup that ARRIVES during a move. One asked for just
  // before it is already past the door, waiting on the network, and writes the tags it
  // finds when the answer comes. Held here at exactly that moment: the lookup is past the
  // door and the move holds the flag and the library before a byte is copied.
  await check('a lookup already past the door does not write while a move runs', async () => {
    const crypto = require('crypto');
    const md5Of = (file) => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
    const library = () => main.__test.getConfig().library;
    const target = Object.values(library())[0];
    const md5 = md5Of(target.path);
    main.__test.setMetadataBudget({ ratePerMinute: 6000, burst: 500, minGapMs: 0 });

    let requests = 0;
    let releaseAnswer;
    const answerHeld = new Promise((resolve) => { releaseAnswer = resolve; });
    let reachedNetwork;
    const atNetwork = new Promise((resolve) => { reachedNetwork = resolve; });
    // One post in a shape both shipped catalogues read (see metadata-file-identity.test.js).
    const post = { id: 4242, md5, tag_string: 'moved_tag', tags: 'moved_tag', rating: 'g' };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      requests += 1;
      const isLookup = requests === 1;
      if (isLookup) { reachedNetwork(); await answerHeld; }
      return { ok: true, status: 200, json: async () => (isLookup ? [post] : []) };
    };

    const mediaMove = require('../src/media-move');
    const realRun = mediaMove.runMove;
    let moveHolding;
    const holding = new Promise((resolve) => { moveHolding = resolve; });
    let letMoveGo;
    const moveGate = new Promise((resolve) => { letMoveGo = resolve; });
    mediaMove.runMove = async (options) => { moveHolding(); await moveGate; return realRun(options); };
    try {
      const pending = main.invoke('item-lookup-metadata', target.id);
      await atNetwork;
      const move = main.__test.moveManagedFolder(tempDir('dest-lookup'));
      await holding;
      assert.strictEqual(main.__test.mediaFolderState().moving, true, 'setup: the move must be running');
      releaseAnswer();
      const reply = await pending;
      const tagged = Object.values(library()).filter((it) => (it.tags || []).includes('moved_tag'));
      letMoveGo();
      const report = await move;
      assert.strictEqual(report.status, 'done', 'setup: the move itself must succeed');

      assert.strictEqual(reply.status, 'error');
      assert.strictEqual(reply.reason, 'media_move_running', 'the window is told why nothing was written');
      assert.deepStrictEqual(tagged, [], 'no tag may be written while the move runs');

      // And the refusal costs the user nothing: the journal kept the answer, so asking
      // again after the move writes the tags without another request.
      const after = Object.values(library()).find((it) => it.type === 'image' && md5Of(it.path) === md5);
      const asked = requests;
      const again = await main.invoke('item-lookup-metadata', after.id);
      assert.strictEqual(again.status, 'found');
      assert.ok(again.addedTags > 0, 'the tags land once the move is over');
      assert.strictEqual(requests, asked, 'from the journal, not a second request');
      assert.ok(library()[after.id].tags.includes('moved_tag'));
    } finally {
      mediaMove.runMove = realRun;
      globalThis.fetch = realFetch;
      letMoveGo();
    }
  });

  await check('every library export has an explicit reviewed category', () => {
    assert.deepStrictEqual(Object.keys(approved.libraryExports).sort(), ['placement', 'pool', 'read']);
    const decided = Object.values(approved.libraryExports).flat().sort();
    assert.deepStrictEqual(Object.keys(require('../src/library')).sort(), decided,
      'decide each added/removed library export explicitly');
  });

  await check('runtime frozen channels exactly match the reviewed effect inventory', () => {
    const expected = Object.entries(approved.channels)
      .filter(([, row]) => ['frozen-pool', 'frozen-placement'].includes(row.effect))
      .map(([channel]) => channel).sort();
    assert.deepStrictEqual([...main.__test.libraryEditChannels()].sort(), expected,
      'review the changed frozen-channel inventory before updating it');
  });

  await check('every discovered source and IPC channel still matches the reviewed snapshot', () => {
    assertReviewed(inventory(mainProcessSources()), approved);
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
