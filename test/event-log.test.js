'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEventLog } = require('../src/event-log');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  OK ' + name); passed++; };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-event-log-'));
  const file = path.join(dir, 'event-log.json');
  let nowMs = 1000;

  const log = createEventLog({ filePath: file, cap: 5, now: () => nowMs });
  ok('missing file starts as an empty journal', log.list().length === 0);

  nowMs = 2000;
  const entry = log.append({ channel: 'wallpaper-auto', kind: 'failure', messageKey: 'journal.wallpaperAutoFailed' });
  ok('append stamps time and normalizes the entry', entry.atMs === 2000 && entry.kind === 'failure'
    && entry.channel === 'wallpaper-auto' && entry.messageKey === 'journal.wallpaperAutoFailed');

  nowMs = 3000;
  log.append({ channel: 'wallpaper-auto', kind: 'recovered', messageKey: 'journal.wallpaperAutoFailed' });
  ok('newest entry comes first', log.list()[0].kind === 'recovered' && log.list()[1].kind === 'failure');

  ok('entry without a messageKey is rejected', log.append({ channel: 'x', kind: 'failure' }) === null);
  ok('unknown kind becomes failure', log.append({ channel: 'x', messageKey: 'k', kind: 'weird' }).kind === 'failure');

  log.append({ channel: 'x', messageKey: 'k', params: { n: 3, name: 'file.png', bad: { deep: true } } });
  const withParams = log.list()[0];
  ok('params keep strings/numbers and drop objects',
    withParams.params.n === 3 && withParams.params.name === 'file.png' && !('bad' in withParams.params));

  for (let i = 0; i < 10; i++) log.append({ channel: 'spam', messageKey: `k${i}` });
  ok('journal is capped (oldest dropped)', log.list().length === 5 && log.list()[0].messageKey === 'k9');

  await log.flush();
  ok('journal file written atomically (no tmp left)', fs.existsSync(file) && !fs.existsSync(`${file}.tmp`));

  // Reload from disk: entries survive a restart.
  const reloaded = createEventLog({ filePath: file, cap: 5, now: () => nowMs });
  ok('entries survive reload', reloaded.list().length === 5 && reloaded.list()[0].messageKey === 'k9');

  await reloaded.clear();
  ok('clear empties the journal', reloaded.list().length === 0);
  const afterClear = createEventLog({ filePath: file, cap: 5, now: () => nowMs });
  ok('clear persists across reload', afterClear.list().length === 0);

  // Corrupt file must not throw and must behave as empty.
  fs.writeFileSync(file, '{ not valid json', 'utf8');
  const corrupt = createEventLog({ filePath: file, cap: 5, now: () => nowMs });
  ok('corrupt journal file is treated as empty', corrupt.list().length === 0);
  corrupt.append({ channel: 'x', messageKey: 'fresh' });
  await corrupt.flush();
  const reread = createEventLog({ filePath: file, cap: 5, now: () => nowMs });
  ok('journal recovers by rewriting the corrupt file', reread.list().length === 1 && reread.list()[0].messageKey === 'fresh');

  // A write failure must not break the app or later reads.
  const failingFs = {
    readFileSync: fs.readFileSync.bind(fs),
    promises: {
      mkdir: fs.promises.mkdir.bind(fs.promises),
      writeFile: async () => { throw new Error('disk full'); },
      rename: fs.promises.rename.bind(fs.promises),
    },
  };
  const failing = createEventLog({ filePath: path.join(dir, 'failing.json'), fsModule: failingFs, now: () => nowMs });
  failing.append({ channel: 'x', messageKey: 'kept-in-memory' });
  await failing.flush();
  ok('failed persistence keeps in-memory entries and does not throw',
    failing.list().length === 1 && failing.list()[0].messageKey === 'kept-in-memory');

  console.log('\nAll ' + passed + ' event-log tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
