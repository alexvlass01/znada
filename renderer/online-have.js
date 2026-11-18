'use strict';

// LIB-031. The window's half of "this Online card is a photo you already have".
//
// Main knows the answer (src/online-have.js, from the shared library pass); this keeps the
// answers for the cards the window has drawn, asks for new cards in one batch rather than
// one call per card, and asks again for all of them when main says the library changed.
// It decides nothing about the button: OnlineAdd.pooledItem reads `lookup` and the card is
// drawn exactly as a photo downloaded through Znada would be.
//
// No DOM here, so the batching and the re-asking are under tests.

(function initOnlineHave(root, factory) {
  const api = factory(
    (root && root.OnlineAdd) || (typeof require === 'function' ? require('../src/online-add') : null),
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OnlineHave = api;
}(typeof window !== 'undefined' ? window : globalThis, function onlineHaveFactory(OnlineAdd) {
  // Cards remembered at most. An endless feed draws thousands; the oldest are long off
  // screen, and a card drawn again is simply asked again.
  const KEEP = 1000;
  // Main answers this many per call.
  const BATCH = 500;
  const WAIT_MS = 120;

  // Only what main matches by: the fingerprint the site sent, or its size and resolution.
  function questionOf(key, item) {
    const it = item || {};
    return {
      key,
      md5: typeof it.md5 === 'string' ? it.md5 : '',
      fileSize: Number(it.fileSize) || 0,
      width: Number(it.width) || 0,
      height: Number(it.height) || 0,
    };
  }

  function canBeMatched(q) {
    return /^[0-9a-f]{32}$/i.test(q.md5) || (q.fileSize > 0 && q.width > 0 && q.height > 0);
  }

  /**
   * @param {{
   *   ask: (cards: any[]) => Promise<Record<string, { path: string, id: string } | null>>,
   *   onChange?: () => void,
   *   timers?: { setTimeout: Function, clearTimeout: Function },
   * }} deps
   */
  function create(deps) {
    // The window's own timers are called as plain functions: a browser's setTimeout called
    // as a method of another object throws 'Illegal invocation' (found in the live app).
    const {
      ask, onChange = () => {},
      timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
    } = deps || {};
    const questions = new Map();   // key -> question
    const answers = new Map();     // key -> { path, id } | null
    const waiting = new Set();     // keys to ask in the next batch
    let timer = null;
    let generation = 0;

    function keyOf(kind, item) {
      return OnlineAdd ? OnlineAdd.addingKey(kind, item) : '';
    }

    function schedule() {
      if (timer || !waiting.size) return;
      timer = timers.setTimeout(() => { timer = null; void flush(); }, WAIT_MS);
    }

    async function flush() {
      if (typeof ask !== 'function') { waiting.clear(); return; }
      const keys = Array.from(waiting);
      waiting.clear();
      const gen = generation;
      let changed = false;
      for (let i = 0; i < keys.length; i += BATCH) {
        const chunk = keys.slice(i, i + BATCH).map((key) => questions.get(key)).filter(Boolean);
        if (!chunk.length) continue;
        let reply = null;
        try { reply = await ask(chunk); } catch { reply = null; }
        // An answer to a question asked before the library changed is already stale: the
        // re-ask that followed the change carries the current one.
        if (gen !== generation || !reply || typeof reply !== 'object') continue;
        for (const q of chunk) {
          if (!questions.has(q.key)) continue;
          const raw = reply[q.key];
          const next = raw && typeof raw.path === 'string' && raw.path
            ? { path: raw.path, id: typeof raw.id === 'string' ? raw.id : '' }
            : null;
          const before = answers.has(q.key) ? answers.get(q.key) : undefined;
          if (!same(before, next)) changed = true;
          answers.set(q.key, next);
        }
      }
      if (changed) {
        try { onChange(); } catch {}
      }
    }

    function same(a, b) {
      if (a === undefined) return b === null; // unknown and "no" look the same on screen
      if (!a || !b) return a === b;
      return a.path === b.path && a.id === b.id;
    }

    // A card was drawn. Its answer, when already known, is used at once.
    function want(kind, item) {
      const key = keyOf(kind, item);
      if (!key) return;
      const q = questionOf(key, item);
      if (!canBeMatched(q)) return;
      if (questions.has(key)) { questions.delete(key); questions.set(key, q); return; }
      questions.set(key, q);
      while (questions.size > KEEP) {
        const oldest = questions.keys().next().value;
        questions.delete(oldest);
        answers.delete(oldest);
        waiting.delete(oldest);
      }
      waiting.add(key);
      schedule();
    }

    // What OnlineAdd.pooledItem reads.
    function lookup(kind, item) {
      const key = keyOf(kind, item);
      return key && answers.has(key) ? answers.get(key) : null;
    }

    // Main says the library changed: every remembered card is asked again. The answers
    // already shown stay until the new ones arrive, so nothing flickers.
    function refresh() {
      generation += 1;
      for (const key of questions.keys()) waiting.add(key);
      schedule();
    }

    return Object.freeze({ want, lookup, refresh, flushNow: flush, size: () => questions.size });
  }

  return { KEEP, BATCH, WAIT_MS, questionOf, create };
}));
