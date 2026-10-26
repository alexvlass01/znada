'use strict';

// CODE-001. Every IPC handler that main-process code registers, read off the syntax tree:
// [{ file, line, channel, handler }], `handler` being the function written at the call.
//
// Two gates stand on this list: every channel has a role (test/ipc-authority.test.js), and
// every handler that edits the library is frozen while the media folder moves
// (test/media-move-freeze.test.js). Both used to search the text for `ipcMain.handle('`, and
// the third re-review hid a handler from both with a comment between the parenthesis and the
// channel: the same call, the same registration, invisible to the two checks.
//
// A registration is a call of .handle or .handleOnce on anything but Electron's protocol,
// which serves a URL scheme rather than a channel; not only on something named ipcMain,
// because a module is handed ipcMain under whatever name its author picks. Wherever this
// cannot read what is registered, it throws, so the gates fail with the reason instead of
// passing without the handler:
// - a channel that is not a plain string;
// - a handler that is not a function written out at the call: through a name, the freeze
//   gate would read nothing;
// - .handle read without being called (stored, handed on, .call-ed, destructured, replaced,
//   or the string 'handle'): the registration then happens where this cannot see it.
// A few files pass registrations on rather than write them; they are named below, each with
// its reason and with how many such calls it holds, so another one is a decision.
//
// The limit is the one of the set this reads (test/helpers/main-process-sources.js): a name
// the text never writes whole (x['han' + 'dle']) is not seen.

const { walk, propertyName, writtenName, stringValue } = require('./main-process-sources');

const REGISTER = new Set(['handle', 'handleOnce']);
const NOT_IPC = new Set(['protocol']);
const HANDLER = new Set(['ArrowFunctionExpression', 'FunctionExpression']);

// Files that pass on a registration somebody else wrote. `passesOn`: how many calls there
// register a channel that is not a plain string, because it is the channel their caller
// named. `readsDoor`: whether the file may read .handle without calling it.
const DOORS = new Map([
  ['main.js', { passesOn: 1, readsDoor: false,
    why: 'the library-move freeze in front of the guard: every ipcMain.handle(...) in main goes through it' }],
  ['src/ipc-authority.js', { passesOn: 1, readsDoor: true,
    why: 'the guard: registers on Electron the channel its caller named, behind the role check' }],
  ['diagnostics/main/ipc-instrumentation.js', { passesOn: 0, readsDoor: true,
    why: 'dev only: wraps the registration it is handed, to time each handler' }],
]);

function nameOf(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return propertyName(node);
  return null;
}

function ipcRegistrations(sources) {
  const found = [];
  for (const { file, ast } of sources) {
    const door = DOORS.get(file);
    let passedOn = 0;
    walk(ast, (node, parent) => {
      const written = writtenName(node, parent);
      if (!written || written.how === 'name' || !REGISTER.has(written.name)) return;
      const at = `${file}:${node.loc.start.line}`;
      if (node.type === 'MemberExpression' && NOT_IPC.has(nameOf(node.object))) return;
      const called = node.type === 'MemberExpression' && parent.type === 'CallExpression' && parent.callee === node;
      if (!called) {
        if (door && door.readsDoor) return;
        throw new Error(`${at}: .${written.name} is read without being called, so a channel can be registered`
          + ' where the IPC checks cannot see it');
      }
      const [channelNode, handler] = parent.arguments;
      const channel = channelNode ? stringValue(channelNode) : null;
      if (channel === null) {
        if (door) { passedOn += 1; return; }
        throw new Error(`${at}: .${written.name}() of a channel that is not a plain string;`
          + ' the IPC checks cannot tell which channel that is');
      }
      if (!handler || !HANDLER.has(handler.type)) {
        throw new Error(`${at}: the handler for '${channel}' is not a function written out at the call,`
          + ' so the IPC checks cannot read it');
      }
      found.push({ file, line: node.loc.start.line, channel, handler });
    });
    if (door && passedOn > door.passesOn) {
      throw new Error(`${file}: ${passedOn} registrations of a channel that is not a plain string, where`
        + ` ${door.passesOn} pass(es) on what the caller named. A new door to IPC registration is named`
        + ' in test/helpers/ipc-registrations.js on purpose.');
    }
  }
  return found;
}

module.exports = { ipcRegistrations, DOORS };
