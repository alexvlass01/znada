'use strict';

// SEC-002, slice 3 (the half that needs nothing from the backend).
//
// Signing in opens a listener on 127.0.0.1 and sends the user to the browser. Three
// things about that were loose:
//
//   * pressing sign-in twice opened TWO listeners and TWO browser tabs, and neither
//     answer could be tied to the press that asked for it;
//   * the listener accepted any request carrying a `code`, by any method, from any
//     origin able to reach the port - and a loopback port is reachable by every program
//     on the machine, and by any page a browser can be made to fetch;
//   * a sign-in nobody finished held its socket and its five-minute timer, including
//     through quit.
//
// The requests below are REAL requests to the real listener, not calls to the parsing
// rule. The rule is unit-tested separately in test/cloud-oauth.test.js; what this file
// proves is that the listener actually applies it.
//
// The last of those - proof that the code which arrives belongs to the sign-in this user
// started - needed something to send and get back, and the service side added it: an
// opaque value sent at the start and echoed on the redirect. PKCE alone never answered
// this, because the challenge travels in the address bar of the system browser: anyone
// who reads it can start a flow of their own with the same challenge, sign in as
// themselves and hand this listener their code. The exchange would succeed and the user
// would quietly be signed in to a stranger's account (RFC 8252 section 8.9).
//
// Run: node test/cloud-signin-flow.test.js

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const H = require('./helpers/main-harness');

let passed = 0;
const failures = [];

async function test(name, fn) {
  const dir = H.makeTempProfile('cloud-signin');
  const captured = [];
  const real = { log: console.log, error: console.error };
  const realFetch = globalThis.fetch;
  console.log = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  try {
    await fn(dir);
    console.log = real.log; console.error = real.error;
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log = real.log; console.error = real.error;
    failures.push({ name, err, captured });
    console.log(`  ✗ ${name}\n      ${err && err.message}`);
  } finally {
    console.log = real.log; console.error = real.error;
    globalThis.fetch = realFetch;
    try { H.unloadMain(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function start(dir, options = {}) {
  H.writeJson(path.join(dir, 'config.json'), { autoSwitch: true, style: 'fill', monitors: {} });
  H.writeJson(path.join(dir, 'config.library.json'), { version: 1, library: {}, trash: [] });
  const m = H.loadMain(dir, options);
  m.__test.loadConfig();
  return m;
}

const TOKEN_A = 'A'.repeat(43);
const TOKEN_B = 'B'.repeat(43);
const USER_A = {
  id: 'user-a', display_name: 'Alice', email: null, role: 'user',
  explicit_opt_in: false, created_at: 1700000000,
};
const USER_B = {
  id: 'user-b', display_name: 'Bob', email: null, role: 'user',
  explicit_opt_in: true, created_at: 1700000001,
};
const TEST_SAFE_STORAGE = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
  decryptString: (value) => String(value).replace(/^protected:/, ''),
};
const DOWNLOAD_BYTES = Buffer.from('cloud-download-body');
const DOWNLOAD_HASH = crypto.createHash('md5').update(DOWNLOAD_BYTES).digest('hex').slice(0, 16);
const DOWNLOAD_URL = 'https://storage.example.test/wallpaper.jpg';

function jsonResponse(status, body) {
  return {
    status,
    text: async () => body === undefined ? '' : JSON.stringify(body),
  };
}

function successfulSigninFetch(token = TOKEN_A, user = USER_A) {
  return async (url) => {
    if (String(url).endsWith('/v1/auth/exchange')) {
      return jsonResponse(200, { session_token: token, user });
    }
    if (String(url).endsWith('/v1/me')) {
      return jsonResponse(200, { user, entitlements: ['online_catalog'] });
    }
    throw new Error(`unexpected Cloud request: ${url}`);
  };
}

function cloudDownloadFetch() {
  let releaseBody;
  let announceBody;
  const bodyStarted = new Promise((resolve) => { announceBody = resolve; });
  const fetch = async (url) => {
    if (String(url).includes('/v1/content/') && String(url).endsWith('/download')) {
      return jsonResponse(200, { url: DOWNLOAD_URL, expires_at: 1900000000 });
    }
    if (String(url) === DOWNLOAD_URL) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          announceBody();
          await new Promise((resolve) => { releaseBody = resolve; });
          return DOWNLOAD_BYTES;
        },
      };
    }
    throw new Error(`unexpected Cloud request: ${url}`);
  };
  return {
    fetch,
    bodyStarted,
    release: () => {
      if (!releaseBody) throw new Error('download body did not start');
      releaseBody();
    },
  };
}

