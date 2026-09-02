'use strict';

// Global-hotkey domain logic shared by main and renderer.
//
// The renderer turns a DOM KeyboardEvent into an Electron accelerator. The main
// process owns registration and replaces an active accelerator transactionally:
// a working shortcut is never removed until its replacement has registered.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ZnadaHotkey = api;
}(typeof window !== 'undefined' ? window : null, function createApi() {
  const MODIFIER_CODES = new Set([
    'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
    'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  ]);

  const KEY_NAMES = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Space: 'Space',
    Escape: 'Escape',
    Tab: 'Tab',
    CapsLock: 'Capslock',
    NumLock: 'Numlock',
    ScrollLock: 'Scrolllock',
    PrintScreen: 'PrintScreen',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Enter: 'Enter',
    NumpadEnter: 'Enter',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Home: 'Home',
    End: 'End',
    Minus: '-',
    Equal: '=',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Backquote: '`',
    NumpadDecimal: 'numdec',
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    AudioVolumeUp: 'VolumeUp',
    AudioVolumeDown: 'VolumeDown',
    AudioVolumeMute: 'VolumeMute',
    MediaTrackNext: 'MediaNextTrack',
    MediaTrackPrevious: 'MediaPreviousTrack',
    MediaStop: 'MediaStop',
    MediaPlayPause: 'MediaPlayPause',
  };

  const MEDIA_KEYS = new Set([
    'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause',
    'VolumeUp', 'VolumeDown', 'VolumeMute',
  ]);
  const MODIFIER_NAMES = new Set([
    'commandorcontrol', 'cmdorctrl', 'control', 'ctrl',
    'alt', 'altgr', 'shift', 'super', 'meta',
  ]);
  const PRIMARY_MODIFIER_NAMES = new Set([
    'commandorcontrol', 'cmdorctrl', 'control', 'ctrl',
    'alt', 'altgr', 'super', 'meta',
  ]);
  const NAMED_KEYS = new Set([
    'plus', 'space', 'tab', 'capslock', 'numlock', 'scrolllock', 'backspace',
    'delete', 'insert', 'return', 'enter', 'up', 'down', 'left', 'right',
    'home', 'end', 'pageup', 'pagedown', 'escape', 'printscreen',
    'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
  ]);

  function electronKeyName(event) {
    const code = String(event && event.code || '');
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
    if (/^F(?:[1-9]|1\d|2[0-4])$/.test(code)) return code;
    return KEY_NAMES[code] || null;
  }

  function modifierNames(event) {
    const out = [];
    if (event && event.ctrlKey) out.push('Ctrl');
    if (event && event.altKey) out.push('Alt');
    if (event && event.shiftKey) out.push('Shift');
    if (event && event.metaKey) out.push('Super');
    return out;
  }

  function interpretKeydown(event) {
    const code = String(event && event.code || '');
    const modifiers = modifierNames(event);
    if (MODIFIER_CODES.has(code)) {
      return { status: 'waiting', modifiers, display: modifiers.length ? `${modifiers.join(' + ')} + ...` : '' };
    }

    const key = electronKeyName(event);
    if (!key) return { status: 'unsupported', modifiers, key: null };

    // A Shift-only letter/number shortcut would steal ordinary typing system-wide.
    // The UI copy has always promised Ctrl/Alt/Win, F1-F24, or a media key.
    const hasPrimaryModifier = !!(event && (event.ctrlKey || event.altKey || event.metaKey));
    const isFunctionKey = /^F(?:[1-9]|1\d|2[0-4])$/.test(key);
    const isMediaKey = MEDIA_KEYS.has(key);
    if (!hasPrimaryModifier && !isFunctionKey && !isMediaKey) {
      return { status: 'invalid', modifiers, key };
    }

    return { status: 'ok', modifiers, key, accelerator: [...modifiers, key].join('+') };
  }

  // Renderer validation is UX, not a security boundary. Config files and IPC can
  // be edited/called directly, so main must enforce the same policy before asking
  // Windows for a system-wide registration. In particular, a bare letter would
  // steal ordinary typing from every application.
  function validateAccelerator(value) {
    if (typeof value !== 'string' || !value.trim()) return { ok: false, error: 'invalid' };
    const parts = value.split('+').map((part) => part.trim());
    if (parts.some((part) => !part)) return { ok: false, error: 'invalid' };
    const key = parts.pop();
    const modifiers = parts.map((part) => part.toLowerCase());
    if (new Set(modifiers).size !== modifiers.length
      || modifiers.some((modifier) => !MODIFIER_NAMES.has(modifier))) {
      return { ok: false, error: 'invalid' };
    }

    const foldedKey = key.toLowerCase();
    const isFunctionKey = /^f(?:[1-9]|1\d|2[0-4])$/i.test(key);
    const isMediaKey = [...MEDIA_KEYS].some((name) => name.toLowerCase() === foldedKey);
    const isNumpadDigit = /^num[0-9]$/i.test(key);
    const isOrdinaryKey = /^[a-z0-9]$/i.test(key)
      || /^[~!@#$%^&*()_+{}|:"<>?`\-=[\]\\;',./]$/.test(key)
      || NAMED_KEYS.has(foldedKey)
      || isNumpadDigit;
    if (!isFunctionKey && !isMediaKey && !isOrdinaryKey) return { ok: false, error: 'invalid' };

    const hasPrimaryModifier = modifiers.some((modifier) => PRIMARY_MODIFIER_NAMES.has(modifier));
    if (!hasPrimaryModifier && !isFunctionKey && !isMediaKey) return { ok: false, error: 'invalid' };
    return { ok: true, accelerator: [...parts, key].join('+') };
  }

  function createController({ globalShortcut, onTrigger, log = console } = {}) {
    if (!globalShortcut || typeof globalShortcut.register !== 'function'
      || typeof globalShortcut.unregister !== 'function') {
      throw new TypeError('createController: globalShortcut register/unregister are required');
    }
    const trigger = typeof onTrigger === 'function' ? onTrigger : () => {};
    let active = '';
    let suspended = false;

    function prepare(settings) {
      let desired = '';
      if (settings && settings.enabled) {
        const validation = validateAccelerator(settings.shortcut);
        if (!validation.ok) {
          if (log && log.error) log.error('[Hotkey] Invalid accelerator policy:', settings.shortcut);
          return { ok: false, active, changed: false, error: 'invalid' };
        }
        desired = validation.accelerator;
      }
      const previous = active;
      if (desired === previous) {
        return {
          ok: true,
          active,
          desired,
          previous,
          changed: false,
          commit: () => ({ ok: true, active, desired, previous, changed: false }),
          rollback: () => ({ ok: true, active, desired, previous, changed: false }),
        };
      }

      if (desired) {
        let registered = false;
        try {
          registered = globalShortcut.register(desired, () => trigger(desired)) === true;
        } catch (error) {
          if (log && log.error) log.error(`[Hotkey] Registration error for ${desired}:`, error);
          return { ok: false, active, changed: false, error: 'unavailable' };
        }
        if (!registered) {
          if (log && log.error) log.error(`[Hotkey] Registration failed for: ${desired}`);
          return { ok: false, active, changed: false, error: 'unavailable' };
        }
      }

      let settled = false;
      const unregister = (accelerator) => {
        if (!accelerator) return;
        try { globalShortcut.unregister(accelerator); }
        catch (error) { if (log && log.error) log.error('[Hotkey] Unregister failed:', error); }
      };
      return {
        ok: true,
        active,
        desired,
        previous,
        changed: true,
        commit() {
          if (settled) return { ok: false, active, changed: false, error: 'settled' };
          settled = true;
          active = desired;
          unregister(previous);
          return { ok: true, active, desired, previous, changed: true };
        },
        rollback() {
          if (settled) return { ok: false, active, changed: false, error: 'settled' };
          settled = true;
          unregister(desired);
          return { ok: true, active, desired, previous, changed: false };
        },
      };
    }

    function apply(settings) {
      const staged = prepare(settings);
      if (!staged.ok) return staged;
      return staged.commit();
    }

    function setSuspended(value) {
      const desired = !!value;
      if (desired === suspended) return { ok: true, suspended };
      if (typeof globalShortcut.setSuspended !== 'function') {
        return { ok: false, suspended, error: 'unsupported' };
      }
      try {
        globalShortcut.setSuspended(desired);
        suspended = desired;
        return { ok: true, suspended };
      } catch (error) {
        if (log && log.error) log.error('[Hotkey] Suspension change failed:', error);
        return { ok: false, suspended, error: 'unavailable' };
      }
    }

    return {
      apply,
      prepare,
      setSuspended,
      active: () => active,
      suspended: () => suspended,
      dispose() {
        if (suspended && typeof globalShortcut.setSuspended === 'function') {
          try { globalShortcut.setSuspended(false); } catch {}
          suspended = false;
        }
        if (!active) return;
        const previous = active;
        active = '';
        try { globalShortcut.unregister(previous); }
        catch (error) { if (log && log.error) log.error('[Hotkey] Unregister failed:', error); }
      },
    };
  }

  return { electronKeyName, modifierNames, interpretKeydown, validateAccelerator, createController };
}));
