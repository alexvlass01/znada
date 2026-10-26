'use strict';

// CODE-001. The code that runs in Electron's main process, file by file.
//
// Several rules used to be checked by reading main.js as text: "no system program is
// started except through the runner", "every window is created through the shared
// security decision", "every registered channel has a role". Each of them is a rule about
// the main PROCESS, and main.js was simply where all of that code lived. Once code moves
// into modules, a check that still reads only main.js does not fail — it passes, because
// the code it was looking for has left the file. That is the worst way for a safety check
// to break, so every such rule reads this set instead.
//
// What is in the set:
// - main.js and every first-party file it loads, followed through require() from file to
//   file. The calls are read, not run, so a load behind a gate or inside a function counts
//   like one at the top: the diagnostics core, which main loads only in a diagnostics run,
//   is in. Each string passed to require() is resolved the way Node resolves it, so a
//   relative path, a folder's index.js or package.json "main", an alias from the "imports"
//   of package.json ('#name') and the project's own package name all lead to the file Node
//   would load. A third-party package is not read: something required by its name that
//   lands in the project's own node_modules, or in one outside the project that a link
//   leads to. A path written out, and anything that lands elsewhere inside the project (a
//   node_modules folder under src/ included), is project code. A Node built-in and
//   Electron's own modules are not files.
// - every .js and .cjs file under src/ and diagnostics/main/, whether anything loads it yet
//   or not. Some of src/ is also loaded by the window; checking it as main-process code is
//   the stricter reading.
//
// Each file comes with its syntax tree and the strings it passes to require(), and NOT with
// its text: the checks ask their question of the tree ("does this file require
// child_process", "does it construct a BrowserWindow", "which channel does it register"). A
// question asked of the text is answered wrongly by a comment inside the parentheses or by
// another way of writing the same call; two re-reviews in a row got past a check that way.
// `walk` visits the tree, and `writtenName` says how a name is written at a node, so that a
// rule about a name sees it however the text spells it out; `useOf` says what the code does
// with the value there, so that a rule that follows a value (the window class, a function that
// edits the library) can refuse it where it goes on under another name.
//
// A set that is quietly short is the same failure as the one above: the first version of
// this list read only .js files under two folders, and missed both a .cjs module that main
// loads and the diagnostics core; the second took every require that does not start with a
// dot for a package, and so missed a '#name' alias to a project file. So wherever this file
// cannot tell what main loads, it throws, and every check built on it fails with the reason:
// - require() of anything but a plain string: which file that is, only running it would say;
// - a require that does not resolve, resolves outside the project, or to something that is
//   not a file;
// - a first-party file loaded that is not CommonJS source (.js, .cjs). A .json is data and is
//   left out. Node runs any other file it is asked to load as code of some kind (.mjs as a
//   module, .node as a native library, an unknown extension as plain JavaScript), and a
//   check cannot hold code it cannot read;
// - a Node built-in that is not on the list below of ones that bring no code in. The others
//   load or run code (module, vm, worker_threads, inspector, repl) or start processes of
//   their own (cluster) where this file cannot follow;
// - code brought in any other way: import(); the loader's own handles (require('module'),
//   createRequire, something.require, process.mainModule, getBuiltinModule, binding,
//   _load, _compile, dlopen); a worker thread, a vm context, Electron's utility process or
//   WebAssembly; code run from text: eval and Function, and a constructor taken off a
//   value, which for any function is Function and for `module` is the loader. Each of these
//   names counts however it is written (see writtenName): called, stored, handed on, read
//   off an object, taken out by destructuring, or as a string ('getBuiltinModule' for
//   Reflect.get). A constructor may only be looked at: its .name, compared, tested.
//   Nothing in main uses any of them; each is taught here before main-process code may.
//   The one file that runs code from text on purpose is named below, with its reason.
//
// What no reading of the text can see: a name the text never writes whole, put together
// from pieces while the program runs (x['ev' + 'al']). This set holds code as it is written
// to be read; code written to hide what it does is for the reviewer.

const fs = require('fs');
const path = require('path');
const { createRequire, isBuiltin } = require('module');
const espree = require('espree');

