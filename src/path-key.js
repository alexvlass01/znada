(function initPathKey(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZnadaPathKey = api;
}(typeof self !== 'undefined' ? self : globalThis, function pathKeyFactory() {
  'use strict';

// The ONE way to compare two file paths anywhere in Znada.
//
// Windows hands the same file to us in several spellings: `C:\x\a.jpg` from a native
// dialog, `C:/x/a.jpg` from a renderer record, `C:\x\sub\..\a.jpg` from a folder walk,
// and `\\?\C:\x\a.jpg` from APIs that use the extended-length form. Every place that
// compared raw lowercased strings therefore had its own idea of identity: a trash entry
// written with one spelling was invisible to the guard protecting an active file, and
// "removed" markers did not match the playlist's own keys. The guards were real; they
// just looked at the wrong string.
//
// It lives in its own module because BOTH library.js and playlist.js need it, and
// playlist.js is already required by library.js — sharing it through either of them
// would be a require cycle.
//
// Deliberately filesystem-free and CWD-free: `path.resolve` would splice in the process
// working directory for a relative input and would not fold `\` when the tests run on
// POSIX. Folding here is pure string work, so the key is the same on every platform.

// Split off the root, so that `..` can never eat a drive letter or a network host, and
// so the extended-length prefixes Windows uses collapse onto their ordinary form.
//   \\?\C:\x        -> root 'c:/'        (same file as C:\x)
//   \\?\UNC\srv\sh  -> root '//srv/sh/'  (same file as \\srv\sh)
//   \\srv\sh\x      -> root '//srv/sh/'
//   C:\x            -> root 'c:/'
function splitRoot(input) {
  let s = input;
  // `\\?\` and `\\.\` are pass-through prefixes, not part of the name.
  if (/^\/\/[?.]\//.test(s)) {
    s = s.slice(4);
    // ...and `\\?\UNC\server\share` is how the extended form spells `\\server\share`.
    if (/^unc\//i.test(s)) s = `//${s.slice(4)}`;
  }
  if (s.startsWith('//')) {
    // A network path's root is host + share; anything above that is not addressable.
    const parts = s.slice(2).split('/').filter(Boolean);
    const host = parts.shift() || '';
    const share = parts.shift() || '';
    return { prefix: share ? `//${host}/${share}/` : `//${host}/`, rest: parts.join('/') };
  }
  if (/^[a-z]:\//i.test(s)) return { prefix: s.slice(0, 3), rest: s.slice(3) };
  if (/^[a-z]:$/i.test(s)) return { prefix: `${s}/`, rest: '' };
  if (s.startsWith('/')) return { prefix: '/', rest: s.slice(1) };
  return { prefix: '', rest: s };
}

function pathKey(p) {
  const raw = String(p == null ? '' : p).trim().replace(/\\/g, '/');
  if (!raw) return '';
  const { prefix, rest } = splitRoot(raw);
  const out = [];
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue;   // '' also folds a doubled separator
    if (segment === '..') { out.pop(); continue; }
    out.push(segment);
  }
  const joined = prefix + out.join('/');
  // A root keeps its trailing slash (`c:/`), everything else never has one.
  return (out.length ? joined : prefix).toLowerCase();
}

// True when `p` is the directory `dir` itself or anything below it. Prefix matching on
// raw strings gets this wrong twice: `C:\photos2` looks like it is inside `C:\photos`,
// and a separator mismatch makes a real child look unrelated.
function isUnderPath(p, dir) {
  const key = pathKey(p);
  const parent = pathKey(dir);
  if (!key || !parent) return false;
  if (key === parent) return true;
  // A root already ends in '/', so it must not get a second one.
  return key.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

// True only for a file/folder immediately inside `dir`. Unlike path.dirname(), this
// remains stable when one side uses an extended-length prefix and the other does not.
// GC uses it to distinguish Znada's own wallpaper copies from nested trash/cache files.
function isDirectChildPath(p, dir) {
  const key = pathKey(p);
  const parent = pathKey(dir);
  if (!key || !parent || key === parent) return false;
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  if (!key.startsWith(prefix)) return false;
  const remainder = key.slice(prefix.length);
  return !!remainder && !remainder.includes('/');
}

  return { pathKey, isUnderPath, isDirectChildPath };
}));
