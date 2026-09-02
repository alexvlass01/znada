'use strict';

// ONL-009. One answer to "what can you do with this card", for every card in the app.
//
// Before this, the question was answered in two unrelated places: a local-only
// capability helper in card-interaction.js, and — for online cards — nowhere at all,
// which is why right-clicking a picture in the Online tab did nothing.
//
// The shape here is deliberate, and the owner asked for it explicitly: do not simplify
// in a way that costs us later. So a card is first reduced to a SUBJECT — a plain
// description of what the thing is — and the available actions are computed from that
// description. Adding favourites later is one entry in the registry; adding a new
// provider is one more kind of subject. Neither touches the menu code.
//
// Two rules this file exists to enforce:
//
//   1. An action is offered because the subject can actually DO it, never because of
//      which tab it was found in. Our own catalogue's cards are "online" and yet have
//      no source page, and only a signed link that expires, so neither may be shown.
//   2. Everything that needs the actual image crosses the app's one real boundary
//      ("does this have a local file"), and says so via `needsFile`, so main can route
//      all of them through a single "get me the file" path instead of three downloads.

(function initCardActions(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CardActions = api;
}(typeof window !== 'undefined' ? window : globalThis, function cardActionsFactory() {
  const IMAGE = 'image';
  const FOLDER = 'folder';

  function str(value) {
    return typeof value === 'string' ? value : '';
  }

  // --- subjects -------------------------------------------------------------
  // A card the user already has on disk: a pool record, or a file inside a watched
  // folder that has not earned a record yet (both are "local", they differ only by id).
  function localSubject(record, item = null) {
    const source = record || {};
    const pooled = item || null;
    const type = (pooled && pooled.type === FOLDER) || source.type === FOLDER ? FOLDER : IMAGE;
    return {
      kind: 'local',
      type,
      path: str((pooled && pooled.path) || source.path),
      id: str((pooled && pooled.id) || source.id),
      inLibrary: !!pooled,
      page: str(pooled && pooled.source),
      stableFileUrl: false,
      freshFileUrl: false,
      removedView: !!source.removedView,
      raw: pooled || source,
    };
  }

  // A card from Wallhaven or a booru: it carries a permanent page and a permanent
  // file URL, and it may or may not already be downloaded.
  function internetSubject(item, pooled = null) {
    const source = item || {};
    return {
      kind: 'internet',
      type: IMAGE,
      path: str(pooled && pooled.path),
      id: str(pooled && pooled.id),
      inLibrary: !!pooled,
      page: str(source.page),
      stableFileUrl: !!str(source.full),
      freshFileUrl: false,
      removedView: false,
      raw: source,
    };
  }

  // A card from our own catalogue. Deliberately NOT the same as `internetSubject`:
  // it has no page to open, and its file URL is signed and short-lived, so handing it
  // to the user would hand them a link that dies. Both facts are load-bearing here.
  function cloudSubject(item, pooled = null) {
    const source = item || {};
    return {
      kind: 'cloud',
      type: IMAGE,
      path: str(pooled && pooled.path),
      id: str(pooled && pooled.id),
      inLibrary: !!pooled,
      page: '',
      stableFileUrl: false,
      // ONL-014. The catalogue mints a fresh signed link at click time, so there IS a
      // file to be had even though no lasting URL exists. Declared, because “can a file
      // be produced” is a property of the card, not of which catalogue it came from.
      freshFileUrl: true,
      removedView: false,
      raw: source,
    };
  }

  function isSubject(subject) {
    return !!(subject && typeof subject === 'object' && typeof subject.kind === 'string');
  }

  // Can we produce an actual image file for this card, one way or another? Either it
  // is already on disk, or the provider can give it to us. Folders never can.
  function canProduceFile(subject) {
    if (!isSubject(subject) || subject.type !== IMAGE) return false;
    if (subject.path) return true;                        // already on disk
    // Asked of the CARD, not of which catalogue it came from: either the picture has a
    // lasting URL, or its catalogue can mint a fresh one on demand. A new source that
    // works either way needs nothing added here.
    return !!subject.stableFileUrl || !!subject.freshFileUrl;
  }

  // --- the registry ---------------------------------------------------------
  // `group` only decides where separators fall; `multi` says whether the action makes
  // sense for a whole selection (the UI passes one card today, but the model is ready
  // for several — an explicit request from the owner).
  const ACTIONS = [
    {
      // First, and in the primary group: in the trash this is the thing the user came
      // for, and it is not destructive — putting it below a separator with the delete
      // action would read as if it were.
      id: 'restore',
      labelKey: 'library.restore',
      group: 'primary',
      multi: true,
      needsFile: false,
      applies: (s) => s.kind === 'local' && s.removedView,
    },
    {
      id: 'open',
      labelKey: 'library.open',
      group: 'primary',
      multi: false,
      needsFile: false,
      applies: (s) => s.kind === 'local' && s.type === FOLDER && !s.removedView,
    },
    {
      id: 'add',
      labelKey: 'online.add',
      group: 'primary',
      multi: true,
      // Adding downloads the picture, so a provider that gave us no usable file URL
      // cannot be offered it — the action would only ever fail.
      needsFile: true,
      applies: (s) => s.kind !== 'local' && !s.inLibrary && canProduceFile(s),
    },
    {
      id: 'assign',
      labelKey: 'library.assign',
      group: 'primary',
      multi: true,
      // An online picture must be downloaded before a monitor can show it. The owner
      // confirmed that assigning therefore puts it in the library too.
      needsFile: true,
      applies: (s) => !s.removedView && (s.kind === 'local' ? !!s.path : canProduceFile(s)),
    },
    {
      id: 'favorite',
      labelKey: 'library.favoriteAdd',
      group: 'primary',
      multi: true,
      needsFile: false,
      // Online favourites are deliberately absent until the unified model lands; the
      // debt is tracked with the unified-favourites work.
      applies: (s) => s.kind === 'local' && !s.removedView,
    },
    {
      id: 'tags',
      labelKey: 'library.editTags',
      group: 'primary',
      multi: false,
      needsFile: false,
      applies: (s) => s.kind === 'local' && !s.removedView,
    },
    {
      // META-001. Asks an online catalogue what it knows about this exact file, and
      // writes the answer onto the record.
      //
      // Deliberately NOT limited to photos that already have a pool record. The first
      // cut required one, and in the app that meant the action vanished for most of the
      // library: everything inside a watched folder is a file without a record until it
      // is used. "Change tags" sits right next to it, applies to exactly those photos,
      // and makes the record when the user commits — so this does the same. Tags need a
      // record to live on either way; what matters is that the record appears because
      // the user acted, not because he opened a menu.
      id: 'lookupMeta',
      labelKey: 'card.lookupMeta',
      group: 'primary',
      multi: true,
      needsFile: true,
      applies: (s) => s.kind === 'local' && !s.removedView && s.type === IMAGE && !!s.path,
    },
    {
      id: 'details',
      labelKey: 'library.details',
      group: 'primary',
      multi: false,
      needsFile: false,
      // The details sheet reads metadata from a file on disk, so it stays local-only
      // in this slice. Making it work without a file is its own task.
      applies: (s) => s.kind === 'local',
    },

    {
      id: 'saveAs',
      labelKey: 'card.saveAs',
      group: 'transfer',
      multi: true,
      needsFile: true,
      applies: (s) => !s.removedView && canProduceFile(s),
    },
    {
      id: 'copyFile',
      labelKey: 'card.copyFile',
      group: 'transfer',
      multi: false,
      needsFile: true,
      applies: (s) => !s.removedView && canProduceFile(s),
    },
    {
      id: 'copyLink',
      labelKey: 'card.copyLink',
      group: 'transfer',
      multi: false,
      needsFile: false,
      // A page URL, not a file URL — and never a signed one, which is why this asks
      // for `page` rather than for "is it online".
      applies: (s) => !s.removedView && !!s.page,
    },
    {
      id: 'openSource',
      labelKey: 'details.openSource',
      group: 'transfer',
      multi: false,
      needsFile: false,
      applies: (s) => !s.removedView && !!s.page,
    },

    {
      id: 'remove',
      labelKey: 'library.remove',
      group: 'danger',
      danger: true,
      multi: true,
      needsFile: false,
      applies: (s) => !s.removedView && (s.kind === 'local' ? true : s.inLibrary),
    },
    {
      id: 'deleteForever',
      labelKey: 'library.deleteForever',
      group: 'danger',
      danger: true,
      multi: true,
      needsFile: false,
      applies: (s) => s.kind === 'local' && s.removedView && s.type !== FOLDER,
    },
  ];

  const BY_ID = new Map(ACTIONS.map((action) => [action.id, action]));

  function actionById(id) {
    return BY_ID.get(id) || null;
  }

  // Which actions apply to this card, or to ALL of these cards. An action offered for
  // a selection must be valid for every member of it: a menu that silently skips some
  // of what the user selected is worse than not offering the action.
  //
  // `features` carries build-time switches that are not properties of the card itself
  // (today only physicalDelete, which is off in production).
  function actionsFor(input, features = {}) {
    const subjects = (Array.isArray(input) ? input : [input]).filter(isSubject);
    if (!subjects.length) return [];
    const many = subjects.length > 1;
    // `only` is what the SURFACE can carry out, which is a different question from what
    // the CARD can do: the fullscreen viewer has no tag editor or details sheet, so it
    // must not offer them however capable the picture is. Kept as a caller-supplied
    // list rather than a property of the action, so the registry stays about photos.
    const only = Array.isArray(features.only) ? new Set(features.only) : null;
    return ACTIONS.filter((action) => {
      if (only && !only.has(action.id)) return false;
      if (many && !action.multi) return false;
      if (action.id === 'deleteForever' && !features.physicalDelete) return false;
      return subjects.every((subject) => action.applies(subject));
    });
  }

  // Same list, already split into the groups the menu draws separators between, with
  // empty groups dropped so no stray line is ever rendered.
  function menuGroupsFor(input, features = {}) {
    const actions = actionsFor(input, features);
    const order = ['primary', 'transfer', 'danger'];
    return order
      .map((group) => actions.filter((action) => action.group === group))
      .filter((group) => group.length > 0);
  }

  // What main is told about a card. Deliberately small: a kind, the pool id if there
  // is one, and the provider's own item for the online kinds. No URLs are decided
  // here — main validates or looks up every address itself.
  function descriptorFor(subject) {
    if (!isSubject(subject)) return null;
    return {
      kind: subject.kind,
      id: subject.id || '',
      item: subject.kind === 'local' ? null : (subject.raw || null),
    };
  }

  return {
    ACTIONS,
    actionById,
    actionsFor,
    menuGroupsFor,
    canProduceFile,
    descriptorFor,
    localSubject,
    internetSubject,
    cloudSubject,
  };
}));
