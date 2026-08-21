'use strict';

const assert = require('assert');
const hotkey = require('../src/hotkey');

let passed = 0;
function ok(name, fn) {
  fn();
  console.log('  OK ' + name);
  passed++;
}

const key = (code, extra = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...extra });

ok('letters and function keys map to Electron accelerators', () => {
  assert.strictEqual(hotkey.interpretKeydown(key('KeyN', { ctrlKey: true })).accelerator, 'Ctrl+N');
  assert.strictEqual(hotkey.interpretKeydown(key('F24')).accelerator, 'F24');
});

ok('media and volume DOM codes map to Electron names without modifiers', () => {
  assert.strictEqual(hotkey.interpretKeydown(key('MediaTrackNext')).accelerator, 'MediaNextTrack');
  assert.strictEqual(hotkey.interpretKeydown(key('MediaTrackPrevious')).accelerator, 'MediaPreviousTrack');
  assert.strictEqual(hotkey.interpretKeydown(key('AudioVolumeMute')).accelerator, 'VolumeMute');
});

ok('numpad and punctuation use documented Electron key codes', () => {
  assert.strictEqual(hotkey.interpretKeydown(key('Numpad7', { altKey: true })).accelerator, 'Alt+num7');
  assert.strictEqual(hotkey.interpretKeydown(key('Comma', { ctrlKey: true })).accelerator, 'Ctrl+,');
});

ok('Shift-only typing shortcut is rejected while Shift+F key remains valid', () => {
  assert.strictEqual(hotkey.interpretKeydown(key('KeyA', { shiftKey: true })).status, 'invalid');
  assert.strictEqual(hotkey.interpretKeydown(key('F2', { shiftKey: true })).accelerator, 'Shift+F2');
});

ok('modifier-only input stays in recording mode', () => {
  const result = hotkey.interpretKeydown(key('ControlLeft', { ctrlKey: true }));
  assert.deepStrictEqual(result, { status: 'waiting', modifiers: ['Ctrl'], display: 'Ctrl + ...' });
});

ok('main-side policy rejects bare typing, missing keys and unsupported accelerators', () => {
  assert.deepStrictEqual(hotkey.validateAccelerator('A'), { ok: false, error: 'invalid' });
  assert.deepStrictEqual(hotkey.validateAccelerator('Shift+7'), { ok: false, error: 'invalid' });
  assert.deepStrictEqual(hotkey.validateAccelerator('Ctrl'), { ok: false, error: 'invalid' });
  assert.deepStrictEqual(hotkey.validateAccelerator('Ctrl+F25'), { ok: false, error: 'invalid' });
  assert.strictEqual(hotkey.validateAccelerator('Ctrl+Alt+A').ok, true);
  assert.strictEqual(hotkey.validateAccelerator('F24').ok, true);
  assert.strictEqual(hotkey.validateAccelerator('MediaPlayPause').ok, true);
});

