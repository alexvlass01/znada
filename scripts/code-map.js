'use strict';

// CODE-001. A read-only map of one big CommonJS file: what is declared at the top level,
// which module variables are shared state, who reads and writes them, and what cutting a
// region out into a module would cost. The numbers in the CODE-001 split plan come from
// here, so anyone can recompute them instead of taking them on trust.
//
//   node scripts/code-map.js big     <file> [n]        largest top-level units
//   node scripts/code-map.js state   <file> [n]        module variables by how many units touch them
//   node scripts/code-map.js fields  <file> [name]     where the fields of one module object (default
//                                                        `config`) are changed or handed to a function
//   node scripts/code-map.js cluster <file> <a-b[,c-d]> what a module made of these line ranges would
//                                                        call outside, read/write outside, and who calls in;
//                                                        its IPC handlers are counted apart (see below)
//
// It parses with espree and resolves names with eslint-scope, both already installed with
// ESLint (CODE-002). Nothing here changes a file.

const fs = require('fs');
const path = require('path');
const espree = require('espree');
const eslintScope = require('eslint-scope');

function analyze(source) {
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', loc: true, range: true });
  // nodejsScope: the file's top level is the module function's scope, so references to its
  // functions resolve statically instead of being left to the global object.
  const scopes = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'script', nodejsScope: true });
  const moduleScope = scopes.globalScope.childScopes[0];

  const vars = new Map();
  for (const variable of moduleScope.variables) {
    const def = variable.defs[0];
    if (!def) continue;
    vars.set(variable.name, {
      name: variable.name,
      kind: def.type === 'Variable' ? def.parent.kind : def.type,
      line: def.name.loc.start.line,
      isFunction: def.type === 'FunctionName',
      isRequire: false,
    });
  }
  const isRequireCall = (node) => node && node.type === 'CallExpression' && node.callee.name === 'require';
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const d of statement.declarations) {
      const init = d.init && d.init.type === 'MemberExpression' ? d.init.object : d.init;
      if (d.id.type === 'Identifier' && vars.has(d.id.name)) {
        if (d.init && /FunctionExpression/.test(d.init.type)) vars.get(d.id.name).isFunction = true;
        if (isRequireCall(init)) vars.get(d.id.name).isRequire = true;
      } else if (d.id.type === 'ObjectPattern' && isRequireCall(init)) {
        for (const p of d.id.properties) {
          if (p.value && p.value.type === 'Identifier' && vars.has(p.value.name)) vars.get(p.value.name).isRequire = true;
        }
      }
    }
  }

  function references(node) {
    const out = { reads: new Set(), writes: new Set(), calls: new Set() };
    const inside = (r) => r.identifier.range[0] >= node.range[0] && r.identifier.range[1] <= node.range[1];
    const refs = moduleScope.references.filter(inside);
    for (const scope of scopes.scopes) {
      if (scope === moduleScope || scope === scopes.globalScope) continue;
      if (scope.block.range[0] >= node.range[0] && scope.block.range[1] <= node.range[1]) refs.push(...scope.references);
    }
    for (const r of refs) {
      const variable = r.resolved;
      if (!variable || variable.scope !== moduleScope || !vars.has(variable.name)) continue;
      const v = vars.get(variable.name);
      if (v.isRequire) continue;
      if (v.isFunction) { out.calls.add(v.name); continue; }
      if (r.isWrite() && !r.init) out.writes.add(v.name);
      if (r.isRead()) out.reads.add(v.name);
    }
    return { reads: [...out.reads].sort(), writes: [...out.writes].sort(), calls: [...out.calls].sort() };
  }

  const units = ast.body.map((statement) => {
    let name = statement.type;
    if (statement.type === 'FunctionDeclaration') name = statement.id.name;
    else if (statement.type === 'VariableDeclaration') {
      name = statement.declarations.map((d) => (d.id.type === 'Identifier' ? d.id.name : '{…}')).join(',');
    } else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression') {
      const call = statement.expression;
      const first = call.arguments[0];
      name = source.slice(call.callee.range[0], call.callee.range[1]).slice(0, 60)
        + (first && first.type === 'Literal' ? `(${JSON.stringify(first.value)})` : '');
    }
    return {
      name,
      start: statement.loc.start.line,
      lines: statement.loc.end.line - statement.loc.start.line + 1,
      ...references(statement),
    };
  });
  const state = [...vars.values()].filter((v) => !v.isFunction && !v.isRequire);
  return { units, state };
}

