'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ensureRetentionRoot,
  pruneSessions,
  clearSessions,
} = require('../diagnostics/core/retention');

let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  OK ' + name);
  passed++;
};

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'znada-diagnostics-retention-'));
}

function makeSession(root, name, mtimeMs) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), '{}');
  const date = new Date(mtimeMs);
  fs.utimesSync(dir, date, date);
}

(async () => {
  const root = await ensureRetentionRoot(tmpRoot());
  makeSession(root, 'session-1', 1000);
  makeSession(root, 'session-2', 2000);
  makeSession(root, 'session-3', 3000);
  fs.mkdirSync(path.join(root, 'not-a-session'));

  const pruned = await pruneSessions(root, { keep: 2 });
  ok('prune removes only oldest session directories', pruned.removed.length === 1 && pruned.removed[0] === 'session-1');
  ok('prune keeps newest sessions and ignores unrelated dirs',
    fs.existsSync(path.join(root, 'session-2')) &&
    fs.existsSync(path.join(root, 'session-3')) &&
    fs.existsSync(path.join(root, 'not-a-session')));

  const lockedRoot = await ensureRetentionRoot(tmpRoot());
  makeSession(lockedRoot, 'session-locked', 1000);
  makeSession(lockedRoot, 'session-removable', 2000);
  makeSession(lockedRoot, 'session-newest', 3000);
  const lockedFs = {
    ...fs,
    promises: {
      ...fs.promises,
      async rm(target, options) {
        if (path.basename(target) === 'session-locked') {
          const err = new Error('resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
        return fs.promises.rm(target, options);
      },
    },
  };
  const lockedPrune = await pruneSessions(lockedRoot, { keep: 1, fsModule: lockedFs });
  ok('prune skips a locked old session and continues removing other candidates',
    lockedPrune.removed.length === 1 && lockedPrune.removed[0] === 'session-removable'
    && lockedPrune.failed.length === 1 && lockedPrune.failed[0].name === 'session-locked'
    && lockedPrune.failed[0].code === 'EBUSY'
    && fs.existsSync(path.join(lockedRoot, 'session-locked'))
    && fs.existsSync(path.join(lockedRoot, 'session-newest')));

  const cleared = await clearSessions(root);
  ok('clear removes all session directories only',
    cleared.removed.length === 2 &&
    !fs.existsSync(path.join(root, 'session-2')) &&
    fs.existsSync(path.join(root, 'not-a-session')));

  let unsafeRejected = false;
  try {
    await pruneSessions(tmpRoot(), { keep: 1 });
  } catch {
    unsafeRejected = true;
  }
  ok('retention refuses roots without marker', unsafeRejected);

  console.log('\nAll ' + passed + ' diagnostics retention tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
