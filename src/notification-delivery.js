'use strict';

// Thin, testable adapter around Electron's Notification API. Policy (whether a
// failure should notify, edge dedup, journal writes) stays in main.js; this module
// answers the separate acceptance question: can Znada ask Windows to show it?
function createNotificationDelivery({ NotificationClass, translate, onClick, logError } = {}) {
  const t = typeof translate === 'function' ? translate : (key) => String(key || '');
  const clicked = typeof onClick === 'function' ? onClick : null;
  const reportError = typeof logError === 'function' ? logError : () => {};

  return function deliver({ titleKey, bodyKey } = {}) {
    try {
      if (!NotificationClass || typeof NotificationClass.isSupported !== 'function'
        || !NotificationClass.isSupported()) {
        return { ok: false, reason: 'unsupported' };
      }
      const note = new NotificationClass({ title: t(titleKey), body: t(bodyKey) });
      if (clicked && note && typeof note.on === 'function') note.on('click', clicked);
      if (!note || typeof note.show !== 'function') return { ok: false, reason: 'unsupported' };
      note.show();
      return { ok: true };
    } catch (err) {
      reportError(err);
      return { ok: false, reason: 'show-failed' };
    }
  };
}

module.exports = { createNotificationDelivery };
