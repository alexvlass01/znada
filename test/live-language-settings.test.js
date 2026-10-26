'use strict';

// BUG-055. A live language switch goes through refreshTexts(). Two lines of the settings
// page are drawn by their own functions — the event journal (with its "nothing happened"
// line) and the media folder label — and refreshTexts() did not redraw them, so they kept
// the previous language until a restart. The REAL renderer functions run here against a
// stand-in DOM; only the unrelated redraws inside refreshTexts() are stubbed.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8').split('\r\n').join('\n');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  passed++;
}

function functionSource(name) {
  const start = source.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `missing function ${name}`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start + 1, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function element() {
  return {
    children: [], textContent: '', title: '', className: '', hidden: false,
    classList: { toggle() {} },
    set innerHTML(_v) { this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
    removeAttribute() {},
    get text() {
      return this.textContent + this.children.map((c) => c.text).join('');
    },
  };
}

const DICTS = {
  de: { 'journal.empty': 'Keine Probleme', 'mediaFolder.inProfile': 'Im Profil' },
  ru: { 'journal.empty': 'Проблем не было', 'mediaFolder.inProfile': 'В профиле' },
};
let lang = 'de';
const dom = { '#eventLogList': element(), '#mediaFolderPath': element(), '#btnMediaFolderBack': element() };

const stubs = [
  'applyI18n', 'applyThemeToUI', 'renderCloudAccount', 'buildMonitorMap', 'updateSingleWallRow',
  'renderPreviews', 'renderHome', 'updateShortcutButtons', 'renderUpdate', 'renderSmartPanel',
  'renderAboutVersion', 'closeLibPopup', 'syncSelectionUI',
];
const ctx = {
  $: (sel) => dom[sel] || null,
  document: { createElement: () => element() },
  t: (key) => DICTS[lang][key] || key,
  window: {
    api: {
      eventLogGet: async () => ({ entries: [] }),
      mediaFolderState: async () => ({ state: 'ok', custom: false }),
    },
  },
  MediaFolder: { pathLabel: () => ({ key: 'mediaFolder.inProfile' }) },
  WhatsNewDialog: { close() {} },
  currentTheme: 'light',
};
for (const name of stubs) ctx[name] = () => {};
vm.createContext(ctx);
vm.runInContext(['renderEventLog', 'renderMediaFolderRow', 'refreshTexts'].map(functionSource).join('\n'), ctx);

(async () => {
  console.log('live language switch on the settings page (BUG-055)');
  await ctx.renderEventLog();
  await ctx.renderMediaFolderRow();
  ok('starts in the first language', dom['#eventLogList'].text === 'Keine Probleme'
    && dom['#mediaFolderPath'].textContent === 'Im Profil');

  lang = 'ru';
  ctx.refreshTexts();
  await new Promise((resolve) => { setImmediate(resolve); });
  ok('empty journal line follows the new language', dom['#eventLogList'].text === 'Проблем не было');
  ok('media folder label follows the new language', dom['#mediaFolderPath'].textContent === 'В профиле');

  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
