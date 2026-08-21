'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const rendererDir = path.join(ROOT, 'renderer');
const renderer = fs.readdirSync(rendererDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => fs.readFileSync(path.join(rendererDir, name), 'utf8'))
  .join('\n');

function captures(text, re) {
  return [...text.matchAll(re)].map((match) => match[1]);
}

function duplicates(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

const invokedChannels = captures(preload, /ipcRenderer\.invoke\(['"]([^'"]+)/g);
const handledChannels = captures(main, /ipcMain\.handle\(['"]([^'"]+)/g);
const exposedMethods = captures(preload, /^\s{2}([A-Za-z_$][\w$]*):/gm);
const usedMethods = captures(renderer, /window\.api\.([A-Za-z_$][\w$]*)/g);

assert.deepStrictEqual(duplicates(invokedChannels), [], 'preload must expose each invoke channel once');
assert.deepStrictEqual(duplicates(handledChannels), [], 'main must register each invoke handler once');

const missingHandlers = [...new Set(invokedChannels)].filter((channel) => !handledChannels.includes(channel));
assert.deepStrictEqual(missingHandlers, [], `preload invoke channels without a main handler: ${missingHandlers.join(', ')}`);

const missingMethods = [...new Set(usedMethods)].filter((method) => !exposedMethods.includes(method));
assert.deepStrictEqual(missingMethods, [], `renderer window.api methods missing from preload: ${missingMethods.join(', ')}`);

assert.ok(invokedChannels.includes('set-hotkey'), 'atomic hotkey IPC is part of the public renderer bridge');
assert.ok(handledChannels.includes('set-hotkey'), 'main handles the atomic hotkey IPC');

console.log(`IPC contract OK: ${new Set(exposedMethods).size} methods, ${invokedChannels.length} invoke channels, ${handledChannels.length} handlers.`);