// Wait for the Nth browser tab, not for any tab: the browser is only opened once the
// listener is up, so this is how a test knows the socket exists. Counting matters -
// waiting on "is the list non-empty" would return instantly on a second attempt because
// the first one already filled it, and the assertion after would measure nothing.
async function untilBrowserOpened(m, count = 1) {
  for (let i = 0; i < 400; i++) {
    if (m.calls.opened.length >= count) return m.calls.opened[count - 1];
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error(`the browser was opened ${m.calls.opened.length} times, expected ${count}`);
}

const portOf = (url) => Number(new URL(url).searchParams.get('port'));
const stateOf = (url) => new URL(url).searchParams.get('state');

// One real request to the listener. `hostHeader` is sent verbatim so a test can pretend
// to be a name that resolved to 127.0.0.1, which is what rebinding looks like on the wire.
function request({ port, method = 'GET', pathname = '/?code=REALCODE', hostHeader }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: hostHeader ? { Host: hostHeader } : undefined,
      timeout: 5000,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

// Never await a sign-in outright: if a guard under test is missing, the call waits for a
// browser that will never come back and the whole run hangs instead of failing.
function withinASecond(promise) {
  return Promise.race([
    promise,
    new Promise((resolve) => { setTimeout(() => resolve({ timedOut: true }), 1500); }),
  ]);
}

(async () => {
  console.log('\nSEC-002 slice 3: one sign-in at a time, on our own port\n');

  await test('a second press is told the first is still going', async (dir) => {
    const m = start(dir);
    const first = m.invoke('cloud-signin');
    first.catch(() => {});
    await untilBrowserOpened(m);
    assert.strictEqual(m.__test.cloudSigninInFlight(), true, 'precondition: one is in flight');

    const second = await withinASecond(m.invoke('cloud-signin'));
    assert.ok(!second.timedOut, 'the second press started a sign-in of its own instead of being refused');
    assert.strictEqual(second.error, 'busy', `expected busy, got ${second.error}`);
    assert.strictEqual(m.calls.opened.length, 1, 'a second browser tab was opened');

    m.__test.cancelCloudSignin();
    await first.catch(() => {});
    assert.strictEqual(m.__test.cloudSigninInFlight(), false, 'the cancelled sign-in stayed in flight');
  });

  await test('once the first ends, signing in is possible again', async (dir) => {
    const m = start(dir);
    const first = m.invoke('cloud-signin');
    first.catch(() => {});
    await untilBrowserOpened(m);
    m.__test.cancelCloudSignin();
    await first.catch(() => {});

    const second = m.invoke('cloud-signin');
    second.catch(() => {});
    await untilBrowserOpened(m, 2);
    m.__test.cancelCloudSignin();
    await second.catch(() => {});
  });

  // Owner QA 2026-08-28: pressing Sign in and then just closing the browser tab left the
  // window saying "Opening your browser…" with no control on it, and a second press
  // answered 'busy' for the full five minutes. The machinery to end it existed and was
  // reachable only from before-quit, which is why quitting was the cure.
  await test('a sign-in nobody finished can be called off from the window', async (dir) => {
    const m = start(dir);
    const attempt = m.invoke('cloud-signin');
    attempt.catch(() => {});
    const url = await untilBrowserOpened(m);
    const port = portOf(url);

    // The abandoned tab is not the only way in: a request the listener REFUSES also
    // leaves it waiting, because the refusal branch neither settles nor cleans up. The
    // exit has to work from there too.
    assert.strictEqual(await request({ port, pathname: '/?code=THEIRS' }), 400);
    assert.strictEqual(m.__test.cloudSigninInFlight(), true, 'precondition: still waiting');

    const answer = await m.invoke('cloud-signin-cancel');
    assert.strictEqual(answer.cancelled, true, 'the cancel did not reach a waiting sign-in');

    const ended = await withinASecond(attempt);
    assert.ok(!ended.timedOut, 'cancelling left the window waiting on the sign-in');
    assert.strictEqual(ended.error, 'cancelled',
      'a sign-in the user called off was reported to the window as a failure');
    assert.strictEqual(m.__test.cloudSigninInFlight(), false);
    await assert.rejects(() => request({ port }), 'the listening socket outlived the cancel');

    // And the user can immediately try again - the whole point of having an exit.
    const second = m.invoke('cloud-signin');
    second.catch(() => {});
    await untilBrowserOpened(m, 2);
    m.__test.cancelCloudSignin();
    await second.catch(() => {});
  });

  await test('cancelling when nothing is running says so rather than pretending', async (dir) => {
    const m = start(dir);
    const answer = await m.invoke('cloud-signin-cancel');
    assert.strictEqual(answer.cancelled, false,
      'the window would show a Cancel that claims to have stopped something');
  });

  await test('the listener is released when the app shuts down', async (dir) => {
    const m = start(dir);
    const attempt = m.invoke('cloud-signin');
    attempt.catch(() => {});
    const url = await untilBrowserOpened(m);
    const port = portOf(url);

    m.__test.disposeForTests(); // exactly what quit does
    // Raced, not awaited: if shutdown stops releasing the sign-in, this promise never
    // settles, and a test that hangs proves nothing - it just looks like a slow run.
    const ended = await withinASecond(attempt.catch(() => 'ended'));
    assert.notStrictEqual(ended && ended.timedOut, true, 'shutdown left the sign-in waiting forever');
    assert.strictEqual(m.__test.cloudSigninInFlight(), false, 'a sign-in survived shutdown');
    // The socket, not just the flag: a closed listener refuses the connection outright.
    await assert.rejects(() => request({ port }), 'the listening socket outlived the app');
  });

  await test('the listener applies its rule to real requests', async (dir) => {
    globalThis.fetch = successfulSigninFetch();
    const m = start(dir, { safeStorage: TEST_SAFE_STORAGE });
    const attempt = m.invoke('cloud-signin');
    attempt.catch(() => {});
    const url = await untilBrowserOpened(m);
    const port = portOf(url);
    const mine = stateOf(url);
    const good = `/?code=REALCODE&state=${mine}`;

    // Everything that is not the browser coming back to us is answered 400 and - the part
    // that matters - does not finish the sign-in.
    assert.strictEqual(await request({ port, method: 'POST', pathname: good }), 400, 'a POST was accepted');
    assert.strictEqual(await request({ port, hostHeader: `localhost:${port}`, pathname: good }), 400,
      'a request naming a hostname was accepted');
    assert.strictEqual(await request({ port, hostHeader: '127.0.0.1:1', pathname: good }), 400,
      'a request naming a different port was accepted');
    assert.strictEqual(await request({ port, pathname: `/?error=denied&state=${mine}` }), 400,
      'a request with no code was accepted');

    // The one this half of the work exists for: a code from somebody else's sign-in.
    assert.strictEqual(await request({ port, pathname: '/?code=THEIRS&state=someone-elses-value' }), 400,
      'a code carrying another sign-in\'s state was accepted');
    assert.strictEqual(await request({ port, pathname: '/?code=THEIRS' }), 400,
      'a code with no state at all was accepted');

    assert.strictEqual(m.__test.cloudSigninInFlight(), true,
      'one of the refused requests still ended the sign-in');

    // ...and the real thing is accepted and does finish it.
    assert.strictEqual(await request({ port, pathname: good }), 200, 'the real redirect was refused');
    const result = await withinASecond(attempt);
    assert.ok(!result.timedOut, 'the accepted redirect did not finish the sign-in');
    assert.strictEqual(result.ok, true, `the accepted sign-in failed with ${result.error}`);
    assert.strictEqual(m.__test.cloudSigninInFlight(), false, 'the sign-in stayed in flight after its code');
  });

  await test('the single-flight stays occupied through exchange and profile validation', async (dir) => {
    let releaseExchange;
    let announceExchange;
    let releaseMe;
    let announceMe;
    const exchangeStarted = new Promise((resolve) => { announceExchange = resolve; });
    const meStarted = new Promise((resolve) => { announceMe = resolve; });
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/v1/auth/exchange')) {
        announceExchange();
        return new Promise((resolve) => { releaseExchange = () => resolve(jsonResponse(200, {
          session_token: TOKEN_A, user: USER_A,
        })); });
      }
      if (String(url).endsWith('/v1/me')) {
        announceMe();
        return new Promise((resolve) => { releaseMe = () => resolve(jsonResponse(200, {
          user: USER_A, entitlements: ['online_catalog'],
        })); });
      }
      throw new Error(`unexpected Cloud request: ${url}`);
    };

    const m = start(dir, { safeStorage: TEST_SAFE_STORAGE });
    const first = m.invoke('cloud-signin');
    first.catch(() => {});
    const opened = await untilBrowserOpened(m);
    const port = portOf(opened);
    const state = stateOf(opened);
    assert.strictEqual(await request({ port, pathname: `/?code=REALCODE&state=${state}` }), 200);

    try {
      const assertBusy = async (phase) => {
        assert.strictEqual(m.__test.cloudSigninInFlight(), true,
          `the sign-in slot was released while ${phase} was pending`);
        const second = await withinASecond(m.invoke('cloud-signin'));
        assert.ok(!second.timedOut, `a second sign-in opened while ${phase} was pending`);
        assert.strictEqual(second.error, 'busy', `expected busy during ${phase}, got ${second.error}`);
        assert.strictEqual(m.calls.opened.length, 1, `a second browser tab was opened during ${phase}`);
      };

      await exchangeStarted;
      await assertBusy('exchange');
      releaseExchange();
      await meStarted;
      await assertBusy('/me');
    } finally {
      if (releaseExchange) releaseExchange();
      if (releaseMe) releaseMe();
    }

    const result = await withinASecond(first);
    assert.strictEqual(result.ok, true, `the first sign-in failed with ${result.error}`);
    assert.strictEqual(m.__test.cloudSigninInFlight(), false,
      'the sign-in slot was not released after exchange and /me completed');
  });

  await test('/me 401 rejects the candidate token without publishing or persisting it', async (dir) => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/v1/auth/exchange')) {
        return jsonResponse(200, { session_token: TOKEN_A, user: USER_A });
      }
      if (String(url).endsWith('/v1/me')) {
        return jsonResponse(401, { error: { code: 'unauthorized', message: 'session rejected' } });
      }
      throw new Error(`unexpected Cloud request: ${url}`);
    };
    const m = start(dir, { safeStorage: TEST_SAFE_STORAGE });
    const attempt = m.invoke('cloud-signin');
    const opened = await untilBrowserOpened(m);
    assert.strictEqual(await request({
      port: portOf(opened),
      pathname: `/?code=REALCODE&state=${stateOf(opened)}`,
    }), 200);

    const result = await withinASecond(attempt);
    assert.ok(!result.timedOut, 'the rejected candidate left sign-in pending');
    assert.strictEqual(result.ok, false, 'a token rejected by /me was reported as signed in');
    assert.strictEqual(result.error, 'unauthorized');
    assert.strictEqual(m.__test.cloudAuthState().signedIn, false,
      'the rejected candidate became the live session');
    assert.strictEqual(fs.existsSync(path.join(dir, 'cloud-session.bin')), false,
      'the rejected candidate was persisted before /me validated it');
  });

  await test('any failed /me leaves the previous live and persisted session untouched', async (dir) => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/v1/auth/exchange')) {
        return jsonResponse(200, { session_token: TOKEN_A, user: USER_A });
      }
      if (String(url).endsWith('/v1/me')) {
        return jsonResponse(500, { error: { code: 'server_error', message: 'profile unavailable' } });
      }
      throw new Error(`unexpected Cloud request: ${url}`);
    };
    const m = start(dir, { safeStorage: TEST_SAFE_STORAGE });
    m.__test.setCloudSession(TOKEN_B, { user: USER_B, entitlements: ['online_catalog'] }, true);
    const attempt = m.invoke('cloud-signin');
    const opened = await untilBrowserOpened(m);
    assert.strictEqual(await request({
      port: portOf(opened),
      pathname: `/?code=REALCODE&state=${stateOf(opened)}`,
    }), 200);

    const result = await withinASecond(attempt);
    assert.ok(!result.timedOut, 'the failed profile read left sign-in pending');
    assert.strictEqual(result.ok, false, 'a candidate with no validated profile became live');
    assert.strictEqual(result.error, 'server_error');
    assert.strictEqual(m.__test.cloudAuthState().user.id, USER_B.id,
      'the failed candidate replaced the previous live account');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'cloud-session.bin'), 'utf8'), `protected:${TOKEN_B}`,
      'the failed candidate replaced the previous persisted bearer');
  });

  await test('an atomic token replace failure keeps the previous live and persisted account', async (dir) => {
    globalThis.fetch = successfulSigninFetch(TOKEN_B, USER_B);
    const m = start(dir, { safeStorage: TEST_SAFE_STORAGE });
    m.__test.setCloudSession(TOKEN_A, { user: USER_A, entitlements: ['old-entitlement'] }, true);
    const tokenFile = path.join(dir, 'cloud-session.bin');
    m.__test.setCloudSessionStorage({
      renameSync: () => {
        const err = new Error('injected atomic replace failure');
        err.code = 'EACCES';
        throw err;
      },
    });

    const attempt = m.invoke('cloud-signin');
    const opened = await untilBrowserOpened(m);
    assert.strictEqual(await request({
      port: portOf(opened),
      pathname: `/?code=REALCODE&state=${stateOf(opened)}`,
    }), 200);
    const result = await withinASecond(attempt);

    assert.ok(!result.timedOut, 'the failed token write left sign-in pending');
    assert.strictEqual(result.ok, false, 'sign-in reported success without durable token replacement');
    assert.strictEqual(result.error, 'storage', 'storage failure crossed IPC as an unsafe/raw error');
    assert.strictEqual(m.__test.cloudAuthState().user.id, USER_A.id,
      'candidate B was published even though its encrypted token was not committed');
    assert.deepStrictEqual(m.__test.cloudAuthState().entitlements, ['old-entitlement']);
    assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), `protected:${TOKEN_A}`,
      'the failed atomic replacement damaged the previous persisted bearer');
    assert.strictEqual(fs.existsSync(`${tokenFile}.tmp`), false,
      'the failed atomic replacement left plaintext-independent encrypted staging debris');
  });

  // This case used to assert the opposite, and the opposite stranded the account.
  //
  // Making the file deletion the commit point meant that a bearer we could not remove —
  // an antivirus holding it, a roaming profile, a locked disk — kept the user signed in
  // to the account he had just left. Every request then failed, and pressing sign-out
  // again failed in exactly the same way, with no way out of it from inside the app.
  //
  // The worry behind the old assertion was real: a leftover token must not sign anybody
  // back in after a restart. The answer is to revoke it on the service rather than to
  // refuse to sign out locally — a revoked token found on disk is inert. So the revoke
  // now happens on this path instead of being skipped along with the deletion.
  await test('sign-out still signs out when the persisted bearer cannot be removed', async (dir) => {
    let logoutCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/v1/auth/logout')) logoutCalls++;
      throw new Error(`unexpected Cloud request: ${url}`);
    };
    const m = start(dir, { safeStorage: TEST_SAFE_STORAGE });
    m.__test.setCloudSession(TOKEN_A, { user: USER_A, entitlements: ['online_catalog'] }, true);
    const tokenFile = path.join(dir, 'cloud-session.bin');
    m.__test.setCloudSessionStorage({
      rmSync: (target, options) => {
        if (path.resolve(target) === path.resolve(tokenFile)) {
          const err = new Error('injected token delete failure');
          err.code = 'EACCES';
          throw err;
        }
        return fs.rmSync(target, options);
      },
    });

    const result = await m.invoke('cloud-signout');
    assert.strictEqual(result.ok, true, 'the user asked to be signed out and was told it failed');
    assert.strictEqual(result.state.signedIn, false,
      'a file that could not be deleted kept the account signed in');
    assert.strictEqual(result.state.user, null);
    assert.strictEqual(m.__test.cloudAuthState().signedIn, false,
      'the app still believes it holds a session nobody can use');
    // The file is still there — that is the condition under test — and it is exactly why
    // the revoke matters.
    assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), `protected:${TOKEN_A}`);
    assert.strictEqual(logoutCalls, 1,
      'the leftover bearer was left valid on the service, so it could sign somebody back in');

    // And the way out exists: a second press behaves the same rather than compounding.
    const again = await m.invoke('cloud-signout');
    assert.strictEqual(again.ok, true, 'signing out twice reported a failure the user cannot act on');
    assert.strictEqual(again.state.signedIn, false);
  });

  await test('a late /me success from an old token cannot overwrite the newer profile', async (dir) => {
    let releaseMe;
    let announceMe;
    const meStarted = new Promise((resolve) => { announceMe = resolve; });
    globalThis.fetch = async (url) => {
      assert.ok(String(url).endsWith('/v1/me'), `unexpected Cloud request: ${url}`);
      announceMe();
      return new Promise((resolve) => { releaseMe = () => resolve(jsonResponse(200, {
        user: USER_A, entitlements: ['old-entitlement'],
      })); });
    };
    const m = start(dir);
    m.__test.setCloudSession(TOKEN_A, null);
    const oldRead = m.invoke('cloud-session');
    await meStarted;
    m.__test.setCloudSession(TOKEN_B, { user: USER_B, entitlements: ['new-entitlement'] });
    releaseMe();
    await oldRead;

    const state = m.__test.cloudAuthState();
    assert.strictEqual(state.signedIn, true);
    assert.strictEqual(state.user.id, USER_B.id, 'the old /me profile replaced the newer account');
    assert.deepStrictEqual(state.entitlements, ['new-entitlement']);
  });

  await test('a late /me 401 from an old token cannot clear the newer session', async (dir) => {
    let releaseMe;
    let announceMe;
    const meStarted = new Promise((resolve) => { announceMe = resolve; });
    globalThis.fetch = async (url) => {
      assert.ok(String(url).endsWith('/v1/me'), `unexpected Cloud request: ${url}`);
      announceMe();
      return new Promise((resolve) => { releaseMe = () => resolve(jsonResponse(401, {
        error: { code: 'unauthorized', message: 'old session expired' },
      })); });
    };
    const m = start(dir, { safeStorage: TEST_SAFE_STORAGE });
    m.__test.setCloudSession(TOKEN_A, null, true);
    const oldRead = m.invoke('cloud-session');
    await meStarted;
    m.__test.setCloudSession(TOKEN_B, { user: USER_B, entitlements: ['online_catalog'] }, true);
    releaseMe();
    await oldRead;

    const state = m.__test.cloudAuthState();
    assert.strictEqual(state.signedIn, true, 'the old 401 signed out the newer account');
    assert.strictEqual(state.user.id, USER_B.id);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'cloud-session.bin'), 'utf8'), `protected:${TOKEN_B}`,
      'the old 401 removed the newer persisted bearer');
  });

  await test('a late favorites success from an old token is not returned as the newer account', async (dir) => {
    let releaseFavorites;
    let announceFavorites;
    const favoritesStarted = new Promise((resolve) => { announceFavorites = resolve; });
    globalThis.fetch = async (url) => {
      assert.ok(String(url).endsWith('/v1/favorites'), `unexpected Cloud request: ${url}`);
      announceFavorites();
      return new Promise((resolve) => { releaseFavorites = () => resolve(jsonResponse(200, {
        items: [{
          id: 'private-to-a', title: 'A favorite', rating: 'general', published_at: 1700000000,
          width: 1920, height: 1080, thumb_url: 'https://example.test/a.jpg',
        }],
      })); });
    };
    const m = start(dir, { safeStorage: TEST_SAFE_STORAGE });
    m.__test.setCloudSession(TOKEN_A, { user: USER_A, entitlements: ['online_catalog'] }, true);
    const oldRead = m.invoke('cloud-favorites');
    await favoritesStarted;
    m.__test.setCloudSession(TOKEN_B, { user: USER_B, entitlements: ['online_catalog'] }, true);
    releaseFavorites();
    const result = await oldRead;

    assert.deepStrictEqual(result.items, [], 'account A favorites were returned under account B');
    assert.strictEqual(result.error, 'session_changed');
    assert.strictEqual(m.__test.cloudAuthState().user.id, USER_B.id);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'cloud-session.bin'), 'utf8'), `protected:${TOKEN_B}`);
  });

  await test('a late catalogue success from an old appSession is not returned under the newer account', async (dir) => {
    let releaseCatalog;
    let announceCatalog;
    const catalogStarted = new Promise((resolve) => { announceCatalog = resolve; });
    globalThis.fetch = async (url) => {
      assert.ok(String(url).includes('/v1/catalog?'), `unexpected Cloud request: ${url}`);
      announceCatalog();
      return new Promise((resolve) => { releaseCatalog = () => resolve(jsonResponse(200, {
        items: [{
          id: 'catalog-a', title: 'For account A', rating: 'general', published_at: 1700000000,
          width: 1920, height: 1080, thumb_url: 'https://example.test/catalog-a.jpg',
        }],
        next_cursor: null,
      })); });
    };
    const m = start(dir);
    const descriptor = require('../src/provider-registry').byId('znada');
    m.__test.setCloudSession(TOKEN_A, { user: USER_A, entitlements: ['online_catalog'] });
    const oldSearch = m.__test.searchOneProvider(descriptor, {
      q: '', purity: { sfw: true, sketchy: false, nsfw: false }, limit: 1,
    });
    await catalogStarted;
    m.__test.setCloudSession(TOKEN_B, { user: USER_B, entitlements: ['online_catalog'] });
    releaseCatalog();
    const result = await oldSearch;

    assert.deepStrictEqual(result.items, [], 'account A catalogue was returned under account B');
    assert.strictEqual(result.error, 'session_changed');
    assert.strictEqual(m.__test.cloudAuthState().user.id, USER_B.id);
  });

  for (const target of [
    {
      name: 'Cloud add',
      directory: 'wallpapers',
      invoke: (m) => m.invoke('cloud-add', { id: 'cloud-download', width: 1920, height: 1080 }),
    },
    {
      name: 'Cloud card export',
      directory: 'export-cache',
      invoke: (m) => m.invoke('card-copy-file', {
        kind: 'cloud', id: '', item: { id: 'cloud-download' },
      }),
    },
  ]) {
    await test(`${target.name} removes an artifact it created when the body finishes under a newer session`, async (dir) => {
      const net = cloudDownloadFetch();
      globalThis.fetch = net.fetch;
      const m = start(dir);
      m.__test.setCloudSession(TOKEN_A, { user: USER_A, entitlements: ['online_catalog'] });
      const pending = target.invoke(m);
      await net.bodyStarted;
      m.__test.setCloudSession(TOKEN_B, { user: USER_B, entitlements: ['online_catalog'] });
      net.release();
      const result = await pending;
      const artifact = path.join(dir, target.directory, `wp-${DOWNLOAD_HASH}.jpg`);

      assert.strictEqual(result.error, 'session_changed', 'the stale operation was reported as current');
      assert.strictEqual(fs.existsSync(artifact), false,
        'a rejected stale operation leaked the file it alone created');
      assert.strictEqual(m.__test.cloudAuthState().user.id, USER_B.id);
    });

    await test(`${target.name} never removes a pre-existing deduplicated artifact on session change`, async (dir) => {
      const artifact = path.join(dir, target.directory, `wp-${DOWNLOAD_HASH}.jpg`);
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(artifact, DOWNLOAD_BYTES);
      const before = fs.readFileSync(artifact);
      const net = cloudDownloadFetch();
      globalThis.fetch = net.fetch;
      const m = start(dir);
      m.__test.setCloudSession(TOKEN_A, { user: USER_A, entitlements: ['online_catalog'] });
      const pending = target.invoke(m);
      await net.bodyStarted;
      m.__test.setCloudSession(TOKEN_B, { user: USER_B, entitlements: ['online_catalog'] });
      net.release();
      const result = await pending;

      assert.strictEqual(result.error, 'session_changed');
      assert.strictEqual(fs.existsSync(artifact), true,
        'cleanup deleted a dedup file that existed before this operation');
      assert.deepStrictEqual(fs.readFileSync(artifact), before,
        'cleanup replaced or changed the pre-existing dedup file');
      assert.strictEqual(m.__test.cloudAuthState().user.id, USER_B.id);
    });
  }

  await test('a stale staged duplicate cannot delete the artifact a current operation adopted', async (dir) => {
    globalThis.fetch = async (url) => {
      assert.strictEqual(String(url), DOWNLOAD_URL);
      return { ok: true, status: 200, arrayBuffer: async () => DOWNLOAD_BYTES };
    };
    const m = start(dir);
    const targetDir = path.join(dir, 'wallpapers');

    // Both operations finish the body before either owns the content-addressed final
    // path. The current one commits; discarding the stale one may remove only its own
    // staging file, never the shared destination it can now see.
    const stale = await m.__test.stageDownloadArtifact(targetDir, DOWNLOAD_URL);
    const current = await m.__test.stageDownloadArtifact(targetDir, DOWNLOAD_URL);
    assert.strictEqual(fs.existsSync(current.path), false,
      'a body became globally visible before its operation committed it');
    const adopted = m.__test.commitDownloadArtifact(current, targetDir);
    m.__test.discardDownloadArtifact(stale, targetDir);

    assert.strictEqual(fs.existsSync(adopted.path), true,
      'stale cleanup deleted the path a current operation had adopted');
    assert.deepStrictEqual(fs.readFileSync(adopted.path), DOWNLOAD_BYTES);
  });

  await test('a provider auth callback is bound to the token it handed out', async (dir) => {
    const m = start(dir, { safeStorage: TEST_SAFE_STORAGE });
    const descriptor = require('../src/provider-registry').byId('znada');
    m.__test.setCloudSession(TOKEN_A, { user: USER_A, entitlements: [] }, true);
    const oldProviderSession = m.__test.providerCredentials(descriptor);
    assert.strictEqual(oldProviderSession.token, TOKEN_A, 'precondition: provider received token A');

    m.__test.setCloudSession(TOKEN_B, { user: USER_B, entitlements: ['online_catalog'] }, true);
    oldProviderSession.onAuthError({
      ok: false,
      error: { code: 'unauthorized', status: 401, kind: 'api' },
    });

    const state = m.__test.cloudAuthState();
    assert.strictEqual(state.signedIn, true, 'token A callback cleared token B');
    assert.strictEqual(state.user.id, USER_B.id);
    assert.strictEqual(m.__test.providerCredentials(descriptor).token, TOKEN_B,
      'the newer bearer token disappeared after the old callback');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'cloud-session.bin'), 'utf8'), `protected:${TOKEN_B}`,
      'the old callback removed the newer persisted bearer');

    const currentProviderSession = m.__test.providerCredentials(descriptor);
    currentProviderSession.onAuthError({
      ok: false,
      error: { code: 'unauthorized', status: 401, kind: 'api' },
    });
    assert.strictEqual(m.__test.cloudAuthState().signedIn, false,
      'a 401 for the current bearer was ignored along with the stale one');
    assert.strictEqual(fs.existsSync(path.join(dir, 'cloud-session.bin')), false,
      'the current rejected bearer remained on disk');
  });

  await test('the browser is sent our port, a PKCE challenge and a state of this sign-in', async (dir) => {
    // The positive control: if sign-in never got this far, "no second tab was opened"
    // above would pass by doing nothing at all.
    const m = start(dir);
    const attempt = m.invoke('cloud-signin');
    attempt.catch(() => {});
    const parsed = new URL(await untilBrowserOpened(m));
    assert.ok(parsed.searchParams.get('port'), 'no port was sent');
    assert.ok(parsed.searchParams.get('challenge'), 'no PKCE challenge was sent');
    // This assertion used to say the opposite - that no state was sent - and existed to
    // fire the day the service side made one possible. It did.
    const state = parsed.searchParams.get('state');
    assert.ok(state, 'no state was sent, so nothing ties the answer to this sign-in');
    assert.match(state, /^[A-Za-z0-9_-]{8,128}$/, 'the state is outside what the service accepts');
    m.__test.cancelCloudSignin();
    await attempt.catch(() => {});
  });

  await test('every sign-in gets a state of its own', async (dir) => {
    // Reusing one would defeat the point: an answer to a previous attempt would still fit.
    const m = start(dir);
    const first = m.invoke('cloud-signin');
    first.catch(() => {});
    const one = stateOf(await untilBrowserOpened(m));
    m.__test.cancelCloudSignin();
    await first.catch(() => {});

    const second = m.invoke('cloud-signin');
    second.catch(() => {});
    const two = stateOf(await untilBrowserOpened(m, 2));
    m.__test.cancelCloudSignin();
    await second.catch(() => {});

    assert.notStrictEqual(one, two, 'the same state was reused for a second sign-in');
  });

  // -------------------------------------------------------------------------
  // BUG-031. A window created while a sign-in was running knew nothing about it.
  // "Signing in" lived only in the renderer that pressed the button, and main announced
  // account changes but never that a sign-in had started or ended. A new window drew a
  // plain Sign in button beside a sign-in already holding the port: pressing it answered
  // 'busy', and a Cancel for the running one existed nowhere.
  // -------------------------------------------------------------------------
  const SAFE_STATE_KEYS = ['available', 'entitlements', 'signedIn', 'signinCancellable', 'signingIn', 'user'];
  const assertRendererSafe = (payload, secrets, where) => {
    assert.deepStrictEqual(Object.keys(payload).sort(), SAFE_STATE_KEYS,
      `${where} carries fields beyond the renderer-safe set`);
    const text = JSON.stringify(payload);
    for (const secret of secrets.filter(Boolean)) {
      assert.ok(!text.includes(secret), `${where} carries a sign-in secret`);
    }
  };
  // The harness never creates a window, so a broadcast used to go nowhere. This stand-in
  // records what an open window would be told.
  const windowLog = (m) => {
    const sent = [];
    m.__test.useMainWindow({
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => { if (channel === 'cloud-session-changed') sent.push(payload); } },
    });
    return sent;
  };

  await test('a window opened during sign-in is told it is running and can be called off', async (dir) => {
    const m = start(dir);
    const attempt = m.invoke('cloud-signin');
    attempt.catch(() => {});
    const url = new URL(await untilBrowserOpened(m));
    const secrets = [url.searchParams.get('state'), url.searchParams.get('challenge')];

    // A freshly created window asks exactly this on its first look at the Online tab.
    const seen = await m.invoke('cloud-session');
    assert.strictEqual(seen.signingIn, true, 'a new window was not told a sign-in is running');
    assert.strictEqual(seen.signinCancellable, true,
      'a new window was not told the running sign-in can still be called off');
    assertRendererSafe(seen, secrets, 'the session answer');
    // Asking must never become a second attempt.
    await m.invoke('cloud-session');
    assert.strictEqual(m.calls.opened.length, 1, 'opening a window started a second sign-in');
    assert.strictEqual(m.__test.cloudSigninInFlight(), true);

    // The Cancel that window now draws reaches the running sign-in...
    const answer = await m.invoke('cloud-signin-cancel');
    assert.strictEqual(answer.cancelled, true);
    assert.ok(!(await withinASecond(attempt)).timedOut, 'the cancelled sign-in did not end');
    // ...and afterwards nobody is told a sign-in that has ended is still running.
    const after = await m.invoke('cloud-session');
    assert.strictEqual(after.signingIn, false, 'the ended sign-in is still reported as running');
    assert.strictEqual(after.signinCancellable, false);
  });

  await test('open windows hear a sign-in start, lose its Cancel at the redirect, and end', async (dir) => {
    let releaseExchange;
    let announceExchange;
    const exchangeStarted = new Promise((resolve) => { announceExchange = resolve; });
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/v1/auth/exchange')) {
        announceExchange();
        return new Promise((resolve) => { releaseExchange = () => resolve(jsonResponse(200, {
          session_token: TOKEN_A, user: USER_A,
        })); });
      }
      if (String(url).endsWith('/v1/me')) return jsonResponse(200, { user: USER_A, entitlements: ['online_catalog'] });
      throw new Error(`unexpected Cloud request: ${url}`);
    };
    const m = start(dir, { safeStorage: TEST_SAFE_STORAGE });
    const sent = windowLog(m);
    const attempt = m.invoke('cloud-signin');
    attempt.catch(() => {});
    const url = await untilBrowserOpened(m);
    const secrets = [TOKEN_A, stateOf(url), new URL(url).searchParams.get('challenge')];
    const latest = () => sent[sent.length - 1] || {};

    assert.strictEqual(latest().signingIn, true, 'the start of a sign-in was not announced');
    assert.strictEqual(latest().signinCancellable, true, 'the start of a sign-in was announced without its Cancel');

    try {
      assert.strictEqual(await request({ port: portOf(url), pathname: `/?code=REALCODE&state=${stateOf(url)}` }), 200);
      await exchangeStarted;
      // Past the redirect the exchange cannot be called back, so a Cancel drawn now would
      // silently do nothing.
      assert.strictEqual(latest().signingIn, true, 'the exchange phase was announced as finished');
      assert.strictEqual(latest().signinCancellable, false,
        'windows kept a Cancel that can no longer stop anything');
      const late = await m.invoke('cloud-session');
      assert.strictEqual(late.signingIn, true, 'a window opened during the exchange was not told');
      assert.strictEqual(late.signinCancellable, false);
    } finally {
      if (releaseExchange) releaseExchange();
    }

    const result = await withinASecond(attempt);
    assert.strictEqual(result.ok, true, `the sign-in failed with ${result.error}`);
    assert.strictEqual(latest().signingIn, false, 'the end of a successful sign-in was never announced');
    assert.strictEqual(latest().signedIn, true);
    // The pressing window stores this answer. Described from inside the transaction, it
    // would redraw a sign-in that has already ended over the announcement that it had.
    assert.strictEqual(result.state.signingIn, false,
      'the sign-in reply describes the slot before this sign-in released it');
    sent.forEach((payload, i) => assertRendererSafe(payload, secrets, `announcement ${i + 1}`));
    assertRendererSafe(result.state, secrets, 'the sign-in reply');
  });

  // Timeout is not driven here: its five-minute timer rejects the same promise a cancel
  // does and ends in the same finally, and no seam exists to shorten it.
  for (const ending of [
    {
      name: 'a refused exchange',
      error: 'server_error',
      fetch: async (url) => {
        if (String(url).endsWith('/v1/auth/exchange')) {
          return jsonResponse(500, { error: { code: 'server_error', message: 'exchange unavailable' } });
        }
        throw new Error(`unexpected Cloud request: ${url}`);
      },
      finish: async (m, url) => {
        assert.strictEqual(await request({ port: portOf(url), pathname: `/?code=REALCODE&state=${stateOf(url)}` }), 200);
      },
    },
    { name: 'a cancel', error: 'cancelled', finish: async (m) => { await m.invoke('cloud-signin-cancel'); } },
  ]) {
    await test(`open windows are told the sign-in ended after ${ending.name}`, async (dir) => {
      if (ending.fetch) globalThis.fetch = ending.fetch;
      const m = start(dir);
      const sent = windowLog(m);
      const attempt = m.invoke('cloud-signin');
      attempt.catch(() => {});
      const url = await untilBrowserOpened(m);
      await ending.finish(m, url);
      const result = await withinASecond(attempt);
      assert.ok(!result.timedOut, 'the sign-in did not end');
      assert.strictEqual(result.error, ending.error);
      const last = sent[sent.length - 1];
      assert.ok(last && last.signingIn === false && last.signinCancellable === false,
        `open windows still believe a sign-in is running after ${ending.name}`);
      assert.strictEqual((await m.invoke('cloud-session')).signingIn, false);
    });
  }

  await test('the account strip draws the sign-in main reports, with Cancel only while it works', async () => {
    const vm = require('vm');
    const source = fs.readFileSync(path.join(H.ROOT, 'renderer', 'renderer.js'), 'utf8').split('\r\n').join('\n');
    const match = source.match(/function renderCloudAccount\(\) \{[\s\S]*?\n\}/);
    assert.ok(match, 'renderCloudAccount must stay a named renderer function');
    const draw = (auth) => {
      const cancels = [];
      const node = () => ({
        className: '', textContent: '', disabled: false, children: [], listeners: {},
        append(...kids) { this.children.push(...kids); },
        appendChild(kid) { this.children.push(kid); },
        addEventListener(type, fn) { this.listeners[type] = fn; },
      });
      const host = node();
      vm.runInNewContext(`(${match[0]})`, {
        $: () => host,
        document: { createElement: node },
        t: (key) => key,
        CLOUDAUTH: auth,
        cloudAvailable: () => true,
        renderLibraryAccountTrigger: () => {},
        window: { api: { cloudSigninCancel: async () => { cancels.push(true); return { ok: true, cancelled: true }; } } },
        doCloudSignin: () => {},
        doCloudSignout: () => {},
      })();
      return { host, cancels, texts: host.children.map((child) => child.textContent) };
    };
    const signedOut = { available: true, signedIn: false, user: null, entitlements: [] };

    // A new window: it pressed nothing, so only main's answer can tell it.
    const fresh = draw({ state: { ...signedOut, signingIn: true, signinCancellable: true }, fetched: true, signingIn: false });
    assert.deepStrictEqual(fresh.texts, ['online.signingIn', 'online.signinCancel'],
      'a window that did not press Sign in drew no running sign-in');
    await fresh.host.children[1].listeners.click();
    assert.strictEqual(fresh.cancels.length, 1, 'its Cancel did not reach main');

    const exchanging = draw({ state: { ...signedOut, signingIn: true, signinCancellable: false }, fetched: true, signingIn: false });
    assert.deepStrictEqual(exchanging.texts, ['online.signingIn'],
      'a Cancel was drawn for a sign-in past the point where it can be called off');

    const idle = draw({ state: { ...signedOut, signingIn: false, signinCancellable: false }, fetched: true, signingIn: false });
    assert.deepStrictEqual(idle.texts, ['online.signIn']);
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) {
      console.log(`FAILED: ${f.name}`);
      console.log(`  ${f.err && f.err.stack}`);
      if (f.captured.length) console.log(`  --- main.js output ---\n  ${f.captured.join('\n  ')}`);
    }
    process.exit(1);
  }
  // This file opens real listening sockets. One left behind would keep node alive for the
  // five-minute timeout, which reads as a hung run rather than as the defect it is. The
  // assertions above are what prove the sockets were released; this only keeps a failure
  // fast and legible.
  process.exit(0);
})();
