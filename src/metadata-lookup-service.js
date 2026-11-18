'use strict';

// CODE-001. META-001 as one service: fingerprint a pool photo, ask the catalogues that can
// answer by fingerprint, and write what comes back onto the photo's record.
//
// Owns: the fingerprint cache and the lookup journal (loaded lazily, written through its
// own writer), the per-site request budget, and the one-at-a-time queue — all for the life
// of this instance. Does not own: the pool (read through `getConfig` at the moment of
// every call — `set-config` replaces the whole object — and saved through `savePoolOnly`),
// whether a path may be read (`isAuthorizedItemPath`), whether the managed folder is being
// moved (`isMoveRunning`), how a site is reached (`providers`, src/provider-access.js) or
// which sites exist (`registry`). The registry and src/metadata-lookup.js arrive as
// dependencies: requiring them here would pull the site adapters, and with them the
// machine-local key files, into the type check (see tsconfig.json).
//
// Moved out of main.js unchanged; the comments below are the ones that stood there.

const fs = require('fs');
const crypto = require('crypto');
const fingerprint = require('./fingerprint'); // что файл ЕСТЬ: кешируемый отпечаток байтов
const metadataStore = require('./metadata-store'); // отпечатки и журнал запросов (производное, не данные пользователя)
const requestBudget = require('./request-budget'); // сколько запросов наружу вообще разрешено
const libraryFreeze = require('./library-freeze');
const { pathKey } = require('./path-key');
const { hashFileMd5, HASH_TIMEOUT, ABORT_ERR } = require('./metadata-hash');
const { createMetadataWorkQueue, raceSignal, abortError } = require('./metadata-work-queue');
const iqdb = require('./iqdb');
const contentRating = require('./content-rating');
const mediaProxy = require('./media-proxy');

// ---------------------------------------------------------------------------
// META-001 — what an online catalogue knows about a file the user already has
// ---------------------------------------------------------------------------
//
// The question travels as a FINGERPRINT and nothing else: no bytes, no filename and no
// path leave the machine. What comes back — tags, artist, rating, the post's page — is
// written onto the photo's own record, so a picture the user brought himself ends up
// describing itself the same way a downloaded one does. That parity is the point.
//
// Three protections, because there are three separate ways to get this wrong:
//
//   * a wrong answer. The catalogue is asked for an exact hash, and the post that comes
//     back is CHECKED to carry that same hash before a single tag is believed. Attaching
//     somebody else's tags to the user's photo is worse than finding nothing.
//   * losing something the user wrote. The merge only fills blanks for fields a person
//     can set himself — see metadataLookup.planFor.
//   * a ban. Every request passes the budget; every question is remembered against the
//     fingerprint, so the same bytes are asked about once ever, no matter how many
//     copies or how many clicks; and the work runs one at a time, with a pending cap
//     and a deadline so one stalled read cannot hold the worker.
//
// Deliberately manual for now: one photo, one explicit action. The queue and the budget
// exist anyway, because "look up everything as it is added" is meant to arrive later as
// a different CALLER of this same path rather than as a second, unbudgeted one.

const METADATA_MANUAL_PRIORITY = 10;

// Hashing reads every byte, so a pathological file is refused rather than holding the
// queue for minutes. No wallpaper comes close to this.
const MAX_FINGERPRINT_BYTES = 256 * 1024 * 1024;

// Only the ordinary intra-operation separation is worth waiting inside the sole worker.
// A long/custom host policy must surface as busy rather than monopolise the queue.
const METADATA_INLINE_GAP_WAIT_MAX_MS = 1000;

// PERF-007. Pending jobs only — the one running job is extra. Eight is enough for a
// person clicking ahead and for a future low-priority sweep to wait behind them.
// 180s covers a 256MB wallpaper at about 1.4MB/s. A stalled or trickling share cannot
// hold the worker longer than that; the next library pass retries a timeout.
const METADATA_QUEUE_LIMIT = 8;
const METADATA_JOB_TIMEOUT_MS = 180000;

function isAbortErr(err) {
  if (!err) return false;
  const coded = /** @type {{ code?: string, name?: string }} */ (err);
  return coded.code === ABORT_ERR || coded.code === HASH_TIMEOUT || coded.name === 'AbortError';
}