const ROOT = path.join(__dirname, '..', '..');
const WALKED = ['src', path.join('diagnostics', 'main')];
const SOURCE = new Set(['.js', '.cjs']);
const DATA = new Set(['.json']);
// Node built-ins that bring no code in: they read and write files, sockets and data, and
// load or run nothing in main. child_process is here because it starts programs rather
// than loading code into main; which files may hold it is the WIN-002 rule
// (test/system-children-main.test.js). A built-in not on the list is refused until it is
// added here, with the reason it is plain.
const PLAIN_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'fs/promises', 'http', 'https',
  'os', 'path', 'perf_hooks', 'stream', 'stream/promises', 'string_decoder', 'timers',
  'timers/promises', 'url', 'util', 'zlib',
]);
// Electron's own modules: the runtime provides them, there is no file behind them.
const ELECTRON = /^electron(\/(main|common|renderer))?$/;
const OTHER_LOADERS = new Set(['createRequire', 'utilityProcess', 'WebAssembly']);
const LOADER_PROPERTIES = new Set([
  'require', 'mainModule', 'getBuiltinModule', 'binding', '_linkedBinding',
  '_load', '_compile', '_extensions', '_resolveFilename', 'dlopen',
]);
const REQUIRE_PROPERTIES = new Set(['resolve', 'main', 'cache']);
const FROM_TEXT = new Set(['eval', 'Function']);
// Files allowed to run code from text, each for its reason. Every other rule still holds
// for them.
const RUNS_TEXT_ON_PURPOSE = new Map([
  ['src/cloud/contracts.cjs', 'the generated bundle of the Cloud contracts, with zod inside: zod'
    + ' compiles its schema parsers with new Function. The text is built from the schemas in'
    + ' the bundle, not read from a file or from the user, and loads or starts nothing'],
]);

function listSources(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, out);
    else if (entry.isFile() && SOURCE.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function cannotFollow(file, line, what) {
  return new Error(`${file}:${line}: ${what}. The main-process checks cannot tell what that loads;`
    + ' teach test/helpers/main-process-sources.js about it before main-process code uses it.');
}

// Visits every node of a syntax tree, a parent before its children:
// visit(node, parent, ancestors), `ancestors` running from the root down to the parent. It is
// the walk's own list, valid only during the call.
function walk(node, visit, parent = null, ancestors = []) {
  visit(node, parent, ancestors);
  ancestors.push(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === 'loc') continue;
    for (const item of Array.isArray(child) ? child : [child]) {
      if (item && typeof item.type === 'string') walk(item, visit, node, ancestors);
    }
  }
  ancestors.pop();
}

// The name of a property read as `x.name`, `x['name']` or x[`name`]; null when it is computed
// otherwise.
function propertyName(member) {
  if (!member.computed) return member.property.type === 'Identifier' ? member.property.name : null;
  return stringValue(member.property);
}

// The text of a string written whole ('x', or `x` with nothing put in); null otherwise.
function stringValue(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
  return null;
}

