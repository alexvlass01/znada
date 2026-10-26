'use strict';

// CODE-001 2.1b. The one owner of the resolved managed-copies folder (`managedRoot`,
// `wallpapersDir`, `trashDirPath`, its live readiness/invalidity checks), local photo
// import (`importWallpaper`, `photoForPool`, `watchedFolderShowing`) and remote download
// staging/promotion (`stageDownloadImage`, `commitDownloadArtifact`,
// `discardDownloadArtifact`, `downloadImageTo`, `downloadWallpaperFromUrl`).
//
// main.js still holds the config object and liveFolderState and passes read callbacks
// (`getConfig`, `getHiddenDirs`, `liveMaterializeExtra`). No Electron here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDirectChildPath } = require('./path-key');
const mediaRoot = require('./media-root');
const photoImport = require('./photo-import');
const mediaFormats = require('./media-type');

/**
 * @typedef {{ root: string, parent: string, anchor: string, custom: boolean }} ManagedRoot
 * @typedef {{ state: string, reason: string }} ManagedRootStatus
 * @typedef {{ path: string, stagingPath: string }} StagedDownload
 * @typedef {{
 *   userDataPath: string,
 *   getConfig: () => { mediaFolder?: string, library?: Record<string, { type?: string, path?: string }> },
 *   getHiddenDirs?: () => string[],
 *   liveMaterializeExtra?: (srcPath: string, type: string) => Record<string, unknown> | undefined,
 *   dirExists?: (dirPath: string) => boolean,
 *   getExeDir?: () => string,
 *   env?: NodeJS.ProcessEnv,
 *   fetchImpl?: typeof fetch,
 *   log?: { error: (...args: unknown[]) => void },
 * }} ManagedFolderDeps
 */

/**
 * @param {ManagedFolderDeps} deps
 */