// A post is only believed when it carries the very hash we asked about. Gelbooru's
// `md5:` term is an ordinary search term, and a search that silently ignored it would
// otherwise hand back an arbitrary picture — with tags that would then be written onto
// the user's photo.
//
// BUG-026. This used to demand a match only when the post HAD a hash, so a post that
// carried none was accepted by default — and that is not a rare shape: Danbooru omits
// the file fields on restricted and deleted posts, and both adapters turn a missing
// field into an empty string. "I cannot tell you which file this is" is not the same
// answer as "this is your file", and only one of them may write tags onto a photo.
//
// Both sides are normalised first, because the other half of exactness is not being
// needlessly strict: a catalogue that spells the same hash in capitals has answered our
// question, and refusing it would report "not found" for a photo it does hold.
function normalizedFingerprint(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function postMatchesHash(summary, hash) {
  if (!summary) return false;
  const claimed = normalizedFingerprint(summary.md5);
  const asked = normalizedFingerprint(hash);
  return !!claimed && !!asked && claimed === asked;
}

// The renderer's whole view of one lookup. Deliberately flat and provider-agnostic:
// the interface says what happened, not which catalogue happened to answer.
function metadataLookupReply(outcome, applied) {
  const result = outcome.result || null;
  return {
    status: outcome.status,
    reason: outcome.reason || '',
    cached: !!outcome.cached,
    retryAfterMs: Number(outcome.retryAfterMs) || 0,
    provider: result ? result.provider : (outcome.provider || ''),
    page: result ? result.page : '',
    author: result ? result.author : '',
    rating: result ? result.rating : '',
    tagCount: result ? result.tags.length : 0,
    addedTags: applied && applied.applied ? applied.added : 0,
    skipped: applied && applied.plan ? applied.plan.skipped : [],
  };
}

/**
 * @param {{
 *   configPath: string,
 *   getConfig: () => any,
 *   library: any,
 *   lookup: any,
 *   registry: { active: () => any[], byId: (id: string) => any, matchesDeclaration?: (hosts: any, kind: string, target: string) => boolean },
 *   providers: { credentials: (descriptor: any) => any },
 *   userAgent: string,
 *   isAuthorizedItemPath: (p: string) => boolean,
 *   isMoveRunning: () => boolean,
 *   savePoolOnly: () => any,
 *   thumbnail?: (path: string) => Promise<any>,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (timer: any) => void,
 *   jobTimeoutMs?: number,
 *   hashTimeoutMs?: number,
 *   queueLimit?: number,
 *   createReadStream?: (filePath: string) => any,
 * }} deps
 */
function create(deps) {
  const {
    configPath, getConfig, library, lookup: metadataLookup, registry: providerRegistry,
    providers: providerAccess, userAgent, isAuthorizedItemPath, isMoveRunning, savePoolOnly,
  } = deps;
  // Look up Date.now on each call. Tests replace it after the service exists
  // (visual token expiry). An injected clock is still called every time.
  const clock = typeof deps.now === 'function' ? () => deps.now() : () => Date.now();
  const setTimer = typeof deps.setTimer === 'function' ? deps.setTimer : setTimeout;
  const clearTimer = typeof deps.clearTimer === 'function' ? deps.clearTimer : clearTimeout;
  const jobTimeoutMs = Number(deps.jobTimeoutMs) > 0 ? Number(deps.jobTimeoutMs) : METADATA_JOB_TIMEOUT_MS;
  const hashTimeoutMs = Number(deps.hashTimeoutMs) > 0 ? Number(deps.hashTimeoutMs) : METADATA_JOB_TIMEOUT_MS;
  const queueLimit = Number(deps.queueLimit) > 0 ? Number(deps.queueLimit) : METADATA_QUEUE_LIMIT;

  // META-001. Derived knowledge about local files: their fingerprints, and the journal of
  // what each catalogue has already answered about them. Kept apart from the pool on
  // purpose — see src/metadata-store.js. Loaded lazily on first use so a feature nobody
  // touches costs nothing at startup.
  let metadataCache = null;
  const metadataWriter = metadataStore.createWriter({ configPath });

  function metadataCacheStore() {
    if (!metadataCache) metadataCache = metadataStore.load(configPath);
    return metadataCache;
  }

  function markMetadataDirty() {
    if (!metadataCache) return;
    metadataStore.evict(metadataCache, clock());
    metadataWriter.markDirty(metadataCache);
  }

  // Separate from the thumbnail queue. One running job, a capped pending list, and the
  // same photo shares one promise. A manual click is high priority so a future
  // background sweep can be dropped when the list is full instead of burying the click.
  const metadataQueue = createMetadataWorkQueue({
    maxPending: queueLimit,
    timeoutMs: jobTimeoutMs,
    setTimer,
    clearTimer,
  });

  function schedule(key, fn, priority) {
    return metadataQueue.enqueue(key, fn, {
      priority,
      onTimeout: () => metadataLookupReply({ status: 'error', reason: 'timeout' }, null),
      busy: () => metadataLookupReply({ status: 'busy', reason: 'queue', retryAfterMs: 1000 }, null),
    });
  }

  // Per-provider traffic state. Kept in memory only: after a restart the journal still
  // prevents repeat questions, and starting with a full bucket costs at most a few
  // requests that the host was going to allow anyway.
  const metadataBudgets = new Map();
  // The live limits. An object rather than the module defaults so a test can loosen them
  // without waiting out real seconds — the alternative is a suite that either takes
  // minutes or, worse, quietly stops exercising the limiter at all.
  let metadataBudgetConfig = null;
  const visualClient = iqdb.create({ userAgent });
  const visualTokens = new Map();
  const visualPending = new Set();

  function metadataBudgetTake(providerId, now) {
    const gate = requestBudget.take(metadataBudgets.get(providerId), now, metadataBudgetConfig);
    if (gate.allowed) metadataBudgets.set(providerId, gate.state);
    return gate;
  }

  function metadataBudgetNote(providerId, ok, now, kind) {
    const state = metadataBudgets.get(providerId);
    metadataBudgets.set(providerId, ok
      ? requestBudget.noteSuccess(state, now, metadataBudgetConfig)
      : requestBudget.noteFailure(state, now, kind, metadataBudgetConfig));
  }

  // One request through the budget. Returns a tagged outcome instead of throwing, so the
  // caller never has to guess whether a failure was the host refusing, the network, or
  // simply our own limiter saying "not yet".
  async function metadataFetchJson(providerId, url, timeoutMs = 10000, signal) {
    // Our own deadline is not a host failure: do not spend a backoff on it.
    if (signal && signal.aborted) return { failed: true, reason: 'timeout' };
    let gate = metadataBudgetTake(providerId, clock());
    // The minimum host gap separates REQUESTS, not user operations. Gelbooru legitimately
    // needs a second request for tag kinds after it found the post. Returning `busy` here
    // silently made that enrichment partial forever because the found result is journalled
    // and never asked again. Wait only for the short gap; rate exhaustion and host backoff
    // remain immediate refusals so a burst or a 429 can never turn into an unbounded queue.
    const gapMs = Number(gate.retryAfterMs);
    if (!gate.allowed && gate.reason === 'gap'
        && Number.isFinite(gapMs) && gapMs > 0 && gapMs <= METADATA_INLINE_GAP_WAIT_MAX_MS) {
      const waitMs = Math.max(1, Math.ceil(gapMs) + 1);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimer(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
          }, waitMs);
          if (timer && typeof timer.unref === 'function') timer.unref();
          function onAbort() {
            clearTimer(timer);
            reject(abortError());
          }
          if (signal) {
            if (signal.aborted) { onAbort(); return; }
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      } catch (err) {
        if (isAbortErr(err)) return { failed: true, reason: 'timeout' };
        throw err;
      }
      if (signal && signal.aborted) return { failed: true, reason: 'timeout' };
      gate = metadataBudgetTake(providerId, clock());
    }
    if (!gate.allowed) return { blocked: true, reason: gate.reason, retryAfterMs: Math.ceil(gate.retryAfterMs) };
    try {
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (signal) signals.push(signal);
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent },
        signal: AbortSignal.any(signals),
      });
      if (!res.ok) {
        metadataBudgetNote(providerId, false, clock(), requestBudget.failureKind(res.status, null));
        return { failed: true, reason: String(res.status) };
      }
      const json = await res.json();
      metadataBudgetNote(providerId, true, clock());
      return { json };
    } catch (err) {
      if (signal && signal.aborted) return { failed: true, reason: 'timeout' };
      metadataBudgetNote(providerId, false, clock(), requestBudget.failureKind(0, err));
      return { failed: true, reason: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
  }

  // The file's fingerprint, from cache when the file has not changed since it was hashed.
  // Streamed rather than read whole: a fingerprint is needed for files far larger than a
  // thumbnail, and holding one in memory for the sake of one hash is pure waste.
  async function fingerprintForFile(filePath, kind = 'md5', parentSignal) {
    const store = metadataCacheStore();
    metadataStore.evict(store, clock());
    const key = fingerprint.fileKey(filePath);
    // The library pass calls fingerprint() directly, outside the queue. This deadline
    // covers that path too: a hung stat or a stalled stream settles as `timeout` and
    // is not cached. A queued job links its own signal so the queue deadline wins as well.
    const ac = new AbortController();
    const onParent = () => ac.abort(abortError());
    if (parentSignal) {
      if (parentSignal.aborted) ac.abort(abortError());
      else parentSignal.addEventListener('abort', onParent, { once: true });
    }
    let timer = null;
    const armDeadline = () => {
      if (timer || ac.signal.aborted || !(hashTimeoutMs > 0)) return;
      timer = setTimer(() => {
        const err = /** @type {Error & { code: string }} */ (new Error('hash timed out'));
        err.code = HASH_TIMEOUT;
        ac.abort(err);
      }, hashTimeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    };
    try {
      // BUG-026. Hashing is streamed, so the file can be replaced WHILE it is being read —
      // a live folder rescan, a re-download, any outside tool. The hash would then be of the
      // new bytes while the size and mtime recorded beside it belong to the old ones, and
      // that pairing is what gets cached: every later lookup of this photo would ask a
      // catalogue about a file that never existed. So the stamp is taken again afterwards
      // and must still match. One retry, because a single swap is ordinary; a file being
      // rewritten continuously is not something to keep chasing.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (ac.signal.aborted) return { error: 'timeout' };
        armDeadline();
        let stat;
        try {
          stat = await raceSignal(fs.promises.stat(filePath), ac.signal);
        } catch (err) {
          if (isAbortErr(err)) return { error: 'timeout' };
          return { error: 'missing' };
        }
        if (!stat.isFile()) return { error: 'missing' };
        if (stat.size <= 0 || stat.size > MAX_FINGERPRINT_BYTES) return { error: 'unsupported' };

        const stamp = fingerprint.stampOf(stat);
        const cached = fingerprint.valueOf(store.files[key], stamp, kind);
        if (cached) return { value: cached, cached: true, stamp };

        let value;
        try {
          value = await hashFileMd5(filePath, {
            createReadStream: deps.createReadStream,
            signal: ac.signal,
            timeoutMs: 0,
            setTimer,
            clearTimer,
          });
        } catch (err) {
          if (isAbortErr(err)) return { error: 'timeout' };
          console.error('metadata fingerprint:', err);
          return { error: 'unreadable' };
        }
        if (ac.signal.aborted) return { error: 'timeout' };

        let after;
        try {
          after = await raceSignal(fs.promises.stat(filePath), ac.signal);
        } catch (err) {
          if (isAbortErr(err)) return { error: 'timeout' };
          return { error: 'missing' };
        }
        if (!fingerprint.sameStamp(fingerprint.stampOf(after), stamp)) continue;
        if (ac.signal.aborted) return { error: 'timeout' };

        const entry = fingerprint.withValues(store.files[key], stamp, { [kind]: value });
        // `at` belongs to the store, not to the pure fingerprint shape: it is only there so
        // eviction can drop the least recently touched file rather than an arbitrary one.
        store.files[key] = Object.assign({}, entry, { at: clock() });
        markMetadataDirty();
        return { value, cached: false, stamp };
      }
      return { error: 'changed' };
    } finally {
      if (timer) clearTimer(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onParent);
    }
  }

  // LIB-031. The fingerprint this file already has, and nothing else: a stat, never a read
  // of the file. '' when it was never hashed or changed since. Right after launch the
  // Online cards need to know what the library holds long before the pass gets going.
  async function cachedFingerprintForFile(filePath, kind = 'md5') {
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch { return ''; }
    if (!stat.isFile()) return '';
    const entry = metadataCacheStore().files[fingerprint.fileKey(filePath)];
    return fingerprint.valueOf(entry, fingerprint.stampOf(stat), kind) || '';
  }

  // ONL-013. One way to ask a site "which post IS this exact file", for every site.
  //
  // There used to be a hand-written function per site here, plus a small table mapping an
  // id to one of them — the same shape `ONL-012` removed from the search path, still alive
  // on this one, and a second list of sites beside the registry's. A site now DECLARES
  // that it can be searched by fingerprint and provides the hook; nothing below names one.
  //
  // The BUDGET is what makes this path different from the search path, and it stays here
  // rather than in the sites: every request is metered, and a refusal by our own limiter
  // is not the same thing as a failure by the host. The site sees an ordinary failure —
  // it never has to learn the word — while this remembers that the refusal was OURS, so
  // the answer becomes "busy, try later" and nothing is written to the journal. Nothing
  // was asked, so nothing is known.
  function metadataContext(descriptor, signal) {
    const state = { blocked: null };
    return {
      credentials: providerAccess.credentials(descriptor),
      state,
      fetchJson: async (url, opts) => {
        const timeoutMs = Number(opts && opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10000;
        const res = await metadataFetchJson(descriptor.id, url, timeoutMs, signal);
        if (res.blocked) {
          if (!state.blocked) state.blocked = { reason: res.reason, retryAfterMs: res.retryAfterMs };
          return { error: res.reason || 'busy' };
        }
        if (res.failed) return { error: res.reason || 'network' };
        return { json: res.json };
      },
    };
  }

  async function askProviderForFingerprint(descriptor, kind, hash, signal) {
    if (!descriptor || typeof descriptor.findByFingerprint !== 'function') {
      return { status: 'error', reason: 'unsupported' };
    }
    if (descriptor.credentials && descriptor.credentials.required && !providerAccess.credentials(descriptor)) {
      return { status: 'error', reason: 'unavailable' };
    }
    const ctx = metadataContext(descriptor, signal);
    let res;
    try {
      res = await descriptor.findByFingerprint(kind, hash, ctx);
    } catch (err) {
      console.error(`${descriptor.id} fingerprint lookup:`, err);
      res = { error: 'network' };
    }
    // A post FIRST, and only then the limiter. A site whose extra request was refused —
    // Gelbooru asks separately for tag kinds — has still found the picture, and answering
    // "busy" would throw away an answer already in hand.
    if (res && res.result) {
      // Checked HERE, once, for every site, and never delegated to the site itself:
      // `md5:` is an ordinary search term, so a catalogue that quietly ignored it would
      // hand back an arbitrary picture — whose tags would then be written onto the user's
      // photo. A site that forgot this check would be indistinguishable from one that did.
      return postMatchesHash(res.result, hash)
        ? { status: 'found', result: res.result }
        : { status: 'absent', reason: 'mismatch' };
    }
    if (ctx.state.blocked) {
      return { status: 'busy', reason: ctx.state.blocked.reason, retryAfterMs: ctx.state.blocked.retryAfterMs };
    }
    if (!res || typeof res !== 'object' || res.error) {
      return { status: 'error', reason: (res && res.error) || 'network' };
    }
    // "Not here" is an ANSWER, not a failure, and it rests for a MONTH where a failure
    // rests for an hour — so a site has to say it explicitly. An answer we cannot read is
    // a failure: silently reading it as "not here" would silence a findable photo for a
    // month on the strength of a shape we did not understand.
    if (res.result === null) return { status: 'absent' };
    return { status: 'error', reason: 'malformed' };
  }

  // Which sites are holding the key they declared they need. Only sites that require one
  // appear at all: for the rest the question does not arise.
  function metadataCredentials() {
    const map = {};
    for (const descriptor of providerRegistry.active()) {
      if (descriptor.credentials && descriptor.credentials.required) {
        map[descriptor.id] = !!providerAccess.credentials(descriptor);
      }
    }
    return map;
  }

  // Ask whoever still has something to say about this fingerprint, in order, stopping at
  // the first real answer. A provider that is merely rate-limited right now does NOT get
  // journalled: nothing was asked, so nothing is known, and the next click may try again.
  async function lookupByFingerprint(kind, hash, signal) {
    const store = metadataCacheStore();
    metadataStore.evict(store, clock());
    const key = metadataLookup.journalKey(kind, hash);
    if (!key) return { status: 'error', reason: 'badFingerprint' };

    const known = metadataLookup.normalizeEntry(store.lookups[key]);
    if (known.result) return { status: 'found', result: known.result, cached: true };

    const now = clock();
    const pending = metadataLookup.pendingProviders(store.lookups[key], kind, now, {
      credentials: metadataCredentials(),
    });
    if (!pending.length) {
      // Nothing to ask is not the same as nothing being there. A catalogue that was
      // UNREACHABLE an hour ago has not told us the picture is absent, so reporting a
      // miss would be a lie the user acts on — he would stop pressing the button.
      const reasons = metadataLookup.providersFor(kind, { credentials: metadataCredentials() })
        .map((id) => metadataLookup.shouldAsk(store.lookups[key], id, now).reason);
      if (!reasons.length) return { status: 'error', reason: 'noProvider', settled: true };
      // BUG-032. `some`, not `every`. Absence is a claim about EVERY catalogue that could
      // have answered, so one of them still resting after an error is enough to make the
      // claim unsupportable — and the mixed state (one answered "not here", the other timed
      // out) is the common one in real life, not the rare one. The earlier `every` demanded
      // that ALL of them be unreachable before it would admit uncertainty, so the ordinary
      // case was reported as a definite "no catalogue has this file". A miss is remembered
      // for a month, so that answer stuck and pressing the button again did not re-ask.
      if (reasons.some((reason) => reason === 'errorRecently')) {
        return { status: 'error', reason: 'errorRecently', settled: true };
      }
      return { status: 'absent', reason: reasons[0], settled: true };
    }

    let lastError = null;
    for (const providerId of pending) {
      if (signal && signal.aborted) return { status: 'error', reason: 'timeout' };
      // Never throws: a site that breaks drops out of this round the same way it drops out
      // of a search round.
      const outcome = await askProviderForFingerprint(providerRegistry.byId(providerId), kind, hash, signal);
      // A deadline that landed while the request was out is not an answer. Journaling it
      // would remember "absent" or "failed" for a question we stopped ourselves.
      if (signal && signal.aborted) return { status: 'error', reason: 'timeout' };
      if (outcome.status === 'busy') { lastError = outcome; continue; }
      store.lookups[key] = Object.assign(
        metadataLookup.recordOutcome(store.lookups[key], providerId, outcome, clock()),
        { at: clock() },
      );
      markMetadataDirty();
      if (outcome.status === 'found') {
        return { status: 'found', result: metadataLookup.normalizeEntry(store.lookups[key]).result, provider: providerId };
      }
      if (outcome.status === 'error') lastError = outcome;
    }
    return lastError && lastError.status === 'busy'
      ? { status: 'busy', reason: lastError.reason, retryAfterMs: lastError.retryAfterMs }
      : (lastError ? { status: 'error', reason: lastError.reason } : { status: 'absent' });
  }

  // Write a found result onto one pool record. Re-reads the item AFTER the network work:
  // the user may have removed the photo while the request was in flight, and reviving a
  // removed record by writing tags to it is exactly the class of resurrection DATA-005
  // was about.
  function applyLookupToItem(id, result) {
    const config = getConfig();
    const item = library.getItem(config.library, id);
    if (!item) return { applied: false, reason: 'missing' };
    const plan = metadataLookup.planFor(item, result);
    if (metadataLookup.planIsEmpty(plan)) return { applied: false, reason: 'nothingNew', plan };
    // Every field goes through the library's own mutators so the record's revision moves
    // with it; a direct assignment would leave it looking older than it is and lose the
    // next merge.
    library.updateItem(config.library, id, plan.patch);
    let added = 0;
    for (const tag of plan.tags) {
      if (library.addTag(config.library, id, tag)) added++;
    }
    savePoolOnly();
    return { applied: true, added, plan };
  }

  // Look up one pool photo: fingerprint it, ask whoever can answer, write what comes back.
  // Split out of the IPC handler so tests can drive the real sequence — the order of these
  // steps is precisely what a module-level test cannot see.
  // BUG-026. What "the same photo" has to mean for the length of one lookup: the same
  // record, still naming the same path, with the same bytes behind it. The network round
  // trip takes seconds, and all three can change inside it — so the answer is checked
  // against the world it was asked about, not against whatever is there when it arrives.
  //
  // `addedAt` is in here on purpose. A record removed and added again keeps its id (the id
  // is derived from the path), so `getItem` still finds one; but it is a decision the user
  // made AFTER this request, and tags fetched for the old one do not belong to it.
  async function itemIdentityUnchanged(id, snapshot, signal) {
    const item = library.getItem(getConfig().library, id);
    if (!item || item.type !== 'image') return false;
    // Redundant while ids are derived from paths (`library.idFor`) and nothing patches a
    // record's `path` — checked, and a mutation removing this line survives the battery
    // because of it. Kept as a stated invariant rather than deleted: it costs nothing, and
    // the day an id stops being the path is the day this becomes the only thing that
    // notices. Do not "prove" it with a test that hand-writes a path a record cannot have.
    if (pathKey(item.path) !== snapshot.path) return false;
    if ((Number(item.addedAt) || 0) !== snapshot.addedAt) return false;
    let stat;
    try {
      stat = await raceSignal(fs.promises.stat(item.path), signal);
    } catch { return false; }
    return fingerprint.sameStamp(fingerprint.stampOf(stat), snapshot.stamp);
  }

  async function runItemMetadataLookup(id) {
    const item = library.getItem(getConfig().library, id);
    if (!item || item.type !== 'image') return { status: 'error', reason: 'unsupported' };
    const filePath = item.path;
    if (!isAuthorizedItemPath(filePath)) return { status: 'error', reason: 'denied' };

    return schedule(`item:${id}`, async (signal) => {
      // Re-read rather than close over the record above: this runs behind a queue, so the
      // wait before it starts is as real as the wait inside it.
      const current = library.getItem(getConfig().library, id);
      if (!current || current.type !== 'image' || pathKey(current.path) !== pathKey(filePath)) {
        return metadataLookupReply({ status: 'error', reason: 'changed' }, null);
      }
      if (signal.aborted) return metadataLookupReply({ status: 'error', reason: 'timeout' }, null);
      const print = await fingerprintForFile(filePath, 'md5', signal);
      if (signal.aborted) return metadataLookupReply({ status: 'error', reason: 'timeout' }, null);
      if (print.error) return metadataLookupReply({ status: 'error', reason: print.error }, null);
      const snapshot = {
        path: pathKey(current.path),
        addedAt: Number(current.addedAt) || 0,
        stamp: print.stamp,
      };
      const outcome = await lookupByFingerprint('md5', print.value, signal);
      if (signal.aborted) return metadataLookupReply({ status: 'error', reason: 'timeout' }, null);
      if (outcome.status !== 'found') return metadataLookupReply(outcome, null);
      const same = await itemIdentityUnchanged(id, snapshot, signal);
      if (signal.aborted) return metadataLookupReply({ status: 'error', reason: 'timeout' }, null);
      if (!same) {
        // The journal still keeps what the catalogue said — the answer is about a
        // fingerprint, not about this record — so pressing the button again is cheap and
        // will write it to whatever is actually there now.
        return metadataLookupReply({ status: 'error', reason: 'changed' }, null);
      }
      // DATA-009. The door refuses a lookup asked for during a move; one asked for just before
      // is past the door, waiting on the network, and its write lands here. Checked after the
      // last await, so the check and the write cannot be split. The journal keeps the answer:
      // asking again after the move costs no request.
      if (isMoveRunning()) return metadataLookupReply({ status: 'error', reason: libraryFreeze.MOVE_RUNNING }, null);
      if (signal.aborted) return metadataLookupReply({ status: 'error', reason: 'timeout' }, null);
      return metadataLookupReply(outcome, applyLookupToItem(id, outcome.result));
    }, METADATA_MANUAL_PRIORITY);
  }

  // META-004. Explicit user action, never a background upload. The owner decided
  // on 2026-10-23 that the lookup action needs no additional consent dialog;
  // the proposed identity still needs confirmation before it may change tags.
  async function visualItem(id, owner) {
    if (visualPending.has(id) || visualPending.size >= 16) return { status: 'busy', retryAfterMs: 30000 };
    visualPending.add(id);
    try { return await schedule(`visual:${id}`, async (signal) => {
      if (signal.aborted) return { status: 'error', reason: 'timeout' };
      if (isMoveRunning()) return { status: 'error', reason: libraryFreeze.MOVE_RUNNING };
      const item = library.getItem(getConfig().library, id);
      if (!item || item.type !== 'image' || !isAuthorizedItemPath(item.path)) return { status: 'error', reason: 'denied' };
      const print = await fingerprintForFile(item.path, 'md5', signal);
      if (signal.aborted) return { status: 'error', reason: 'timeout' };
      if (print.error) return { status: 'error', reason: print.error };
      const snapshot = { path: pathKey(item.path), addedAt: Number(item.addedAt) || 0, stamp: print.stamp };
      const key = 'iqdb:md5:' + print.value;
      const store = metadataCacheStore();
      let outcome = store.lookups[key];
      const ttl = outcome?.status === 'error' ? metadataLookup.RETRY.errorMs : metadataLookup.RETRY.absentMs;
      if (!outcome || !['candidate', 'absent', 'ambiguous', 'error'].includes(outcome.status)
        || !Number.isFinite(outcome.at) || outcome.at > clock() || clock() - outcome.at >= ttl) outcome = null;
      // Rejection belongs to this answer, shared by identical bytes in every window.
      // Keep its original timestamp: rejecting neither reuploads nor extends the TTL.
      if (outcome?.status === 'candidate' && outcome.rejected === true) return { status: 'absent', reason: 'rejected' };
      // A journal hit made no request: do not describe the earlier timeout as a new one.
      if (outcome?.status === 'error') outcome = { ...outcome, reason: 'errorRecently' };
      let thumbnail;
      try { thumbnail = deps.thumbnail && await deps.thumbnail(item.path); } catch { /* reported below */ }
      const mime = thumbnail?.mime;
      const bytes = Buffer.from(thumbnail?.dataBase64 || '', 'base64');
      if (!['image/png', 'image/jpeg'].includes(mime) || !bytes.length || bytes.length > iqdb.MAX_IMAGE_BYTES
        || !(thumbnail.width > 0 && thumbnail.height > 0 && thumbnail.width <= 512 && thumbnail.height <= 512)) {
        return { status: 'error', reason: 'thumbnail' };
      }
      const samePreview = await itemIdentityUnchanged(id, snapshot, signal);
      if (signal.aborted) return { status: 'error', reason: 'timeout' };
      if (!samePreview || !isAuthorizedItemPath(item.path)) return { status: 'error', reason: 'changed' };
      if (isMoveRunning()) return { status: 'error', reason: libraryFreeze.MOVE_RUNNING };
      if (!outcome) {
        outcome = await visualClient.search({ bytes, mime });
        if (signal.aborted) return { status: 'error', reason: 'timeout' };
        if (outcome.status !== 'busy') {
          outcome = store.lookups[key] = { ...outcome, at: clock() };
          const keys = Object.keys(store.lookups).filter((entry) => entry.startsWith('iqdb:md5:'));
          if (keys.length > 200) {
            keys.sort((a, b) => Number(store.lookups[a].at) - Number(store.lookups[b].at));
            for (const old of keys.slice(0, keys.length - 200)) delete store.lookups[old];
          }
          markMetadataDirty();
        }
      }
      if (outcome.status !== 'candidate') return { status: outcome.status, reason: outcome.reason || '', retryAfterMs: outcome.retryAfterMs || 0 };
      const candidate = outcome.candidate;
      const ref = iqdb.reference(candidate?.page);
      if (!ref || ref.provider !== candidate.provider || ref.postId !== candidate.postId
        || !Number.isFinite(candidate.similarity) || candidate.similarity < 80 || candidate.similarity > 100) {
        return { status: 'error', reason: 'malformed' };
      }
      const descriptor = providerRegistry.byId(ref.provider);
      if (!descriptor || descriptor.status === 'retired' || typeof descriptor.lookup !== 'function'
        || typeof descriptor.findByFingerprint !== 'function') return { status: 'error', reason: 'unavailable' };
      const ctx = metadataContext(descriptor, signal);
      const response = await descriptor.lookup(ref.postId, ctx);
      const remote = response?.item;
      if (!remote || remote.id !== `${ref.provider}:${ref.postId}` || !/^[a-f0-9]{32}$/i.test(remote.md5 || '')) {
        if (ctx.state.blocked) return { status: 'busy', retryAfterMs: ctx.state.blocked.retryAfterMs };
        if (!remote && typeof response?.error === 'string' && response.error.trim()) return { status: 'error', reason: response.error };
        return { status: 'error', reason: 'unavailable' };
      }
      // Full metadata, not compact feed tags. This hash names the remote original,
      // deliberately never asserted equal to the user's re-encoded file.
      const details = await descriptor.findByFingerprint('md5', remote.md5, ctx);
      const result = metadataLookup.makeResult(ref.provider, details?.result);
      if (!result && ctx.state.blocked) return { status: 'busy', retryAfterMs: ctx.state.blocked.retryAfterMs };
      if (!result && typeof details?.error === 'string' && details.error.trim()) return { status: 'error', reason: details.error };
      if (!result || result.postId !== ref.postId || !postMatchesHash(result, remote.md5)) return { status: 'error', reason: 'mismatch' };
      const sameResult = await itemIdentityUnchanged(id, snapshot, signal);
      if (signal.aborted) return { status: 'error', reason: 'timeout' };
      if (!sameResult || !isAuthorizedItemPath(item.path)) return { status: 'error', reason: 'changed' };
      if (isMoveRunning()) return { status: 'error', reason: libraryFreeze.MOVE_RUNNING };
      if (signal.aborted) return { status: 'error', reason: 'timeout' };
      const rating = contentRating.of(result);
      // This is enrichment of an existing local photo, not discovery in Online.
      // Preserve display blur, but Online's search admission must not hide a match.
      let thumb;
      try { thumb = new URL(remote.thumb); } catch { return { status: 'error', reason: 'thumbnail' }; }
      if (thumb.protocol !== 'https:' || thumb.username || thumb.password || thumb.port
        || !providerRegistry.matchesDeclaration?.(descriptor.hosts, 'thumb', thumb.href)) return { status: 'error', reason: 'thumbnail' };
      const fallbackThumb = mediaProxy.buildUrl({ provider: ref.provider, tier: 'thumb', url: thumb.href });
      let preview = fallbackThumb;
      for (const [url, tier] of [[remote.sample, 'sample'], [remote.full, 'full']]) {
        try {
          const image = new URL(url);
          if (image.protocol === 'https:' && !image.username && !image.password && !image.port
            && providerRegistry.matchesDeclaration?.(descriptor.hosts, 'image', image.href)) {
            preview = mediaProxy.buildUrl({ provider: ref.provider, tier, url: image.href });
            break;
          }
        } catch { /* A missing or invalid large preview falls back to the thumbnail. */ }
      }
      for (const [token, value] of visualTokens) if (value.expires <= clock()) visualTokens.delete(token);
      while (visualTokens.size >= 16) visualTokens.delete(visualTokens.keys().next().value);
      const token = crypto.randomUUID();
      visualTokens.set(token, { id, owner, snapshot, result, key, outcome, expires: clock() + 5 * 60000 });
      return {
        status: 'candidate', token, page: ref.page, similarity: candidate.similarity, provider: ref.provider,
        sourceName: descriptor.name || ref.provider,
        original: `data:${mime};base64,${bytes.toString('base64')}`,
        thumb: preview, fallbackThumb,
        blur: contentRating.hidden(rating, getConfig().contentBlur),
      };
    }, METADATA_MANUAL_PRIORITY); } finally { visualPending.delete(id); }
  }

  async function applyVisual(id, token, owner, accept) {
    const pending = typeof token === 'string' && visualTokens.get(token);
    if (!pending || pending.id !== id || pending.owner !== owner) return { status: 'error', reason: 'denied' };
    visualTokens.delete(token);
    // null/unspecified is dismissal (Escape); only explicit false rejects a match.
    if (accept !== true && accept !== false) return { status: 'cancelled', reason: 'dismissed' };
    if (pending.expires <= clock() || !(await itemIdentityUnchanged(id, pending.snapshot))) return { status: 'error', reason: 'changed' };
    const current = library.getItem(getConfig().library, id);
    if (!current || !isAuthorizedItemPath(current.path)) return { status: 'error', reason: 'denied' };
    if (isMoveRunning()) return { status: 'error', reason: libraryFreeze.MOVE_RUNNING };
    const outcome = metadataCacheStore().lookups[pending.key];
    if (outcome !== pending.outcome || outcome.rejected === true) return { status: 'error', reason: 'changed' };
    if (accept === false) {
      outcome.rejected = true;
      markMetadataDirty();
      return { status: 'cancelled' };
    }
    return metadataLookupReply({ status: 'found', result: pending.result }, applyLookupToItem(id, pending.result));
  }

  return Object.freeze({
    // Manual, explicit, one at a time — the button the user pressed.
    lookupItem: runItemMetadataLookup,
    visualItem,
    applyVisual,
    // LIB-030. The background library pass reads fingerprints through the same cache, so
    // a file is hashed once for every check that needs it — never into a second cache
    // with a second writer to the same file.
    fingerprint: (filePath) => fingerprintForFile(filePath, 'md5'),
    cachedFingerprint: (filePath) => cachedFingerprintForFile(filePath, 'md5'),
    // On quit: losing the journal costs no user data, but it does cost the memory of
    // which catalogues were already asked.
    flush: () => metadataWriter.flush(),
    dispose: () => metadataWriter.dispose(),
    // For main's test hooks only.
    cache: () => metadataCacheStore(),
    askProvider: askProviderForFingerprint,
    credentials: metadataCredentials,
    setBudget: (cfg) => { metadataBudgetConfig = cfg || null; metadataBudgets.clear(); },
  });
}

module.exports = { create, postMatchesHash };