// A name written as the label of a key ({ eval: 1 }, { 'eval': 1 }, class { require() {} })
// rather than as the thing itself. A key inside a destructuring pattern is not a label: it is
// read off the value, and the Property reports it (see writtenName).
function namesAKey(node, parent) {
  return (parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition')
    && parent.key === node && !parent.computed;
}

// The name a destructuring key reads ({ name } = x, { name: y } = x, { 'name': y } = x).
function keyName(property) {
  if (!property.computed && property.key.type === 'Identifier') return property.key.name;
  return stringValue(property.key);
}

// How a name is written at this node, when the text writes it whole: { name, how }, `how`
// being
//   'name'   an identifier: called, stored, handed on, declared (eval, run, execFile);
//   'read'   a property read off something: x.name, x['name'], or a key taken out by
//            destructuring ({ name } = x, { name: y } = x);
//   'string' a string with exactly that text ('name', `name`), which can stand for either of
//            the above (x[k], Reflect.get(x, k));
// and null where the name is only a label (a key of an object written out, a class member)
// or a part of a read already reported at the read. Every rule about a name asks this, so a
// rule cannot see one spelling and miss the next.
function writtenName(node, parent) {
  if (!parent) return null;
  if (node.type === 'Property' && parent.type === 'ObjectPattern') {
    const name = keyName(node);
    return name === null ? null : { name, how: 'read' };
  }
  if (node.type === 'MemberExpression') {
    const name = propertyName(node);
    return name === null ? null : { name, how: 'read' };
  }
  if (node.type === 'Identifier') {
    if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return null;
    if (namesAKey(node, parent)) return null;
    return { name: node.name, how: 'name' };
  }
  const text = stringValue(node);
  if (text === null) return null;
  if (parent.type === 'MemberExpression' && parent.property === node) return null;
  if (namesAKey(node, parent) || (parent.type === 'Property' && parent.key === node)) return null;
  return { name: text, how: 'string' };
}

// The name a value is given where it lands: a variable, a parameter, a property read or
// assigned (x.name), a key; null for anything else.
function nameAt(target) {
  if (!target) return null;
  if (target.type === 'Identifier') return target.name;
  if (target.type === 'MemberExpression') return propertyName(target);
  if (target.type === 'AssignmentPattern') return nameAt(target.left);
  return null;
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

// What the code does with the value a name stands for, at a node where writtenName finds the
// name: { use, at, property }. `at` is the node that uses it (the call, the `new`, the read off
// it); `property` is what is read off it, for 'member'. A rule that follows a value — the
// window class, a function that edits the library — counts it where it is used under that
// name, so a value given another name is out of its sight (the fourth re-review renamed both
// while destructuring, and called one through .call). Such a rule asks this, accepts the uses
// it can follow and refuses the rest:
//   'called'       f(…), x.f(…), f.call(…), f.apply(…), f`…`
//   'constructed'  new F(…), new x.F(…)
//   'member'       anything else read off it: F.getAllWindows, f.bind, f.length
//   'kept'         bound or handed on under its own name: a variable, a parameter or a
//                  function named f; { f } and { f: x.f }; x.f = f; const f = x.f;
//                  const { f } = x; a value written INTO the name (f = g, { k: x.f } = o)
//   'looked'       only looked at, nothing receives it: typeof f, f === g, if (f), f && …,
//                  `${f}`, x[f], a statement of its own
//   'renamed'      anything else, where it goes on under another name or none:
//                  const g = f, { f: g } = x, { g: f }, h(f), return f, [f], ...f,
//                  class extends F, Reflect.get(x, 'f'), tag`${f}` (raw positional argument)
// Whatever hands the value on unchanged is seen through: a || f, t ? f : g, (a, f), await f,
// a?.f. So (t ? f : g)(x) is a call of f, and const g = a || f a renaming.
function useOf(node, ancestors) {
  const parent = ancestors[ancestors.length - 1];
  const written = writtenName(node, parent);
  if (!written) return null;
  const { name } = written;
  const use = (kind, at, property) => ({ use: kind, at, property });
  // A key taken out by destructuring: kept when it is bound under the same name.
  if (node.type === 'Property') return use(nameAt(node.value) === name ? 'kept' : 'renamed', node);
  // The binding a destructuring makes: the read was reported at its Property.
  if (parent.type === 'Property' && parent.value === node && ancestors[ancestors.length - 2].type === 'ObjectPattern') {
    return use('kept', parent);
  }
  let value = node;
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const p = ancestors[i];
    switch (p.type) {
      case 'LogicalExpression':
        // `f && x` gives f only when f is falsy, never a function or a class.
        if (p.operator === '&&' && p.left === value) return use('looked', p);
        value = p; continue;
      case 'ConditionalExpression':
        if (p.test === value) return use('looked', p);
        value = p; continue;
      case 'SequenceExpression':
        if (p.expressions[p.expressions.length - 1] !== value) return use('looked', p);
        value = p; continue;
      case 'AwaitExpression': case 'ChainExpression':
        value = p; continue;
      case 'CallExpression': return use(p.callee === value ? 'called' : 'renamed', p);
      case 'NewExpression': return use(p.callee === value ? 'constructed' : 'renamed', p);
      case 'TaggedTemplateExpression': return use(p.tag === value ? 'called' : 'looked', p);
      case 'MemberExpression': {
        if (p.object !== value) return use('looked', p); // x[f]: f made into a key
        const property = propertyName(p);
        const call = ancestors[i - 1];
        if ((property === 'call' || property === 'apply') && call && call.type === 'CallExpression' && call.callee === p) {
          return use('called', call);
        }
        return use('member', p, property);
      }
      case 'Property': {
        if (p.value !== value) return use('looked', p); // { [f]: 1 }
        if (ancestors[i - 1].type === 'ObjectPattern') return use('kept', p); // ({ k: x.f } = o)
        return use(keyName(p) === name ? 'kept' : 'renamed', p);
      }
      case 'PropertyDefinition':
        return use(p.value === value && keyName(p) === name ? 'kept' : 'renamed', p);
      case 'AssignmentExpression':
        if (p.left === value) return use('kept', p);
        if (nameAt(p.left) !== name) return use('renamed', p);
        if (!ancestors[i - 1] || ancestors[i - 1].type === 'ExpressionStatement') return use('kept', p);
        value = p; continue; // the assignment hands on f as well: g(o.f = f)
      case 'AssignmentPattern':
        return use(p.left === value || nameAt(p.left) === name ? 'kept' : 'renamed', p);
      case 'VariableDeclarator':
        return use(p.id === value || nameAt(p.id) === name ? 'kept' : 'renamed', p);
      case 'ForInStatement': case 'ForOfStatement':
        return use(p.right === value ? 'looked' : 'kept', p);
      case 'ClassDeclaration': case 'ClassExpression':
        return use(p.id === value ? 'kept' : 'renamed', p);
      case 'TemplateLiteral': {
        // An ordinary template stringifies a substitution. A tagged template hands it to
        // the tag unchanged, just like an argument: round 5 returned BrowserWindow from it.
        const tag = ancestors[i - 1];
        return use(tag && tag.type === 'TaggedTemplateExpression' && tag.quasi === p ? 'renamed' : 'looked', p);
      }
      case 'UnaryExpression': case 'BinaryExpression': case 'ExpressionStatement':
      case 'IfStatement': case 'WhileStatement': case 'DoWhileStatement': case 'ForStatement':
      case 'SwitchStatement': case 'SwitchCase':
        return use('looked', p);
      case 'UpdateExpression': case 'CatchClause': case 'RestElement': case 'ArrayPattern':
        return use('kept', p);
      default:
        if (FUNCTIONS.has(p.type)) return use(p.id === value || p.params.includes(value) ? 'kept' : 'renamed', p);
        return use('renamed', p);
    }
  }
  return use('renamed', null);
}

// Whether a property is written into here: the left of an assignment, what ++ or delete acts
// on, a target of a destructuring assignment or of a for…of.
function writtenInto(node, ancestors) {
  const parent = ancestors[ancestors.length - 1];
  if (node.type !== 'MemberExpression' || !parent) return false;
  switch (parent.type) {
    case 'AssignmentExpression': case 'AssignmentPattern': return parent.left === node;
    case 'UpdateExpression': return true;
    case 'UnaryExpression': return parent.operator === 'delete';
    case 'Property': return parent.value === node && ancestors[ancestors.length - 2].type === 'ObjectPattern';
    case 'ArrayPattern': case 'RestElement': return true;
    case 'ForInStatement': case 'ForOfStatement': return parent.left === node;
    default: return false;
  }
}

// `require` itself is fine as the thing called (require('x')), in require.resolve,
// require.main and require.cache, and as a plain property name ({ require: … }). Anywhere else
// (require.call, a variable, an argument) the loader is handed on to code this file does not
// follow.
function requireOnlyNamed(node, parent) {
  if (parent.type === 'CallExpression') return parent.callee === node;
  if (parent.type === 'MemberExpression') return parent.object === node && REQUIRE_PROPERTIES.has(propertyName(parent));
  return false;
}

function parse(file, text) {
  try {
    return espree.parse(text, { ecmaVersion: 'latest', sourceType: 'commonjs', loc: true, range: true });
  } catch (err) {
    throw new Error(`${file}:${err.lineNumber}: cannot be read as CommonJS (${err.message}),`
      + ' so the main-process checks cannot read it');
  }
}

// One file's syntax tree, and the strings it passes to require() in the order written:
// { ast, requires: [{ spec, line }] }. Throws on any load it cannot follow.
function readCode(file, text) {
  const ast = parse(file, text);
  const requires = [];
  const runsText = (line, what) => {
    if (!RUNS_TEXT_ON_PURPOSE.has(file)) throw cannotFollow(file, line, `${what} runs code from text`);
  };
  walk(ast, (node, parent, ancestors) => {
    const line = node.loc.start.line;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
      const [spec] = node.arguments;
      if (node.arguments.length !== 1 || spec.type !== 'Literal' || typeof spec.value !== 'string') {
        throw cannotFollow(file, line, 'require() of something other than a plain string');
      }
      if (isBuiltin(spec.value) && !PLAIN_BUILTINS.has(spec.value.replace(/^node:/, ''))) {
        throw cannotFollow(file, line, `require('${spec.value}') is a Node built-in that may load or run code`
          + ' or start processes of its own, and is not on the list of plain ones');
      }
      requires.push({ spec: spec.value, line });
    }
    if (node.type === 'ImportExpression') throw cannotFollow(file, line, 'import() loads a module');
    const written = writtenName(node, parent);
    if (!written) return;
    const { name, how } = written;
    const as = how === 'read' ? `.${name}` : how === 'string' ? `'${name}'` : name;
    if (name === 'require' && how === 'name') {
      if (!requireOnlyNamed(node, parent)) throw cannotFollow(file, line, 'require is handed on as a value');
    } else if (LOADER_PROPERTIES.has(name) && how !== 'name') {
      // As a name of its own, `binding` or `_load` is somebody's local variable; read off an
      // object, or as the string that reads it, it is the loader's.
      throw cannotFollow(file, line, `${as} reaches into the module loader`);
    }
    if (OTHER_LOADERS.has(name)) throw cannotFollow(file, line, `${as} loads code of its own`);
    // eval and Function wherever they are named, not only where they are called: (0, eval)(t),
    // globalThis.eval(t), `const F = Function; new F(t)` and `const { eval: run } = globalThis`
    // all run text.
    if (FROM_TEXT.has(name)) runsText(line, as);
    // A constructor taken off a value is Function for any function and the loader for
    // `module`. It may be looked at — its .name read, compared, tested, typeof'd — and nothing
    // else: called, stored, handed on, .call-ed or returned, it can run text. So
    // `err && err.constructor && err.constructor.name` is still only looking.
    if (name === 'constructor' && how !== 'name') {
      const { use, property } = useOf(node, ancestors);
      if (!(node.type === 'MemberExpression' && (use === 'looked' || (use === 'member' && property === 'name')))) {
        runsText(line, `${as} (Function for any function, the loader for module)`);
      }
    }
  });
  return { ast, requires };
}

