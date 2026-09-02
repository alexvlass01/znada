'use strict';

// SEC-002. Who is allowed to call an IPC channel.
//
// Znada has three windows — the main one, the fullscreen viewer and (in a gated
// diagnostics run) a control panel — and 91 channels between them. Fourteen of those
// channels checked their sender. The other seventy-seven did not, so the viewer could
// drive the whole settings surface, and any frame inside either window could drive
// everything: `event.sender` is the WebContents, which an <iframe> shares with the page
// that embeds it.
//
// Adding a check to seventy-seven handlers is the wrong shape — the seventy-eighth
// would forget. So registration goes through one door that has no default: a channel
// nobody declared cannot be registered at all, and a sender that is not one of our
// windows is refused before the handler runs.
//
// Four questions, and all four have to hold:
//   1. is the sender one of the windows we created?
//   2. is it the TOP frame, rather than something embedded in the page?
//   3. is that frame still on the file we loaded into it?
//   4. is this channel one that window's role is allowed to use?
//
// (3) is the one that is easy to miss. A window that navigated away — or was made to —
// keeps its preload bridge and its WebContents identity; without this it would keep the
// authority of the page it used to be.
//
// No Electron dependency: `ipcMain` is injected, so the real registration path is
// driven directly by tests (see test/ipc-authority.test.js and the harness).

// A frame's URL without the parts a page can change on its own. `location.hash` and a
// query string are not navigation away from the file; comparing them would make the
// check fail for a reason that has nothing to do with authority.
function baseUrl(raw) {
  const value = typeof raw === 'string' ? raw : '';
  if (!value) return '';
  const cut = value.split('#')[0].split('?')[0];
  // Windows file URLs differ in case between what was loaded and what is reported.
  return cut.toLowerCase();
}

/**
 * @param {object} options
 * @param {{ handle: (channel: string, fn: Function) => any }} options.ipcMain
 *   Where handlers are registered. Injected so the real registration path is testable.
 * @param {Record<string, string[]>} options.roles
 *   Channel name to the window roles allowed to call it. A channel absent from this
 *   table cannot be registered at all.
 * @param {{ error?: Function }} [options.log]
 */
function create(options) {
  const { ipcMain, roles, log = console } = options || {};
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('ipc-authority: an ipcMain with handle() is required');
  }
  const table = roles && typeof roles === 'object' ? roles : {};
  // Keyed by WebContents. A Map rather than a WeakMap so `forget` is explicit and a
  // test can count what is still registered: a window that closed and left its entry
  // behind would keep its authority alive for whatever reuses the object.
  const windows = new Map();
  const registered = new Set();
  const denials = [];

  function register(webContents, role, expectedUrl) {
    if (!webContents || typeof role !== 'string' || !role) return false;
    windows.set(webContents, { role, url: baseUrl(expectedUrl) });
    return true;
  }

  function forget(webContents) {
    return windows.delete(webContents);
  }

  // The role of whoever sent this event, or '' when the answer is anything other than
  // "one of our windows, top frame, still on its own page".
  function roleOf(event) {
    if (!event || !event.sender) return '';
    const known = windows.get(event.sender);
    if (!known) return '';
    let frame;
    // Electron throws rather than returning null when the frame is already gone; a
    // sender we cannot ask about is not a sender we trust.
    try { frame = event.senderFrame; } catch { return ''; }
    if (!frame) return '';
    // "Is this the top frame" asked as the property itself: a top-level document has no
    // parent. The obvious alternative — comparing against `sender.mainFrame` — would rest
    // the entire IPC surface on Electron handing back the very same object every time,
    // and being wrong about that does not fail safe, it fails shut: every channel in the
    // app would refuse every call. `parent` cannot false-deny.
    let parent;
    try { parent = frame.parent; } catch { return ''; }
    if (parent) return '';
    if (known.url && baseUrl(frame.url) !== known.url) return '';
    return known.role;
  }

  function allowed(channel, role) {
    const list = table[channel];
    return Array.isArray(list) && list.indexOf(role) !== -1;
  }

  function handle(channel, fn) {
    if (!Array.isArray(table[channel])) {
      // Loud, and at startup rather than on first use: a channel with no declared role
      // would otherwise be registered and then refuse everybody at runtime, which reads
      // like a broken feature instead of a missing declaration.
      throw new Error(`ipc-authority: channel '${channel}' has no declared role`);
    }
    if (registered.has(channel)) {
      throw new Error(`ipc-authority: channel '${channel}' registered twice`);
    }
    registered.add(channel);
    return ipcMain.handle(channel, (event, ...args) => {
      const role = roleOf(event);
      if (!role || !allowed(channel, role)) {
        denials.push({ channel, role });
        if (log && log.error) log.error(`[IPC] refused '${channel}' from ${role || 'an unknown sender'}`);
        // Thrown, not answered with a sentinel: the caller is either a bug or something
        // pretending to be a window, and both deserve to fail loudly rather than get a
        // plausible empty result they might act on.
        throw new Error(`E_IPC_DENIED: ${channel}`);
      }
      return fn(event, ...args);
    });
  }

  return {
    register,
    forget,
    roleOf,
    handle,
    channels: () => [...registered],
    denials: () => denials.slice(),
    trackedWindows: () => windows.size,
  };
}

module.exports = { create, baseUrl };