function fakeGlobalShortcut() {
  const registered = new Map();
  const calls = [];
  const refused = new Set();
  return {
    calls,
    refused,
    registered,
    suspended: false,
    register(accelerator, callback) {
      calls.push(['register', accelerator]);
      if (refused.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      calls.push(['unregister', accelerator]);
      registered.delete(accelerator);
    },
    setSuspended(value) {
      calls.push(['suspend', !!value]);
      this.suspended = !!value;
    },
  };
}

ok('failed replacement preserves the old active shortcut', () => {
  const globalShortcut = fakeGlobalShortcut();
  const ctl = hotkey.createController({ globalShortcut, onTrigger: () => {}, log: { error() {} } });
  assert.ok(ctl.apply({ enabled: true, shortcut: 'Ctrl+Alt+A' }).ok);
  globalShortcut.refused.add('Ctrl+Alt+B');
  const result = ctl.apply({ enabled: true, shortcut: 'Ctrl+Alt+B' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(ctl.active(), 'Ctrl+Alt+A');
  assert.ok(globalShortcut.registered.has('Ctrl+Alt+A'));
  assert.ok(!globalShortcut.calls.some((call) => call[0] === 'unregister' && call[1] === 'Ctrl+Alt+A'));
});

ok('successful replacement registers new before unregistering old', () => {
  const globalShortcut = fakeGlobalShortcut();
  const ctl = hotkey.createController({ globalShortcut, onTrigger: () => {} });
  ctl.apply({ enabled: true, shortcut: 'Ctrl+A' });
  globalShortcut.calls.length = 0;
  assert.ok(ctl.apply({ enabled: true, shortcut: 'Ctrl+B' }).ok);
  assert.deepStrictEqual(globalShortcut.calls, [['register', 'Ctrl+B'], ['unregister', 'Ctrl+A']]);
  assert.strictEqual(ctl.active(), 'Ctrl+B');
});

ok('same shortcut is a no-op and disabling unregisters it', () => {
  const globalShortcut = fakeGlobalShortcut();
  const ctl = hotkey.createController({ globalShortcut, onTrigger: () => {} });
  ctl.apply({ enabled: true, shortcut: 'Alt+F9' });
  globalShortcut.calls.length = 0;
  assert.strictEqual(ctl.apply({ enabled: true, shortcut: 'Alt+F9' }).changed, false);
  assert.deepStrictEqual(globalShortcut.calls, []);
  ctl.apply({ enabled: false, shortcut: 'Alt+F9' });
  assert.deepStrictEqual(globalShortcut.calls, [['unregister', 'Alt+F9']]);
  assert.strictEqual(ctl.active(), '');
});

ok('registration exception preserves old state', () => {
  const globalShortcut = fakeGlobalShortcut();
  const baseRegister = globalShortcut.register.bind(globalShortcut);
  globalShortcut.register = (accelerator, callback) => {
    if (accelerator === 'Ctrl+X') throw new Error('bad accelerator');
    return baseRegister(accelerator, callback);
  };
  const ctl = hotkey.createController({ globalShortcut, onTrigger: () => {}, log: { error() {} } });
  ctl.apply({ enabled: true, shortcut: 'Ctrl+A' });
  assert.strictEqual(ctl.apply({ enabled: true, shortcut: 'Ctrl+X' }).ok, false);
  assert.strictEqual(ctl.active(), 'Ctrl+A');
});

ok('controller rejects an unsafe or empty enabled shortcut without removing the old one', () => {
  const globalShortcut = fakeGlobalShortcut();
  const ctl = hotkey.createController({ globalShortcut, onTrigger: () => {}, log: { error() {} } });
  assert.ok(ctl.apply({ enabled: true, shortcut: 'Ctrl+Alt+A' }).ok);
  for (const shortcut of ['A', '']) {
    const result = ctl.apply({ enabled: true, shortcut });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'invalid');
    assert.strictEqual(ctl.active(), 'Ctrl+Alt+A');
  }
  assert.ok(globalShortcut.registered.has('Ctrl+Alt+A'));
});

ok('Windows validation rejects macOS-only modifier aliases', () => {
  for (const shortcut of ['Command+A', 'Cmd+A', 'Option+A']) {
    assert.deepStrictEqual(hotkey.validateAccelerator(shortcut), { ok: false, error: 'invalid' });
  }
  assert.strictEqual(hotkey.validateAccelerator('CommandOrControl+A').ok, true);
});

ok('prepared replacement keeps the old shortcut until durable commit and can roll back', () => {
  const globalShortcut = fakeGlobalShortcut();
  const ctl = hotkey.createController({ globalShortcut, onTrigger: () => {} });
  ctl.apply({ enabled: true, shortcut: 'Ctrl+A' });
  const staged = ctl.prepare({ enabled: true, shortcut: 'Ctrl+B' });
  assert.ok(staged.ok);
  assert.ok(globalShortcut.registered.has('Ctrl+A'));
  assert.ok(globalShortcut.registered.has('Ctrl+B'));
  staged.rollback();
  assert.strictEqual(ctl.active(), 'Ctrl+A');
  assert.ok(globalShortcut.registered.has('Ctrl+A'));
  assert.ok(!globalShortcut.registered.has('Ctrl+B'));
  const committed = ctl.prepare({ enabled: true, shortcut: 'Ctrl+C' });
  committed.commit();
  assert.strictEqual(ctl.active(), 'Ctrl+C');
  assert.ok(!globalShortcut.registered.has('Ctrl+A'));
});

ok('recording suspension is explicit and fail-safe on dispose', () => {
  const globalShortcut = fakeGlobalShortcut();
  const ctl = hotkey.createController({ globalShortcut, onTrigger: () => {} });
  assert.deepStrictEqual(ctl.setSuspended(true), { ok: true, suspended: true });
  assert.strictEqual(ctl.suspended(), true);
  ctl.dispose();
  assert.strictEqual(globalShortcut.suspended, false);
});

console.log(`\nAll ${passed} hotkey tests passed.`);

// Keep the end-to-end renderer/preload/main bridge in the same npm test entry.
require('./ipc-contract.test');