// [{ file: 'src/x.js', ast, requires }] with forward slashes, and lines counted over LF line
// endings, so the same assertion holds in a CRLF checkout (see test/helpers/fresh-clone-eol.js).
// The text is left out on purpose: a check that wants it is about to ask the wrong question.
// `root` is only for the tests of this file; every check reads the real project.
function mainProcessSources(root = ROOT) {
  const relative = (full) => path.relative(root, full).split(path.sep).join('/');
  const read = new Map();
  const pending = [path.join(root, 'main.js')];
  for (const dir of WALKED) listSources(path.join(root, dir), pending);
  while (pending.length) {
    const full = pending.pop();
    if (read.has(full)) continue;
    const file = relative(full);
    const text = fs.readFileSync(full, 'utf8').split('\r\n').join('\n');
    const { ast, requires } = readCode(file, text);
    read.set(full, { file, ast, requires });
    for (const { spec } of requires) {
      if (isBuiltin(spec) || ELECTRON.test(spec)) continue; // not a file
      let target;
      try {
        target = createRequire(full).resolve(spec);
      } catch {
        // A key file only an official build has (the site adapters load theirs inside a try).
        if (DATA.has(path.extname(spec))) continue;
        throw new Error(`${file}: require('${spec}') does not resolve to a file, so the checks cannot read it`);
      }
      if (!path.isAbsolute(target)) {
        throw new Error(`${file}: require('${spec}') resolves to '${target}', which is not a file the checks can read`);
      }
      const loaded = relative(target);
      const outside = loaded.startsWith('../') || path.isAbsolute(loaded);
      // A third-party package: required by its name, not by a path written out, and landing
      // where npm installs packages — the project's own node_modules, or one outside the
      // project, which is where a working copy's node_modules leads when it is a link to
      // another copy's (../shared/node_modules/…). A node_modules folder anywhere else inside
      // the project is not where packages are installed, so what lands there is read like any
      // project file (the third re-review loaded diagnostics/core/node_modules/probe.cjs).
      const byName = !/^\.{1,2}(\/|$)/.test(spec) && !path.isAbsolute(spec);
      if (byName && (loaded.startsWith('node_modules/') || (outside && loaded.split('/').includes('node_modules')))) continue;
      if (outside) {
        throw new Error(`${file}: require('${spec}') loads ${target}, outside the project`);
      }
      const ext = path.extname(target);
      if (DATA.has(ext)) continue;
      if (!SOURCE.has(ext)) {
        throw new Error(`${file}: require('${spec}') loads ${loaded}, which is not CommonJS source (.js, .cjs);`
          + ' the main-process checks cannot read it');
      }
      pending.push(target);
    }
  }
  return [...read.keys()].sort().map((full) => read.get(full));
}

module.exports = { mainProcessSources, walk, propertyName, keyName, writtenName, useOf, writtenInto, stringValue, ROOT };
