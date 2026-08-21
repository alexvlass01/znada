'use strict';

const assert = require('assert');
const { instrumentIpcMain } = require('../diagnostics/main/ipc-instrumentation');

let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  OK ' + name);
  passed++;
};

function fakeIpcMain() {
  const handlers = new Map();
  const calls = [];
  return {
    handlers,
    calls,
    handle(channel, handler) {
      calls.push({ thisValue: this, channel, handler });
      if (handlers.has(channel)) throw new Error('Attempted to register a second handler for ' + channel);
      handlers.set(channel, handler);
      return 'registered:' + channel;
    },
  };
}

function recorder(nowRef) {
  const events = [];
  return {
    events,
    now: () => nowRef.value,
    record: (event) => events.push(event),
  };
}

(async () => {
  {
    const ipcMain = fakeIpcMain();
    const nowRef = { value: 100 };
    let recordCalled = false;
    const wrapped = instrumentIpcMain(ipcMain, {
      enabled: false,
      now: () => nowRef.value,
      record: () => { recordCalled = true; },
    });
    ok('disabled instrumentation returns the original ipcMain object', wrapped === ipcMain);
    ok('disabled instrumentation keeps the original handle function', wrapped.handle === ipcMain.handle);
    wrapped.handle('plain', () => 'ok');
    const result = ipcMain.handlers.get('plain')('event');
    ok('disabled instrumentation does not intercept registered handlers', result === 'ok' && !recordCalled);
  }

  {
    const ipcMain = fakeIpcMain();
    const nowRef = { value: 1000 };
    const clock = recorder(nowRef);
    const wrapped = instrumentIpcMain(ipcMain, { enabled: true, now: clock.now, record: clock.record });
    const registerResult = wrapped.handle('sync-return', function handler(event, a, b) {
      nowRef.value = 1025;
      return { thisValue: this, event, sum: a + b };
    });
    ok('enabled instrumentation preserves original duplicate-registration return value',
      registerResult === 'registered:sync-return');
    ok('enabled instrumentation registers through the original ipcMain.handle',
      ipcMain.calls[0].thisValue === ipcMain);
    const thisValue = { marker: 'original-this' };
    const result = ipcMain.handlers.get('sync-return').call(thisValue, 'evt', 2, 3);
    ok('sync return is transparent and preserves original this/arguments',
      result.thisValue === thisValue && result.event === 'evt' && result.sum === 5);
    ok('sync return records one IPC span without payload',
      clock.events.length === 1 &&
      clock.events[0].category === 'ipc' &&
      clock.events[0].name === 'sync-return' &&
      clock.events[0].durationMs === 25 &&
      clock.events[0].attributes.status === 'ok' &&
      clock.events[0].attributes.valueKind === 'object' &&
      !JSON.stringify(clock.events[0]).includes('original-this') &&
      !JSON.stringify(clock.events[0]).includes('evt'));
  }

  {
    const ipcMain = fakeIpcMain();
    const nowRef = { value: 2000 };
    const rec = recorder(nowRef);
    const wrapped = instrumentIpcMain(ipcMain, { enabled: true, now: rec.now, record: rec.record });
    const expected = new TypeError('private failure text');
    wrapped.handle('sync-throw', () => {
      nowRef.value = 2017;
      throw expected;
    });
    let thrown = null;
    try {
      ipcMain.handlers.get('sync-throw')('secret payload');
    } catch (err) {
      thrown = err;
    }
    ok('sync throw rethrows the original error object', thrown === expected);
    ok('sync throw records error class but not message or payload',
      rec.events.length === 1 &&
      rec.events[0].attributes.status === 'error' &&
      rec.events[0].attributes.reason === 'TypeError' &&
      !JSON.stringify(rec.events[0]).includes('private failure text') &&
      !JSON.stringify(rec.events[0]).includes('secret payload'));
  }

  {
    const ipcMain = fakeIpcMain();
    const nowRef = { value: 3000 };
    const rec = recorder(nowRef);
    const wrapped = instrumentIpcMain(ipcMain, { enabled: true, now: rec.now, record: rec.record });
    wrapped.handle('async-resolve', async () => {
      nowRef.value = 3060;
      return 'done';
    });
    const result = await ipcMain.handlers.get('async-resolve')('event');
    ok('async resolve returns the resolved value', result === 'done');
    ok('async resolve records after the promise settles',
      rec.events.length === 1 &&
      rec.events[0].durationMs === 60 &&
      rec.events[0].attributes.status === 'ok' &&
      rec.events[0].attributes.valueKind === 'string');
  }

  {
    const ipcMain = fakeIpcMain();
    const nowRef = { value: 4000 };
    const rec = recorder(nowRef);
    const wrapped = instrumentIpcMain(ipcMain, { enabled: true, now: rec.now, record: rec.record });
    const expected = new RangeError('hidden async reason');
    wrapped.handle('async-reject', async () => {
      nowRef.value = 4042;
      throw expected;
    });
    let rejected = null;
    try {
      await ipcMain.handlers.get('async-reject')('large-payload');
    } catch (err) {
      rejected = err;
    }
    ok('async reject rejects with the original error object', rejected === expected);
    ok('async reject records error class only',
      rec.events.length === 1 &&
      rec.events[0].durationMs === 42 &&
      rec.events[0].attributes.status === 'error' &&
      rec.events[0].attributes.reason === 'RangeError' &&
      !JSON.stringify(rec.events[0]).includes('hidden async reason') &&
      !JSON.stringify(rec.events[0]).includes('large-payload'));
  }

  {
    const ipcMain = fakeIpcMain();
    const nowRef = { value: 5000 };
    const rec = recorder(nowRef);
    const wrapped = instrumentIpcMain(ipcMain, {
      enabled: true,
      now: rec.now,
      record: rec.record,
      denyList: ['diagnostics-record'],
      muteList: [/^thumb/],
    });
    wrapped.handle('diagnostics-record', () => 'denied');
    wrapped.handle('thumb', () => 'muted');
    wrapped.handle('visible', () => 'tracked');
    ipcMain.handlers.get('diagnostics-record')();
    ipcMain.handlers.get('thumb')();
    ipcMain.handlers.get('visible')();
    ok('deny and mute lists keep handlers working while skipping spans',
      rec.events.length === 1 && rec.events[0].name === 'visible');
  }

  {
    const ipcMain = fakeIpcMain();
    const wrapped = instrumentIpcMain(ipcMain, { enabled: true });
    wrapped.handle('duplicate', () => 'first');
    let duplicateError = null;
    try {
      wrapped.handle('duplicate', () => 'second');
    } catch (err) {
      duplicateError = err;
    }
    ok('duplicate registration semantics come from the original ipcMain.handle',
      duplicateError && /second handler/.test(duplicateError.message));
    ok('duplicate registration does not replace the first handler',
      ipcMain.handlers.get('duplicate')() === 'first');
  }

  console.log('\nAll ' + passed + ' diagnostics IPC instrumentation tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
