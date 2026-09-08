'use strict';

// ONL-016. WHAT the "Details" sheet says about a card — for every card, not only for
// the ones that already have a file on disk.
//
// The sheet used to be built around a file path: it asked the disk for width, height,
// size and modification time, and drew what came back. So it was offered only for local
// photos, and the card menu said as much in a comment ("making it work without a file
// is its own task"). That contradicted the rule the owner set for this app — a photo
// behaves the same way whatever it came from — and it withheld exactly what a person
// browsing a catalogue wants BEFORE downloading: how big is this, and where is it from.
//
// So "what does this sheet contain" is separated from "how is it drawn". This file
// answers the first question and nothing else: it is pure, touches no DOM and no
// network, and is tested. The renderer draws the model it returns.
//
// A card that cannot state a fact gets no row for it. That is deliberate rather than
// lazy: measured against the live APIs on 2026-09-03, Wallhaven and Danbooru report the
// file size in bytes and Gelbooru has no size field of any kind. An empty
// "File size: unknown" row would read as a failure of ours instead of a fact about that
// site — and Gelbooru is the booru Znada asks first.

(function initCardDetails(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CardDetails = api;
}(typeof window !== 'undefined' ? window : globalThis, function cardDetailsFactory() {
  const FOLDER = 'folder';

  function str(value) {
    return typeof value === 'string' ? value : '';
  }

  function positive(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // A link is offered only when it is a real web address. A provenance marker or a
  // relative fragment must never become a clickable button that goes nowhere.
  function isOpenableUrl(value) {
    const raw = str(value);
    if (!raw) return false;
    try {
      const parsed = new URL(raw);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch { return false; }
  }

  // 'znada:' / 'lumina:' are origin markers written into a downloaded record, not
  // addresses. 'lumina:' is the app's former name, and records carrying it are never
  // rewritten, so both spellings have to stay understood here for good.
  function sourceLabel(value) {
    const raw = str(value);
    const low = raw.toLowerCase();
    return low.startsWith('znada:') || low.startsWith('lumina:') ? 'Znada' : raw;
  }

  // Two different scales reach this sheet and they must not be mixed up. A pool record
  // carries the catalogue's own word for a post ('general'…'explicit', written by
  // META-001). A card still in the feed carries the three-level bucket every site is
  // mapped into for the content filter ('sfw'/'sketchy'/'nsfw'), because that is the
  // scale the user actually chooses in. Both are spelled with the SAME three labels
  // instead of a fourth vocabulary: the middle bucket holds 'sensitive' and
  // 'questionable' together, so the milder of the two words is the honest one for it.
  // An unknown word yields no row at all, so a site inventing one cannot leak a bare
  // English token into the interface.
  const RATING_KEYS = {
    general: 'details.ratingGeneral',
    safe: 'details.ratingGeneral',
    sensitive: 'details.ratingSensitive',
    questionable: 'details.ratingQuestionable',
    explicit: 'details.ratingExplicit',
    sfw: 'details.ratingGeneral',
    sketchy: 'details.ratingSensitive',
    nsfw: 'details.ratingExplicit',
  };

  function ratingKey(value) {
    return RATING_KEYS[str(value).toLowerCase()] || '';
  }

  // The last path segment of a URL, which for every site Znada asks is the picture's
  // own file name. Used as the sheet's title so an online card is headed the same way a
  // local one is.
  function fileNameFromUrl(url) {
    const raw = str(url);
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      const last = parsed.pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(last);
    } catch { return ''; }
  }

  function resolutionText(width, height) {
    const w = positive(width);
    const h = positive(height);
    return w && h ? `${w} × ${h}` : '';
  }

  function tagList(value, max = 80) {
    const list = Array.isArray(value) ? value : [];
    const out = [];
    for (const tag of list) {
      const name = str(tag).trim();
      if (name) out.push(name);
    }
    return { shown: out.slice(0, max), hidden: Math.max(0, out.length - max) };
  }

  // --- the local sheet ------------------------------------------------------
  // Row order is unchanged from the sheet that shipped: three of these rows are filled
  // in from disk after the sheet is already on screen, and they are declared as
  // `pending` so it never appears empty while that read is in flight.
  function localRows(subject, item) {
    const isFolder = (item && item.type === FOLDER) || subject.type === FOLDER;
    const path = str((item && item.path) || subject.path);
    const rows = [
      { id: 'type', labelKey: 'details.type', kind: 'i18n', valueKey: isFolder ? 'details.typeFolder' : 'details.typeImage' },
    ];
    if (!isFolder) {
      rows.push({ id: 'resolution', labelKey: 'details.resolution', kind: 'pending', fill: 'resolution' });
      rows.push({ id: 'size', labelKey: 'details.size', kind: 'pending', fill: 'size' });
    }
    if (item && positive(item.addedAt)) {
      rows.push({ id: 'added', labelKey: 'details.added', kind: 'date', value: Number(item.addedAt) });
    }
    rows.push({ id: 'modified', labelKey: 'details.modified', kind: 'pending', fill: 'modified' });
    if (item && str(item.author)) {
      rows.push({ id: 'author', labelKey: 'details.author', kind: 'text', value: str(item.author) });
    }
    const rating = ratingKey(item && item.rating);
    if (rating) rows.push({ id: 'rating', labelKey: 'details.rating', kind: 'i18n', valueKey: rating });
    if (item && str(item.source)) {
      rows.push({
        id: 'source',
        labelKey: 'details.source',
        kind: isOpenableUrl(item.source) ? 'link' : 'text',
        value: sourceLabel(item.source),
        action: isOpenableUrl(item.source) ? 'openSource' : '',
        wide: true,
      });
    }
    rows.push({ id: 'path', labelKey: 'details.path', kind: 'mono', value: path, wide: true });
    const tags = tagList(item && item.tags);
    if (tags.shown.length) {
      rows.push({ id: 'tags', labelKey: 'details.tags', kind: 'tags', values: tags.shown, hidden: tags.hidden, wide: true });
    }
    return rows;
  }

  // --- an online sheet ------------------------------------------------------
  // Everything here is already in the card that the feed drew, so the sheet is complete
  // the instant it opens: no disk to read, no second request to the site.
  function onlineRows(subject, providerName) {
    const card = (subject.raw && typeof subject.raw === 'object') ? subject.raw : {};
    const rows = [];
    if (providerName) {
      rows.push({ id: 'site', labelKey: 'details.site', kind: 'text', value: providerName });
    }
    rows.push({ id: 'type', labelKey: 'details.type', kind: 'i18n', valueKey: 'details.typeImage' });
    const resolution = resolutionText(card.width, card.height);
    if (resolution) {
      rows.push({ id: 'resolution', labelKey: 'details.resolution', kind: 'text', value: resolution });
    }
    // Absent for a site that does not report it — see the note at the top of this file.
    if (positive(card.fileSize)) {
      rows.push({ id: 'size', labelKey: 'details.size', kind: 'bytes', value: Number(card.fileSize) });
    }
    if (str(card.format)) {
      rows.push({ id: 'format', labelKey: 'details.format', kind: 'text', value: str(card.format).toUpperCase() });
    }
    // Boorus name the artist; Wallhaven does not, and says so by leaving it empty.
    if (str(card.artist)) {
      rows.push({ id: 'author', labelKey: 'details.author', kind: 'text', value: str(card.artist) });
    }
    const rating = ratingKey(card.purity);
    if (rating) rows.push({ id: 'rating', labelKey: 'details.rating', kind: 'i18n', valueKey: rating });
    // "Where is it from" has two honest answers and they are different things: the post
    // page on the site Znada asked, and — on a booru — the address the uploader credited
    // as the original. Both are shown when both exist; neither is invented.
    if (isOpenableUrl(subject.page)) {
      rows.push({
        id: 'page',
        labelKey: 'details.source',
        kind: 'link',
        value: str(subject.page),
        action: 'openSource',
        wide: true,
      });
    }
    const original = str(card.source);
    if (isOpenableUrl(original) && original !== str(subject.page)) {
      rows.push({ id: 'original', labelKey: 'details.originalSource', kind: 'text', value: original, wide: true });
    }
    const tags = tagList(card.tags);
    if (tags.shown.length) {
      rows.push({ id: 'tags', labelKey: 'details.tags', kind: 'tags', values: tags.shown, hidden: tags.hidden, wide: true });
    }
    return rows;
  }

  // --- footer actions -------------------------------------------------------
  // Only what this card can really do. A catalogue card has no page and only a signed
  // link that expires, so it is left with no footer at all rather than with buttons
  // that would hand the user a dead address.
  function actionsFor(subject, item) {
    if (subject.kind === 'local') {
      const actions = [
        { id: 'openFolder', labelKey: 'details.openFolder' },
        { id: 'copyPath', labelKey: 'details.copyPath' },
      ];
      if (item && isOpenableUrl(item.source)) {
        actions.push({ id: 'openSource', labelKey: 'details.openSource' });
      }
      return actions;
    }
    const actions = [];
    if (isOpenableUrl(subject.page)) actions.push({ id: 'openSource', labelKey: 'details.openSource' });
    if (subject.stableFileUrl) actions.push({ id: 'copyLink', labelKey: 'card.copyLink' });
    return actions;
  }

  function titleFor(subject, item, providerName) {
    if (subject.kind === 'local') {
      const path = str((item && item.path) || subject.path);
      const parts = path.split(/[\\/]/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : path;
    }
    const card = (subject.raw && typeof subject.raw === 'object') ? subject.raw : {};
    return str(card.title) || fileNameFromUrl(card.full) || providerName || str(subject.id);
  }

  // What the sheet should show as its picture. The local path and the online card need
  // different fetches, so the model states which, and the renderer performs it — the
  // same split as everywhere else in this file.
  function previewFor(subject, item) {
    if (subject.kind === 'local') {
      const isFolder = (item && item.type === FOLDER) || subject.type === FOLDER;
      const path = str((item && item.path) || subject.path);
      return isFolder || !path ? null : { kind: 'local', path };
    }
    const card = (subject.raw && typeof subject.raw === 'object') ? subject.raw : {};
    if (!str(card.thumb)) return null;
    // ONL-012: the card itself says whether its site may be loaded straight from the
    // window, or has to come through main because the site demands a Referer.
    return { kind: 'online', item: card, loadsDirectly: !!card.loadsDirectly };
  }

  /**
   * The whole sheet, decided.
   * @param {object} subject a CardActions subject
   * @param {{ item?: object|null, providerNames?: Record<string,string> }} opts
   */
  function buildDetailsModel(subject, opts) {
    if (!subject || typeof subject !== 'object' || typeof subject.kind !== 'string') return null;
    const options = opts || {};
    const item = options.item || null;
    const names = options.providerNames || {};
    const card = (subject.raw && typeof subject.raw === 'object') ? subject.raw : {};
    const providerName = subject.kind === 'local' ? '' : str(names[str(card.provider)]);
    const local = subject.kind === 'local';
    return {
      kind: subject.kind,
      title: titleFor(subject, item, providerName),
      // The one thing the renderer still needs a path for: the disk read, and the two
      // local footer actions. Empty for every online card, which is the whole point.
      path: local ? str((item && item.path) || subject.path) : '',
      readsDisk: local,
      rows: local ? localRows(subject, item) : onlineRows(subject, providerName),
      actions: actionsFor(subject, item),
      preview: previewFor(subject, item),
    };
  }

  return {
    RATING_KEYS,
    buildDetailsModel,
    fileNameFromUrl,
    isOpenableUrl,
    ratingKey,
    resolutionText,
    sourceLabel,
    tagList,
  };
}));
