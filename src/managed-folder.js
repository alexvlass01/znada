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
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
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

// BUG-087. Staging files live inside wallpapersDir() for the whole read/download
// (BUG-076), where nothing references them — so the orphan sweeper has to recognise them
// itself. One name format, written by downloadStagingPath and read by stagingInFlight.
const STAGING_PREFIX = '.download-';
const STAGING_RE = /^\.download-(\d+)-[0-9a-f]+\.tmp$/i;
// A leftover of another process (a crashed run: the single-instance lock means no second
// live process writes into this profile) is swept only after it has stopped changing for
// this long. The pid alone is not trusted — Windows reuses them.
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

/**
 * Must the orphan sweeper leave `name` alone as a staging file still being written?
 * Every staging file of this process is in flight, however old (a stalled download is
 * still ours). Another process's one counts as in flight until it has been untouched for
 * STALE_STAGING_MS; after that it is an ordinary orphan, which the sweeper moves to
 * .trash — never deletes. Names that are not staging files get `false`, so the normal
 * keep-set rules apply to them.
 * @param {string} name
 * @param {number} mtimeMs
 * @param {{ now?: number, pid?: number }} [opts]
 */
function stagingInFlight(name, mtimeMs, { now = Date.now(), pid = process.pid } = {}) {
  const m = STAGING_RE.exec(String(name || ''));
  if (!m) return false;
  if (Number(m[1]) === pid) return true;
  return !(now - Number(mtimeMs) >= STALE_STAGING_MS);
}

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
  // MEDIA-002: a video inside a watched folder is shown by that folder, like a picture.
  const imgExts = new Set(mediaFormats.libraryExtensions());

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
    // MEDIA-002. Streamed, never read whole: a video can be gigabytes, and a Buffer of
    // that size either fails outright (over 2 GB) or holds the whole file in memory.
    const staging = downloadStagingPath(dir);
    const output = await fs.promises.open(staging, 'wx');
    try {
      // Hash the bytes on their way to the staging file. The source can change or
      // disappear once this read ends; publication uses only the captured bytes.
      const digest = crypto.createHash('md5');
      let size = 0;
      const count = new Transform({ transform(chunk, _encoding, next) {
        size += chunk.length;
        digest.update(chunk);
        next(null, chunk);
      } });
      await pipeline(fs.createReadStream(srcPath), count, output.createWriteStream());
      const hash = digest.digest('hex').slice(0, photoImport.HASH_LENGTH);
      const ext = photoImport.copyExtension(srcPath);
      for (const name of photoImport.existingCopies(await fs.promises.readdir(dir), hash, ext)) {
        const found = path.join(dir, name);
        try {
          const stats = await fs.promises.stat(found);
          if (stats.isFile() && stats.size === size) return found;
        } catch {}
      }
      const dest = path.join(dir, photoImport.copyFileName(srcPath, hash));
      // An existing file of a different size at this name is a collision. Do not
      // overwrite it or hand it back as if it were the user's chosen file.
      await fs.promises.copyFile(staging, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } finally {
      try { await output.close(); } catch {}
      try { await fs.promises.unlink(staging); } catch (err) { log.error('import staging cleanup:', err); }
    }
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
    const stagingPath = downloadStagingPath(dir);
    try {
      await fs.promises.writeFile(stagingPath, buf, { flag: 'wx' });
    } catch (err) {
      try { fs.rmSync(stagingPath, { force: true }); } catch {}
      throw err;
    }
    return { path: dest, stagingPath };
  }

  function downloadStagingPath(dir) {
    return path.join(dir, `${STAGING_PREFIX}${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  }

  /** Stream and hash in one pass, with no file-size-dependent memory growth. */
  async function stageDownloadVideo(dir, format, { body, contentLength }, { signal, onProgress }) {
    await fs.promises.mkdir(dir, { recursive: true });
    const stagingPath = downloadStagingPath(dir);
    const hash = crypto.createHash('md5');
    const total = Number(contentLength) || 0;
    let received = 0;
    const count = new Transform({ transform(chunk, _encoding, next) {
      hash.update(chunk);
      received += chunk.length;
      onProgress(received, total);
      next(null, chunk);
    } });
    try {
      await pipeline(body, count, fs.createWriteStream(stagingPath, { flags: 'wx' }), { signal });
      if (!received || (total && received !== total)) throw new Error('Incomplete video download');
      const dest = path.join(dir, `wp-${hash.digest('hex').slice(0, 16)}.${format}`);
      return { path: dest, stagingPath };
    } catch (err) {
      await fs.promises.rm(stagingPath, { force: true });
      throw err;
    }
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
    stageDownloadVideo,
    commitDownloadArtifact,
    discardDownloadArtifact,
    downloadImageArtifactTo,
    downloadImageTo,
    downloadWallpaperFromUrl,
  });
}

module.exports = { createManagedFolder, stagingInFlight, STALE_STAGING_MS };
