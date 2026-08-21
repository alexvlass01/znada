'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_MARKER = '.znada-diagnostics-root';

async function ensureRetentionRoot(rootDir, { fsModule = fs } = {}) {
  const root = path.resolve(rootDir);
  await fsModule.promises.mkdir(root, { recursive: true });
  await fsModule.promises.writeFile(path.join(root, ROOT_MARKER), 'Znada diagnostics data\n', 'utf8');
  return root;
}

async function assertSafeRoot(rootDir, { fsModule = fs } = {}) {
  const root = path.resolve(rootDir);
  const marker = path.join(root, ROOT_MARKER);
  try {
    const st = await fsModule.promises.stat(marker);
    if (!st.isFile()) throw new Error('diagnostics retention marker is not a file');
  } catch (err) {
    throw new Error(`unsafe diagnostics retention root: ${root}`);
  }
  return root;
}

async function listSessions(rootDir, { fsModule = fs } = {}) {
  const root = await assertSafeRoot(rootDir, { fsModule });
  const entries = await fsModule.promises.readdir(root, { withFileTypes: true });
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue;
    const fullPath = path.join(root, entry.name);
    const st = await fsModule.promises.stat(fullPath);
    sessions.push({
      name: entry.name,
      path: fullPath,
      mtimeMs: st.mtimeMs,
    });
  }
  sessions.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  return sessions;
}

async function pruneSessions(rootDir, { keep = 15, fsModule = fs } = {}) {
  const safeKeep = Math.max(0, Number.isFinite(keep) ? Math.floor(keep) : 15);
  const sessions = await listSessions(rootDir, { fsModule });
  const remove = sessions.slice(0, Math.max(0, sessions.length - safeKeep));
  const removed = [];
  const failed = [];
  for (const session of remove) {
    try {
      // Windows can transiently lock a diagnostics directory while Explorer,
      // antivirus or another Znada process still has a handle to it. Retention is
      // best-effort housekeeping: one locked old session must never block a new one.
      await fsModule.promises.rm(session.path, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
      removed.push(session.name);
    } catch (err) {
      failed.push({
        name: session.name,
        code: err && err.code ? String(err.code) : 'unknown',
      });
    }
  }
  return { kept: sessions.length - removed.length, removed, failed };
}

async function clearSessions(rootDir, { fsModule = fs } = {}) {
  const sessions = await listSessions(rootDir, { fsModule });
  for (const session of sessions) {
    await fsModule.promises.rm(session.path, { recursive: true, force: true });
  }
  return { removed: sessions.map((s) => s.name) };
}

module.exports = {
  ROOT_MARKER,
  ensureRetentionRoot,
  assertSafeRoot,
  listSessions,
  pruneSessions,
  clearSessions,
};