// Where the FIELDS of one module object are changed: assignments, ++/--, delete, mutating
// method calls on a field, and the object or one of its big sub-objects handed to a function
// (which may change it). `state` only sees the variable itself being reassigned; this is the
// other half, and for `config` it is the bigger one.
const MUTATING_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'set', 'delete', 'add', 'clear', 'fill']);
function fieldWrites(source, rootName) {
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', loc: true, range: true });
  const rootOf = (node) => {
    let n = node;
    while (n && (n.type === 'MemberExpression' || n.type === 'ChainExpression')) n = n.type === 'ChainExpression' ? n.expression : n.object;
    return n && n.type === 'Identifier' ? n.name : null;
  };
  const tops = ast.body.map((s) => ({ from: s.range[0], to: s.range[1], start: s.loc.start.line }));
  const unitAt = (pos) => (tops.find((t) => pos >= t.from && pos <= t.to) || {}).start;
  const sites = [];
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    const at = node.range && node.range[0];
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && rootOf(node.left) === rootName) sites.push(unitAt(at));
    else if (node.type === 'UpdateExpression' && rootOf(node.argument) === rootName && node.argument.type === 'MemberExpression') sites.push(unitAt(at));
    else if (node.type === 'UnaryExpression' && node.operator === 'delete' && rootOf(node.argument) === rootName) sites.push(unitAt(at));
    else if (node.type === 'CallExpression') {
      const callee = node.callee;
      if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && MUTATING_METHODS.has(callee.property.name)
        && callee.object.type === 'MemberExpression' && rootOf(callee.object) === rootName) sites.push(unitAt(at));
      for (const a of node.arguments) {
        if ((a.type === 'Identifier' && a.name === rootName)
          || (a.type === 'MemberExpression' && rootOf(a) === rootName && a.object.type === 'Identifier')) sites.push(unitAt(at));
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(ast);
  return { sites: sites.length, units: new Set(sites).size };
}

function parseRanges(text) {
  return String(text || '').split(',').map((part) => part.split('-').map(Number))
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
}

// The guarded IPC door is not something a region would be handed if it became a module: its
// handlers stay in the file as one-line calls into the module, and the module never sees
// ipcMain. Counting it as a dependency would add the same name to every region that has a
// handler, so it is counted apart: how many of the region's units register through it.
const HANDLER_DOOR = 'ipcMain';

// What a module made of these ranges would have to be handed (calls out, state read or written
// outside) and what the rest of the file would have to reach in for (inbound).
function cluster(map, ranges) {
  const inRange = (line) => ranges.some(([a, b]) => line >= a && line <= b);
  const inside = map.units.filter((u) => inRange(u.start));
  const names = new Set(inside.flatMap((u) => String(u.name).split(',')));
  const tally = (key) => {
    const counts = new Map();
    for (const u of inside) {
      for (const n of u[key]) if (!names.has(n) && n !== HANDLER_DOOR) counts.set(n, (counts.get(n) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };
  const inbound = new Map();
  for (const u of map.units) {
    if (inRange(u.start)) continue;
    for (const n of [...u.calls, ...u.reads, ...u.writes]) {
      if (!names.has(n)) continue;
      if (!inbound.has(n)) inbound.set(n, new Set());
      inbound.get(n).add(u.name);
    }
  }
  return {
    lines: inside.reduce((sum, u) => sum + u.lines, 0),
    units: inside.length,
    callsOut: tally('calls'),
    readsOut: tally('reads'),
    writesOut: tally('writes'),
    inbound: [...inbound.entries()].map(([n, set]) => [n, set.size]).sort((a, b) => b[1] - a[1]),
    handlers: inside.filter((u) => u.reads.includes(HANDLER_DOOR)).length,
  };
}

function main(argv) {
  const [mode, file, arg] = argv;
  if (!mode || !file) {
    console.log('usage: node scripts/code-map.js big|state|cluster <file> [n | a-b,c-d]');
    return 2;
  }
  const map = analyze(fs.readFileSync(path.resolve(file), 'utf8'));
  const list = (pairs) => pairs.map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(', ') || '—';
  if (mode === 'big') {
    for (const u of [...map.units].sort((a, b) => b.lines - a.lines).slice(0, Number(arg) || 30)) {
      console.log(`${String(u.lines).padStart(5)} lines  @${u.start}  ${u.name}`);
    }
  } else if (mode === 'state') {
    const rows = map.state.map((v) => ({
      v,
      readers: map.units.filter((u) => u.reads.includes(v.name)).length,
      writers: map.units.filter((u) => u.writes.includes(v.name)).map((u) => u.name),
    })).sort((a, b) => (b.readers + b.writers.length) - (a.readers + a.writers.length));
    for (const r of rows.slice(0, Number(arg) || 30)) {
      console.log(`${r.v.kind.padEnd(5)} ${r.v.name.padEnd(32)} read by ${String(r.readers).padStart(3)}  written by ${r.writers.length}`
        + (r.writers.length ? `: ${r.writers.slice(0, 5).join(', ')}${r.writers.length > 5 ? ' …' : ''}` : ''));
    }
  } else if (mode === 'fields') {
    const w = fieldWrites(fs.readFileSync(path.resolve(file), 'utf8'), arg || 'config');
    console.log(`fields of ${arg || 'config'} changed or handed on at ${w.sites} places in ${w.units} top-level units`);
  } else if (mode === 'cluster') {
    const c = cluster(map, parseRanges(arg));
    console.log(`${c.units} units, ${c.lines} lines`);
    console.log(`  calls out:  ${list(c.callsOut)}`);
    console.log(`  reads out:  ${list(c.readsOut)}`);
    console.log(`  writes out: ${list(c.writesOut)}`);
    console.log(`  inbound:    ${list(c.inbound)}`);
    console.log(`  handlers:   ${c.handlers} unit(s) register through ${HANDLER_DOOR}; they stay in place, so it is not a dependency`);
  } else {
    console.log(`unknown mode: ${mode}`);
    return 2;
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { analyze, cluster, fieldWrites, parseRanges };