function createManagedFolder({
  userDataPath,
  getConfig,
  getHiddenDirs = () => [],
  liveMaterializeExtra = () => undefined,
  dirExists = (p) => { try { return !!(p && fs.statSync(p).isDirectory()); } catch { return false; } },
  getExeDir = () => '',
  env = process.env,
  fetchImpl: defaultFetch,
  log = console,
}) {
  const imgExts = new Set(mediaFormats.fileExtensions());

  // DATA-006. Where Znada's own copies live is a SETTING, so it cannot be a constant
  // resolved while the module loads — at that moment config.json has not been read yet.
  // Everything asks wallpapersDir() instead, and the answer changes only through
  // refresh(). Capturing it in another module-level const would quietly reintroduce the
  // bug this replaces, which is what test/media-root-main.test.js checks.
  let managedRoot = mediaRoot.resolveManagedRoot({ userDataPath, mediaFolder: '' });

  function current() { return managedRoot; }
  function wallpapersDir() { return managedRoot.root; }
  function trashDirPath() { return path.join(managedRoot.root, '.trash'); }

  function refresh() {
    const config = getConfig();
    managedRoot = mediaRoot.resolveManagedRoot({
      userDataPath,
      mediaFolder: config && config.mediaFolder,
    });
    return managedRoot;
  }

  function systemRoots() {
    const roots = [
      env.SystemRoot, env.windir, env.ProgramFiles,
      env['ProgramFiles(x86)'], env.ProgramData,
    ];
    try {
      const exeDir = getExeDir();
      if (exeDir) roots.push(exeDir);
    } catch {}
    return /** @type {string[]} */ (roots.filter(Boolean));
  }

  /**
   * @param {string} folder
   */
  function folderProblem(folder) {
    return mediaRoot.folderProblem({
      folder,
      userDataPath,
      systemRoots: systemRoots(),
    });
  }

  /**
   * @param {string} mediaFolder
   */
  function resolveTarget(mediaFolder) {
    return mediaRoot.resolveManagedRoot({ userDataPath, mediaFolder });
  }

  // Asked live, never cached: a removable drive can leave between two user actions, and a
  // cached "ready" would let a write land somewhere the user did not choose.
  // A saved folder the rules refuse today (a hand-edited setting, or one written before a
  // rule existed). Pure string checks, no disk: it is also asked for every path a window
  // wants to read.
  function invalid() {
    return managedRoot.custom && !!folderProblem(managedRoot.parent);
  }

  function status() {
    return mediaRoot.rootState({
      rootExists: dirExists(managedRoot.root),
      anchorExists: dirExists(managedRoot.anchor),
      invalid: invalid(),
    });
  }

  // The single rule behind every guard below: while our folder is not there, Znada writes
  // nothing, deletes nothing and declares nothing missing. Owner's decision 2026-09-09 —
  // a disk that is absent means the files are temporarily unreachable, not gone.
  function ready() {
    return status().state !== 'unavailable';
  }

  function snapshot() {
    return {
      root: wallpapersDir(),
      trash: trashDirPath(),
      custom: managedRoot.custom,
      parent: managedRoot.parent,
      anchor: managedRoot.anchor,
      ...status(),
    };
  }

  function unavailableError() {
    return new Error('Managed media folder is unavailable');
  }

  // Copy a chosen image into the app's own data dir so it survives app updates and
  // the original being moved/deleted. Returns the copy's path.
  //
  // LIB-022. The copy is named after the original — `<name>-<hash>.<ext>` — because every
  // place that shows a photo's name reads it from the file (see src/photo-import.js). The
  // hash tail is what keeps identical images to one copy: an existing copy of the same
  // bytes is reused whatever it is called, an old `wp-<hash>` one included. The size has
  // to match too, so a file of the user's that merely ends the same way in a folder they
  // picked for copies is never taken for ours.
  /**
   * @param {string} srcPath
   */
  async function importWallpaper(srcPath) {
    // DATA-006. mkdir would happily CREATE the chosen folder on a drive that is merely
    // missing its letter today, and the copy would land somewhere the user never picked.
    if (!ready()) throw unavailableError();
    const dir = wallpapersDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const buf = await fs.promises.readFile(srcPath); // async: не блокируем main-поток на больших файлах
    const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, photoImport.HASH_LENGTH);
    const ext = photoImport.copyExtension(srcPath);
    for (const name of photoImport.existingCopies(await fs.promises.readdir(dir), hash, ext)) {
      const found = path.join(dir, name);
      try {
        const stats = await fs.promises.stat(found);
        if (stats.isFile() && stats.size === buf.length) return found;
      } catch {}
    }
    const dest = path.join(dir, photoImport.copyFileName(srcPath, hash));
    // `wx`: never write over a file that is already there. The search above found nothing
    // of this size, so a file under this exact name is not this picture — it is refused
    // rather than either overwritten or handed back as if it were the photo just added.
    await fs.promises.writeFile(dest, buf, { flag: 'wx' });
    return dest;
  }

  /**
   * @param {string} srcPath
   */
  function watchedFolderShowing(srcPath) {
    const config = getConfig();
    const folders = Object.values((config && config.library) || {})
      .filter((it) => it && it.type === 'folder' && it.path)
      .map((it) => /** @type {string} */ (it.path));
    if (!folders.length) return '';
    /** @type {string[]} */
    let removedDirs = [];
    try { removedDirs = getHiddenDirs(); } catch {}
    return photoImport.watchedFolderFor(srcPath, folders, removedDirs);
  }

  // LIB-023. What adding a local photo puts into the pool: the original itself when a
  // watched folder already shows it — a record by reference, the way a star makes one, so
  // the photo stays one card and keeps the date the folder first saw it — and otherwise
  // Znada's own copy, as before. `extra` goes to addToPool unchanged.
  /**
   * @param {string} srcPath
   */
  async function photoForPool(srcPath) {
    if (watchedFolderShowing(srcPath)) {
      try {
        const stats = await fs.promises.stat(srcPath);
        if (stats.isFile() && imgExts.has(path.extname(srcPath).toLowerCase())) {
          return { path: srcPath, extra: liveMaterializeExtra(srcPath, 'image') };
        }
      } catch {}
    }
    return { path: await importWallpaper(srcPath), extra: undefined };
  }

  // Download a remote image into a private staging file beside its content-addressed
  // destination. The caller exposes it only after any session/ownership check succeeds.
  // That matters for Cloud: writing the shared destination first and later deleting it on
  // a stale result races a second, current operation that may already have adopted it.
  /**
   * @param {string} dir
   * @param {string} url
   * @param {RequestInit & { expectedFormat?: string, fetchImpl?: typeof fetch }} [fetchOptions]
   * @returns {Promise<StagedDownload>}
   */
  async function stageDownloadImage(dir, url, fetchOptions = {}) {
    await fs.promises.mkdir(dir, { recursive: true });
    const options = fetchOptions && typeof fetchOptions === 'object' ? fetchOptions : {};
    // PERF-010. `fetchImpl` says where the bytes come from (see originalFetchFor). Whatever
    // answers, the checks below are the same ones: there is no second, trusting branch.
    const { expectedFormat = '', fetchImpl = defaultFetch || fetch, ...requestOptions } = options;
    const res = await fetchImpl(url, requestOptions);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (expectedFormat) {
      const responseType = res.headers && typeof res.headers.get === 'function'
        ? res.headers.get('content-type')
        : '';
      if (!mediaFormats.mimeMatchesFormat(responseType, expectedFormat)) {
        throw new Error('Unexpected image Content-Type');
      }
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 16);
    let ext = '.jpg';
    try { const e = path.extname(new URL(url).pathname).toLowerCase(); if (/^\.[a-z0-9]{2,5}$/.test(e)) ext = e; } catch {}
    const dest = path.join(dir, `wp-${hash}${ext}`);
    if (fs.existsSync(dest)) return { path: dest, stagingPath: '' };
    const stagingPath = path.join(dir,
      `.download-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      await fs.promises.writeFile(stagingPath, buf, { flag: 'wx' });
    } catch (err) {
      try { fs.rmSync(stagingPath, { force: true }); } catch {}
      throw err;
    }
    return { path: dest, stagingPath };
  }

  // Synchronous after the await-heavy body download. A session cannot change between a
  // caller's final guard, this promotion and the state mutation that takes ownership.
  // If a peer already promoted identical bytes, only our private staging file is removed.
  /**
   * @param {StagedDownload} artifact
   * @param {string} dir
   */
  function commitDownloadArtifact(artifact, dir) {
    if (!artifact || !isDirectChildPath(artifact.path, dir)) {
      throw new Error('Unsafe download artifact path');
    }
    const stagingPath = artifact.stagingPath;
    if (!stagingPath) return { path: artifact.path, created: false };
    if (!isDirectChildPath(stagingPath, dir)) throw new Error('Unsafe download staging path');
    try {
      if (fs.existsSync(artifact.path)) {
        fs.rmSync(stagingPath, { force: true });
        return { path: artifact.path, created: false };
      }
      try {
        fs.renameSync(stagingPath, artifact.path);
        return { path: artifact.path, created: true };
      } catch (err) {
        // Another process may have won between existsSync and rename. A content hash names
        // identical bytes, so its completed destination is the safe deduplicated result.
        if (fs.existsSync(artifact.path)) {
          fs.rmSync(stagingPath, { force: true });
          return { path: artifact.path, created: false };
        }
        throw err;
      }
    } finally {
      try { fs.rmSync(stagingPath, { force: true }); } catch {}
    }
  }

  /**
   * @param {StagedDownload | null | undefined} artifact
   * @param {string} dir
   */
  function discardDownloadArtifact(artifact, dir) {
    const stagingPath = artifact && artifact.stagingPath;
    if (!stagingPath || !isDirectChildPath(stagingPath, dir)) return false;
    try {
      fs.rmSync(stagingPath, { force: true });
      return true;
    } catch (err) {
      log.error('stale Cloud download cleanup:', err);
      return false;
    }
  }

  /**
   * @param {string} dir
   * @param {string} url
   * @param {RequestInit & { expectedFormat?: string, fetchImpl?: typeof fetch }} [fetchOptions]
   */
  async function downloadImageArtifactTo(dir, url, fetchOptions = {}) {
    return commitDownloadArtifact(await stageDownloadImage(dir, url, fetchOptions), dir);
  }

  /**
   * @param {string} dir
   * @param {string} url
   * @param {RequestInit & { expectedFormat?: string, fetchImpl?: typeof fetch }} [fetchOptions]
   */
  async function downloadImageTo(dir, url, fetchOptions = {}) {
    return (await downloadImageArtifactTo(dir, url, fetchOptions)).path;
  }

  // Downloading INTO the library. ONL-009 also needs the same picture somewhere the
  // library does not own — an export or a clipboard copy must not leave an orphan file
  // inside wallpapers/ for the sweeper to find — hence the split above.
  /**
   * @param {string} url
   * @param {RequestInit & { expectedFormat?: string, fetchImpl?: typeof fetch }} [fetchOptions]
   */
  async function downloadWallpaperFromUrl(url, fetchOptions = {}) {
    if (!ready()) throw unavailableError();
    return downloadImageTo(wallpapersDir(), url, fetchOptions);
  }

  return Object.freeze({
    current,
    wallpapersDir,
    trashDirPath,
    refresh,
    systemRoots,
    folderProblem,
    resolveTarget,
    invalid,
    status,
    ready,
    snapshot,
    importWallpaper,
    watchedFolderShowing,
    photoForPool,
    stageDownloadImage,
    commitDownloadArtifact,
    discardDownloadArtifact,
    downloadImageArtifactTo,
    downloadImageTo,
    downloadWallpaperFromUrl,
  });
}

module.exports = { createManagedFolder };
