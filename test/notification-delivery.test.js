'use strict';

const assert = require('assert');
const { createNotificationDelivery } = require('../src/notification-delivery');

let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  OK ' + name);
  passed++;
};

let shown = 0;
let clicked = 0;
let options = null;
class FakeNotification {
  static isSupported() { return true; }
  constructor(value) { options = value; }
  on(name, handler) { if (name === 'click') this.click = handler; }
  show() { shown++; if (this.click) this.click(); }
}

const deliver = createNotificationDelivery({
  NotificationClass: FakeNotification,
  translate: (key) => `t:${key}`,
  onClick: () => { clicked++; },
});
const success = deliver({ titleKey: 'notify.testTitle', bodyKey: 'notify.testBody' });
ok('supported notification is translated, shown and clickable',
  success.ok && shown === 1 && clicked === 1
  && options.title === 't:notify.testTitle' && options.body === 't:notify.testBody');

class UnsupportedNotification {
  static isSupported() { return false; }
}
const unsupported = createNotificationDelivery({ NotificationClass: UnsupportedNotification })({
  titleKey: 'x', bodyKey: 'y',
});
ok('unsupported Windows notification API returns a stable reason',
  !unsupported.ok && unsupported.reason === 'unsupported');

let logged = '';
class BrokenNotification {
  static isSupported() { return true; }
  constructor() { throw new Error('boom'); }
}
const failed = createNotificationDelivery({
  NotificationClass: BrokenNotification,
  logError: (err) => { logged = err.message; },
})({ titleKey: 'x', bodyKey: 'y' });
ok('delivery exceptions are contained and reported',
  !failed.ok && failed.reason === 'show-failed' && logged === 'boom');

const missing = createNotificationDelivery({ NotificationClass: null })({});
ok('missing Notification implementation is unsupported',
  !missing.ok && missing.reason === 'unsupported');

console.log('\nAll ' + passed + ' notification-delivery tests passed.');
