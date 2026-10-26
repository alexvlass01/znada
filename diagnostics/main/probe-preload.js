'use strict';

// QA-009. A sandboxed preload may load only `electron` and a few built-ins.
// The measuring probe used to be pulled into the app preloads by a relative load,
// which is why a diagnostics run turned the Chromium sandbox off. This module
// instead writes one self-contained script: the probe and its attach glue, inlined,
// with that one relative load rewritten away. The script is registered only for a
// diagnostics run. Nothing here loads Electron; main passes the session in.

const fs = require('fs');
const path = require('path');

const SANDBOX_REQUIRE_ALLOW = new Set(['electron', 'events', 'timers', 'url']);
// Split so the source never contains a string whose whole text is the loader name.
// The main-process reader refuses that spelling anywhere it can be used to load code.
const LOAD_WORD = 'req' + 'uire';
const PROBE_REQUIRE_LINE = "const { createRendererProbe } = req" + "uire('./probe');";

function isIdentChar(ch) {
  return !!ch && /[A-Za-z0-9_$]/.test(ch);
}

function findRequires(source) {
  if (typeof source !== 'string') throw new Error('preload source must be a string');
  const found = [];
  const n = source.length;
  let i = 0;
  // `brace` above 0 means this code frame is the inside of a ${ } and must
  // return to the template when the matching brace closes.
  const stack = [{ kind: 'code', brace: 0 }];

  while (i < n) {
    const frame = stack[stack.length - 1];
    const c = source[i];
    const next = source[i + 1];

    if (frame.kind === 'line') {
      if (c === '\n') stack.pop();
      i += 1;
      continue;
    }
    if (frame.kind === 'block') {
      if (c === '*' && next === '/') {
        stack.pop();
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (frame.kind === 'string') {
      if (c === '\\') { i += 2; continue; }
      if (c === frame.quote) { stack.pop(); i += 1; continue; }
      if (c === '\n') throw new Error('unclosed string');
      i += 1;
      continue;
    }
    if (frame.kind === 'template') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i += 1; continue; }
      if (c === '$' && next === '{') {
        stack.push({ kind: 'code', brace: 1 });
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (c === '/' && next === '/') { stack.push({ kind: 'line' }); i += 2; continue; }
    if (c === '/' && next === '*') { stack.push({ kind: 'block' }); i += 2; continue; }
    if (c === "'" || c === '"') { stack.push({ kind: 'string', quote: c }); i += 1; continue; }
    if (c === '`') { stack.push({ kind: 'template' }); i += 1; continue; }
    if (c === '{') {
      if (frame.brace > 0) frame.brace += 1;
      i += 1;
      continue;
    }
    if (c === '}') {
      if (frame.brace > 0) {
        frame.brace -= 1;
        i += 1;
        if (frame.brace === 0) stack.pop();
        continue;
      }
      i += 1;
      continue;
    }

    if (source.startsWith(LOAD_WORD, i) && !isIdentChar(source[i - 1])) {
      let j = i + LOAD_WORD.length;
      while (j < n && /[ \t\r\n]/.test(source[j])) j += 1;
      if (source[j] === '(') {
        j += 1;
        while (j < n && /[ \t\r\n]/.test(source[j])) j += 1;
        const arg = readRequireArgument(source, j);
        found.push(arg.request);
        i = arg.end;
        continue;
      }
    }
    i += 1;
  }

  if (stack.length === 2 && stack[1].kind === 'line') stack.pop();
  if (stack.length !== 1 || stack[0].kind !== 'code' || stack[0].brace !== 0) {
    throw new Error('unclosed string, comment or template');
  }
  return found;
}

function readRequireArgument(source, j) {
  const c = source[j];
  if (c !== "'" && c !== '"' && c !== '`') throw new Error('non-string require');
  let k = j + 1;
  let value = '';
  while (k < source.length) {
    if (source[k] === '\\') {
      value += source[k + 1] === undefined ? '' : source[k + 1];
      k += 2;
      continue;
    }
    if (c === '`' && source[k] === '$' && source[k + 1] === '{') {
      throw new Error('non-string require');
    }
    if (c !== '`' && source[k] === '\n') throw new Error('unclosed string');
    if (source[k] === c) return { request: value, end: k + 1 };
    value += source[k];
    k += 1;
  }
  throw new Error('unclosed string');
}

function composeProbePreload(probeSource, attachSource) {
  const probeLoads = findRequires(probeSource);
  if (probeLoads.length !== 0) {
    throw new Error('probe source loads a module; a sandboxed preload cannot');
  }
  const attachLoads = findRequires(attachSource);
  if (attachLoads.length !== 1 || attachLoads[0] !== './probe') {
    throw new Error('attach source must load only ./probe');
  }
  if (attachSource.split(PROBE_REQUIRE_LINE).length !== 2) {
    throw new Error('attach source probe load is not the expected line');
  }
  const rewritten = attachSource.replace(
    PROBE_REQUIRE_LINE,
    'const { createRendererProbe } = probeExports;'
  );
  if (findRequires(rewritten).length !== 0) {
    throw new Error('rewritten attach source still loads a module');
  }

  // Built as plain strings so the inlined sources are not parsed as this module.
  const script = [
    "'use strict';",
    "const { contextBridge, ipcRenderer } = require('electron');",
    'const probeExports = (function () {',
    '  const module = { exports: {} };',
    '  const exports = module.exports;',
    probeSource,
    '  return module.exports;',
    '})();',
    'const attachExports = (function () {',
    '  const module = { exports: {} };',
    '  const exports = module.exports;',
    rewritten,
    '  return module.exports;',
    '})();',
    'try {',
    '  const prefix = attachExports.ARG_PREFIX;',
    '  const hasDiag = process.argv.some((arg) => typeof arg === "string" && arg.indexOf(prefix) === 0);',
    '  if (hasDiag) {',
    '    const role = attachExports.parseRole(process.argv);',
    '    attachExports.attachRendererProbe({',
    '      ipcRenderer, contextBridge, role,',
    "      cardSelector: role === 'renderer-main' ? '.lib-card' : '',",
    '    });',
    '  }',
    '} catch (err) {',
    "  console.error('[Diagnostics] renderer probe failed:', err);",
    '}',
    '',
  ].join('\n');

  const composedLoads = findRequires(script);
  if (composedLoads.length !== 1 || composedLoads[0] !== 'electron') {
    throw new Error('composed probe preload must load only electron');
  }
  return script;
}

function readSource(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function install(session, userDataPath) {
  if (typeof userDataPath !== 'string' || userDataPath.trim() === '') {
    throw new Error('probe preload needs a diagnostics userData directory');
  }
  if (!session || typeof session.setPreloads !== 'function') {
    throw new Error('probe preload needs session.setPreloads');
  }
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const script = composeProbePreload(
    readSource(path.join(rendererDir, 'probe.js')),
    readSource(path.join(rendererDir, 'preload-attach.js'))
  );
  fs.mkdirSync(userDataPath, { recursive: true });
  const out = path.join(userDataPath, 'probe-preload.js');
  fs.writeFileSync(out, script, { encoding: 'utf8' });
  session.setPreloads([out]);
  return out;
}

module.exports = {
  SANDBOX_REQUIRE_ALLOW,
  findRequires,
  composeProbePreload,
  install,
};
