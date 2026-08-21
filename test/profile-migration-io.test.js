'use strict';

// Filesystem + real CLI boundary tests for the one-way Lumina -> Znada import.
// Every destructive test operation is confined to a fresh os.tmpdir() child.
//
// Run: node test/profile-migration-io.test.js

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const library = require('../src/library');

const CLI = path.resolve(__dirname, '..', 'scripts', 'migrate-profile.js');
// The owner-only CLI is deliberately absent from the public export, so this file has
// to tell 'legitimately not here' from 'went missing'. Any private-only file answers
// that; AGENTS.md is the one every private checkout has. Getting this wrong is not
// hypothetical: ROOT was used below without ever being declared, so in a public
// checkout — the ONLY place the branch runs — the skip crashed with a ReferenceError
// instead of skipping. It never fired here, because here the CLI exists.
const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let skipped = 0;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function item(filePath, extra = {}) {
  return {
    id: library.idFor(filePath),
    type: 'image',
    path: filePath,
    addedAt: 1,
    favorite: false,
    tags: [],
    ...extra,
  };
}

function fixture(root, sourcePath = path.join(root, 'lumina')) {
  const source = path.resolve(sourcePath);
  const target = path.resolve(path.join(root, 'znada'));
  const wallpaper = path.join(source, 'wallpapers', 'one.png');
  fs.mkdirSync(path.dirname(wallpaper), { recursive: true });
  fs.writeFileSync(wallpaper, 'wallpaper-one', 'utf8');
  const own = item(wallpaper);
  const config = {
    monitors: { DISPLAY1: { light: { itemIds: [own.id] }, dark: { itemIds: [] } } },
    lightWallpaper: wallpaper,
    darkWallpaper: '',
    slideshowCurrentPath: { DISPLAY1: { light: wallpaper, dark: '' } },
    anonId: 'abcdefgh',
  };
  const store = { version: 1, library: { [own.id]: own }, trash: [] };
  writeJson(path.join(source, 'config.json'), config);
  writeJson(path.join(source, 'config.library.json'), store);
  writeJson(path.join(source, 'folder-state.json'), { version: 4, folders: {} });
  fs.writeFileSync(path.join(source, 'cloud-session.bin'), Buffer.from([1, 2, 3, 4]));
  return { root, source, target, wallpaper, own, config, store };
}

function snapshotTree(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(dir, full).replace(/\\/g, '/');
        out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(dir);
  return out;
}

