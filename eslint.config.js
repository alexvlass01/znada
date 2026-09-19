'use strict';

// CODE-002. The first real static gate this project has had.
//
// Until now the only automatic check over the JavaScript was `node --check`, which
// answers "does this parse" and nothing else. That is a low bar, and it has been cleared
// by code with real defects: a guard was once renamed and left a call to a function that
// no longer existed, which parses perfectly and throws at runtime, silently killing
// thumbnail aspect prefetch. A test exists solely to catch that one instance by matching
// source text. A linter catches the whole class.
//
// Deliberately NOT a style pass. Nothing here is about quotes, semicolons or line length:
// this project is written by several different agents and a human, and a rule that only
// rearranges characters would produce a huge diff, hide the real findings inside it, and
// teach everyone to run --fix without reading. Every rule enabled below can point at a
// line and say what would go wrong.
//
// Scope grows by module rather than all at once — see `typecheck` in package.json for the
// same idea on the type side. A blanket disable is not an acceptable way to turn this
// green; a rule that is genuinely wrong for a file gets a narrow, explained exception.

const js = require('@eslint/js');
const globals = require('globals');

// Everything that is not first-party source. Generated output, vendored binaries, the
// scratch and temp areas agents write into, and the translation catalogues (data, not
// code) have no business being linted.
const IGNORED = [
  'node_modules/**',
  'dist/**',
  '.build/**',
  '.tmp/**',
  'scratch/**',
  'native/**',        // C#/.NET helper, not JavaScript
  'locales/**',       // dictionaries and generated context artefacts: data
  'assets/**',
  // Deliberately broken on purpose, and run by test/static-gates.test.js with --no-ignore
  // to prove the gates can fail. Linted in the ordinary run they would make it red forever.
  'test/fixtures/**',
  '.claude/**', '.agents/**', '.codex/**',
];

// The main process and everything that runs under plain Node: scripts, tests, tools.
const NODE_FILES = [
  'main.js',
  'src/**/*.js',
  'scripts/**/*.js',
  'test/**/*.js',
  'diagnostics/main/**/*.js',
  'plans/tools/**/*.js',
  'eslint.config.js',
];

// Modules that are loaded BOTH ways on purpose: required by main and tests, and pulled
// into the page by a <script> tag. They carry a UMD-style wrapper that checks for
// `window`/`self` before publishing itself, so both sets of globals are real for them.
//
// Named one by one rather than matched by a pattern, deliberately. The list is small, it
// documents which modules are dual-mode, and a new module that starts reaching for
// `window` without being added here gets told so - which is information, not noise.
const DUAL_MODE_FILES = [
  'src/hotkey.js',
  'src/next-change.js',
  'src/online-add.js',
  'src/online-sources.js',
  'src/online-identity.js',
  'src/media-proxy.js',
  'src/path-key.js',
  'src/gallery-payload.js',
  'src/size-filter.js',
  'renderer/*.js',
];

// What the renderer modules publish onto the page for each other. This is how the app is
// actually wired: index.html loads them with <script> tags and they find one another by
// name. Declared here so a MISSPELLED one is still reported - which is the whole point.
const RENDERER_SHARED = [
  'AssignRows', 'AutoLoad', 'CardActions', 'CardDetails', 'CardInteraction', 'CardMenu', 'CardMetadata', 'ViewScroll',
  'CardTransfer', 'DeferredRefresh', 'JustifiedLayout', 'NextChange', 'OnlineAdd',
  'OnlineBrowse', 'OnlineSources', 'OnlineIdentity', 'ResizeAnchor', 'SizeFilter', 'SelectPopup', 'UnifiedGrid', 'VirtualGridDom',
  'VirtualWindow', 'ZnadaGalleryPayload', 'ZnadaHotkey', 'ZnadaMediaProxy', 'ZnadaPathKey',
].reduce((all, name) => Object.assign(all, { [name]: 'readonly' }), {});

// Pages that are only ever a page.
const BROWSER_FILES = [
  'diagnostics/ui/control.js',
];

// Preloads sit in both worlds: they run before the page with a restricted `require`, and
// they touch browser objects. Both sets of globals apply.
const PRELOAD_FILES = [
  'preload.js',
  'renderer/viewer-preload.js',
  'diagnostics/ui/control-preload.js',
  'diagnostics/renderer/preload-attach.js',
];

// The rules that can point at a line and say what breaks. `js.configs.recommended`
// already carries most of them (no-undef, no-dupe-keys, no-unreachable, no-fallthrough,
// no-cond-assign, ...); these are the additions worth having on top, and the one
// adjustment this codebase needs.
const RULES = {
  // An unused variable is usually a leftover from a rename or a half-finished edit -
  // exactly the shape of defect this project keeps finding in review. Arguments are
  // exempt only from the left: `function (event, id)` may legitimately ignore `event`.
  'no-unused-vars': ['error', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrors: 'none',   // `catch {}` and `catch (err) {}` are both used deliberately here
  }],
  // An empty `catch` is a decision this codebase makes on purpose and comments in place:
  // a diagnostics probe that fails must not break the real preload, a best-effort cleanup
  // must not take down the operation that asked for it. An empty `if` or loop body is a
  // different thing and stays an error.
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Off, with a reason rather than by default. It fires on `x = await f()` whenever `x`
  // outlives the await, which is the ordinary shape of almost every async function here -
  // eighty hits, and the rule cannot tell a real interleaving hazard from a variable that
  // simply has a longer life. The hazards it aims at are covered concretely instead: the
  // latest-intent generation work is TRG-004, and the pool/settings ordering has its own
  // orchestration tests. Turning it on without those would be noise standing in for a
  // guarantee.
  'require-atomic-updates': 'off',
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  'eqeqeq': ['error', 'always', { null: 'ignore' }],  // `== null` for "null or undefined" is intentional
  'no-throw-literal': 'error',
  'no-return-await': 'error',
  'no-promise-executor-return': 'error',
  'no-await-in-loop': 'off',  // bounded sequential work is deliberate in several places
  'no-console': 'off',        // main logs to the terminal on purpose; that IS the diagnostics channel
};

module.exports = [
  { ignores: IGNORED },
  {
    files: NODE_FILES,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { ...js.configs.recommended.rules, ...RULES },
  },
  {
    files: BROWSER_FILES,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: { ...js.configs.recommended.rules, ...RULES },
  },
  {
    files: DUAL_MODE_FILES,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser, ...RENDERER_SHARED },
    },
    rules: { ...js.configs.recommended.rules, ...RULES },
  },
  {
    files: PRELOAD_FILES,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { ...js.configs.recommended.rules, ...RULES },
  },
];