function runRaw(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { ...result, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function runCli(source, target, extra = []) {
  return runRaw(['--from', source, '--to', target, ...extra]);
}

function withTemp(name, fn) {
  const tempBase = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempBase, 'znada-profile-migration-'));
  const rel = path.relative(tempBase, root);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel),
    'test temp escaped os.tmpdir');
  try {
    fn(root);
    console.log('  ✓ ' + name);
    passed++;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function expectRejected(name, mutate, pattern) {
  withTemp(name, (root) => {
    const f = fixture(root);
    mutate(f);
    const before = snapshotTree(f.source);
    const result = runCli(f.source, f.target);
    assert.notStrictEqual(result.status, 0, `CLI unexpectedly succeeded:\n${result.output}`);
    if (pattern) assert.match(result.output, pattern);
    assert.deepStrictEqual(snapshotTree(f.source), before, 'source changed after a rejected migration');
    assert.ok(!fs.existsSync(f.target), 'rejected migration created target');
    assert.ok(!fs.existsSync(`${f.target}.migrating`), 'validation failure created staging');
  });
}

function run() {
  if (!fs.existsSync(CLI)) {
    if (fs.existsSync(path.join(ROOT, 'AGENTS.md'))) {
      throw new Error('private canonical checkout is missing required scripts/migrate-profile.js');
    }
    console.log('\nSKIP profile-migration IO: private owner-only CLI is absent from this checkout.');
    return;
  }
  withTemp('happy path copies/remaps data, preserves source, and is one-way idempotent', (root) => {
    const f = fixture(root);
    const before = snapshotTree(f.source);
    const result = runCli(f.source, f.target);
    assert.strictEqual(result.status, 0, result.output);
    assert.deepStrictEqual(snapshotTree(f.source), before, 'successful import modified the source');
    assert.ok(fs.existsSync(f.target), 'target was not published');
    assert.ok(!fs.existsSync(`${f.target}.migrating`), 'staging remained after success');

    const config = JSON.parse(fs.readFileSync(path.join(f.target, 'config.json'), 'utf8'));
    const store = JSON.parse(fs.readFileSync(path.join(f.target, 'config.library.json'), 'utf8'));
    const movedPath = path.join(f.target, 'wallpapers', 'one.png');
    const movedId = library.idFor(movedPath);
    assert.strictEqual(store.library[movedId].path, movedPath);
    assert.strictEqual(store.library[movedId].id, movedId);
    assert.deepStrictEqual(config.monitors.DISPLAY1.light.itemIds, [movedId]);
    assert.strictEqual(config.lightWallpaper, movedPath);
    assert.strictEqual(config.slideshowCurrentPath.DISPLAY1.light, movedPath);
    assert.strictEqual(fs.readFileSync(movedPath, 'utf8'), 'wallpaper-one');
    assert.deepStrictEqual(
      fs.readFileSync(path.join(f.target, 'cloud-session.bin')),
      fs.readFileSync(path.join(f.source, 'cloud-session.bin')),
    );

    const targetBefore = snapshotTree(f.target);
    const retry = runCli(f.source, f.target);
    assert.notStrictEqual(retry.status, 0, 'rerun overwrote an existing target');
    assert.match(retry.output, /путь нового профиля уже существует/);
    assert.deepStrictEqual(snapshotTree(f.target), targetBefore, 'rerun changed the published target');
    assert.deepStrictEqual(snapshotTree(f.source), before, 'rerun changed the source');
  });

  withTemp('--cleanup is fail-closed and never deletes source', (root) => {
    const f = fixture(root);
    fs.mkdirSync(f.target, { recursive: true });
    fs.writeFileSync(path.join(f.target, 'unrelated.txt'), 'not a migration');
    const before = snapshotTree(f.source);
    const result = runCli(f.source, f.target, ['--cleanup']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.output, /--cleanup отключён/);
    assert.deepStrictEqual(snapshotTree(f.source), before);
    assert.strictEqual(fs.readFileSync(path.join(f.target, 'unrelated.txt'), 'utf8'), 'not a migration');
  });

  withTemp('a lone --from or --to never falls back to the real APPDATA profile', (root) => {
    const f = fixture(root);
    const before = snapshotTree(f.source);
    const fromOnly = runRaw(['--from', f.source]);
    const toOnly = runRaw(['--to', f.target]);
    assert.notStrictEqual(fromOnly.status, 0);
    assert.notStrictEqual(toOnly.status, 0);
    assert.match(fromOnly.output, /--from и --to разрешены только вместе/);
    assert.match(toOnly.output, /--from и --to разрешены только вместе/);
    assert.deepStrictEqual(snapshotTree(f.source), before);
    assert.ok(!fs.existsSync(f.target));
    assert.ok(!fs.existsSync(`${f.target}.migrating`));
  });

  withTemp('unknown or duplicated CLI options fail closed before creating a target', (root) => {
    const f = fixture(root);
    const before = snapshotTree(f.source);
    for (const args of [
      ['--from', f.source, '--to', f.target, '--dryrun'],
      ['--from', f.source, '--from', f.source, '--to', f.target],
    ]) {
      const result = runRaw(args);
      assert.notStrictEqual(result.status, 0);
      assert.match(result.output, /неизвестный аргумент|указан повторно/);
      assert.ok(!fs.existsSync(f.target));
      assert.ok(!fs.existsSync(`${f.target}.migrating`));
    }
    assert.deepStrictEqual(snapshotTree(f.source), before);
  });

  expectRejected('missing config.json is rejected before staging', (f) => {
    fs.unlinkSync(path.join(f.source, 'config.json'));
  }, /нет обязательного файла config\.json/);

  expectRejected('missing config.library.json is rejected before staging', (f) => {
    fs.unlinkSync(path.join(f.source, 'config.library.json'));
  }, /нет обязательного файла config\.library\.json/);

  expectRejected('unsupported store version is rejected before staging', (f) => {
    f.store.version = 2;
    writeJson(path.join(f.source, 'config.library.json'), f.store);
  }, /неподдерживаемая версия config\.library\.json/);

  expectRejected('unsupported folder-state version is rejected before staging', (f) => {
    writeJson(path.join(f.source, 'folder-state.json'), { version: 999, folders: {} });
  }, /folder-state\.json имеет неподдерживаемый формат или версию/);

  withTemp('folder-state.json is optional, but no synthetic index is written', (root) => {
    const f = fixture(root);
    fs.unlinkSync(path.join(f.source, 'folder-state.json'));
    const before = snapshotTree(f.source);
    const result = runCli(f.source, f.target);
    assert.strictEqual(result.status, 0, result.output);
    assert.deepStrictEqual(snapshotTree(f.source), before);
    assert.ok(!fs.existsSync(path.join(f.target, 'folder-state.json')));
  });

  withTemp('supported folder-state v1 and v3 migrate through the real CLI', (root) => {
    for (const version of [1, 3]) {
      const caseRoot = path.join(root, `v${version}`);
      const f = fixture(caseRoot);
      const liveRoot = path.join(caseRoot, 'live-folder');
      const file = version === 1
        ? { firstSeenAt: 1, modifiedAt: 2 }
        : { relativePath: 'a.png', firstSeenAt: 1, modifiedAt: 2 };
      writeJson(path.join(f.source, 'folder-state.json'), {
        version,
        folders: {
          [library.idFor(liveRoot)]: {
            rootPath: liveRoot,
            files: { 'a.png': file },
            baselineComplete: version === 1 ? false : true,
          },
        },
      });
      const result = runCli(f.source, f.target);
      assert.strictEqual(result.status, 0, result.output);
      const migrated = JSON.parse(fs.readFileSync(path.join(f.target, 'folder-state.json'), 'utf8'));
      assert.strictEqual(migrated.version, version);
      assert.ok(migrated.folders[library.idFor(liveRoot)]);
    }
  });

  expectRejected('inline/store divergence is rejected instead of store-wins merge', (f) => {
    f.config.library = { [f.own.id]: { ...f.own, tags: ['inline-only'] } };
    writeJson(path.join(f.source, 'config.json'), f.config);
  }, /inline library.*расходятся/);

  expectRejected('dangling monitor slot is rejected before staging', (f) => {
    f.config.monitors.DISPLAY1.light.itemIds.push('missing-id');
    writeJson(path.join(f.source, 'config.json'), f.config);
  }, /отсутствующую запись missing-id/);

  expectRejected('active+trash collision is rejected before staging', (f) => {
    f.store.trash.push({ item: { ...f.own }, removedAt: 2 });
    writeJson(path.join(f.source, 'config.library.json'), f.store);
  }, /одновременно active и removed/);

  expectRejected('library key/id/path mismatch is rejected before staging', (f) => {
    const wrong = { ...f.own, id: 'wrong-id' };
    f.store.library = { 'wrong-key': wrong };
    f.config.monitors.DISPLAY1.light.itemIds = ['wrong-key'];
    writeJson(path.join(f.source, 'config.json'), f.config);
    writeJson(path.join(f.source, 'config.library.json'), f.store);
  }, /ключ и item\.id расходятся/);

  withTemp('an existing empty target is rejected without touching it', (root) => {
    const f = fixture(root);
    fs.mkdirSync(f.target);
    const before = snapshotTree(f.source);
    const result = runCli(f.source, f.target);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.output, /путь нового профиля уже существует/);
    assert.deepStrictEqual(snapshotTree(f.source), before);
    assert.deepStrictEqual(fs.readdirSync(f.target), []);
    assert.ok(!fs.existsSync(`${f.target}.migrating`));
  });

  withTemp('an existing staging directory is rejected and preserved', (root) => {
    const f = fixture(root);
    const staging = `${f.target}.migrating`;
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'evidence.txt'), 'keep');
    const before = snapshotTree(f.source);
    const result = runCli(f.source, f.target);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.output, /staging уже существует/);
    assert.strictEqual(fs.readFileSync(path.join(staging, 'evidence.txt'), 'utf8'), 'keep');
    assert.deepStrictEqual(snapshotTree(f.source), before);
  });

  withTemp('OLD equal to NEW.migrating is rejected without deleting the source', (root) => {
    const target = path.join(root, 'znada');
    const source = `${target}.migrating`;
    const f = fixture(root, source);
    const before = snapshotTree(f.source);
    const result = runCli(f.source, target);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.output, /совпадают или вложены/);
    assert.deepStrictEqual(snapshotTree(f.source), before);
    assert.ok(!fs.existsSync(target));
  });

  withTemp('a destination nested inside the source is rejected', (root) => {
    const f = fixture(root);
    const nested = path.join(f.source, 'nested', 'znada');
    const before = snapshotTree(f.source);
    const result = runCli(f.source, nested);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.output, /совпадают или вложены/);
    assert.deepStrictEqual(snapshotTree(f.source), before);
    assert.ok(!fs.existsSync(nested));
  });

  withTemp('wallpapers2 is not treated as Znada-owned by copy verification', (root) => {
    const f = fixture(root);
    const lookalike = path.join(f.target, 'wallpapers2', 'external.png');
    const external = item(lookalike);
    f.store.library[external.id] = external;
    writeJson(path.join(f.source, 'config.library.json'), f.store);
    const result = runCli(f.source, f.target);
    assert.strictEqual(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /записей указывают на файлы/);
  });

  withTemp('extended-length source paths remap to normal Znada paths through the CLI', (root) => {
    const f = fixture(root);
    const extended = `\\\\?\\${f.wallpaper}`;
    const extendedItem = item(extended);
    f.store.library = { [extendedItem.id]: extendedItem };
    f.config.monitors.DISPLAY1.light.itemIds = [extendedItem.id];
    f.config.lightWallpaper = extended;
    f.config.slideshowCurrentPath.DISPLAY1.light = extended;
    writeJson(path.join(f.source, 'config.json'), f.config);
    writeJson(path.join(f.source, 'config.library.json'), f.store);
    const result = runCli(f.source, f.target);
    assert.strictEqual(result.status, 0, result.output);
    const store = JSON.parse(fs.readFileSync(path.join(f.target, 'config.library.json'), 'utf8'));
    const expected = path.join(f.target, 'wallpapers', 'one.png');
    assert.strictEqual(store.library[library.idFor(expected)].path, expected);
    assert.ok(!JSON.stringify(store).includes('\\\\?\\'), 'extended prefix leaked into migrated store');
  });

  withTemp('a source mutation during copy blocks publication and preserves staging', (root) => {
    const f = fixture(root);
    // Enough entries to keep the copy phase open while an independent process
    // observes staging and mutates the source, without allocating a huge file.
    for (let i = 0; i < 500; i++) {
      fs.writeFileSync(path.join(f.source, 'wallpapers', `padding-${i}.txt`), 'x');
    }
    const staging = `${f.target}.migrating`;
    const mutation = path.join(f.source, 'changed-during-copy.txt');
    const mutatorCode = [
      "const fs=require('fs')",
      `const staging=${JSON.stringify(staging)}`,
      `const mutation=${JSON.stringify(mutation)}`,
      'const until=Date.now()+20000',
      "function poll(){if(fs.existsSync(staging)){fs.writeFileSync(mutation,'changed');return}if(Date.now()>until)process.exit(3);setTimeout(poll,1)}",
      'poll()',
    ].join(';');
    const mutator = spawn(process.execPath, ['-e', mutatorCode], { windowsHide: true, stdio: 'ignore' });
    const result = runCli(f.source, f.target);
    if (!fs.existsSync(mutation)) {
      try { mutator.kill(); } catch {}
      assert.fail(`mutation helper did not observe staging:\n${result.output}`);
    }
    assert.notStrictEqual(result.status, 0);
    assert.match(result.output, /исходный профиль изменился во время копирования/);
    assert.ok(!fs.existsSync(f.target), 'mutable source was published');
    assert.ok(fs.existsSync(staging), 'failed-copy staging was not preserved for inspection');
  });

  withTemp('a junction used as --from is rejected instead of misclassifying real paths', (root) => {
    const f = fixture(root);
    const alias = path.join(root, 'lumina-source-alias');
    try { fs.symlinkSync(f.source, alias, 'junction'); }
    catch (e) {
      console.log(`  - source junction fixture skipped: ${e.code || e.message}`);
      skipped++;
      return;
    }
    const before = snapshotTree(f.source);
    const result = runCli(alias, f.target);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.output, /источник задан через junction\/symlink\/alias/);
    assert.deepStrictEqual(snapshotTree(f.source), before);
    assert.ok(!fs.existsSync(f.target));
    assert.ok(!fs.existsSync(`${f.target}.migrating`));
  });

  withTemp('physical junction alias nesting is rejected when Windows permits the fixture', (root) => {
    const f = fixture(root);
    const alias = path.join(root, 'lumina-alias');
    try { fs.symlinkSync(f.source, alias, 'junction'); }
    catch (e) {
      console.log(`  - junction fixture skipped: ${e.code || e.message}`);
      skipped++;
      return;
    }
    const aliasedTarget = path.join(alias, 'znada');
    const before = snapshotTree(f.source);
    const result = runCli(f.source, aliasedTarget);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.output, /Физические пути.*совпадают или вложены/s);
    assert.deepStrictEqual(snapshotTree(f.source), before);
    assert.ok(!fs.existsSync(aliasedTarget));
  });

  console.log(`\nAll ${passed} profile-migration IO tests passed${skipped ? ` (${skipped} skipped)` : ''}.`);
}

if (require.main === module) run();

module.exports = { run };
