'use strict';

// I18N-SEM step 2: derive translation context from the places where a key is used.
// This module deliberately has no filesystem or parser dependency. Znada's HTML and
// JavaScript are regular enough for a small deterministic lexer, and keeping the core
// pure makes the extractor easy to test and reuse from the i18n linter.

const { flatten } = require('./i18n-state');

const SCHEMA_VERSION = 1;
const DEFAULT_SOURCE_FILES = [
  'main.js',
  'renderer/index.html',
  'renderer/renderer.js',
  'renderer/viewer.js',
  'src/tray.js',
  // Подписи Главной про следующую смену выбираются здесь, а не в renderer: файл
  // отдаёт готовый ключ. Без него эти строки остались бы без контекста и без
  // проверки ссылок на несуществующий ключ.
  'src/next-change.js',
  // ONL-009 moved the card menu, its labels and the messages its actions produce out of
  // renderer.js into shared modules that BOTH windows load. The keys went with them, so
  // scanning only renderer.js left the whole `card.*` family without context — and a key
  // with no context is one a translator has to guess at. META-001's lookup messages live
  // here too.
  'renderer/card-actions.js',
  'renderer/card-transfer.js',
  'renderer/card-metadata.js',
  'renderer/online-browse.js',
];

// Dynamic templates cannot reveal their finite members by syntax alone. Keep the
// small runtime domain explicit so deleting one member from en.json is still caught.
const DYNAMIC_KEY_FAMILIES = {
  'online.rating*': [
    'online.ratingGeneral',
    'online.ratingSuggestive',
    'online.ratingExplicit',
  ],
};

const I18N_ATTRS = {
  'data-i18n': 'data-i18n',
  'data-i18n-title': 'data-i18n-title',
  'data-i18n-tooltip': 'data-i18n-tooltip',
  'data-i18n-ph': 'data-i18n-ph',
};

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function parseHtmlAttributes(raw) {
  const attrs = {};
  const re = /([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(raw))) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function classList(attrs) {
  return String((attrs && attrs.class) || '').split(/\s+/).filter(Boolean);
}

function selectorFor(tag, attrs) {
  if (attrs.id) return `#${attrs.id}`;
  const classes = classList(attrs).slice(0, 2);
  return classes.length ? `${tag}.${classes.join('.')}` : tag;
}

function namespaceArea(key) {
  const namespace = String(key || '').split('.')[0];
  const areas = {
    nav: 'navigation',
    prefs: 'preferences',
    lang: 'language-picker',
    welcome: 'welcome',
    home: 'home',
    status: 'home.status',
    design: 'design',
    theme: 'design.theme',
    slideshow: 'design.slideshow',
    order: 'design.slideshow',
    style: 'design.wallpaper-style',
    monitor: 'monitors',
    triggers: 'design.triggers',
    library: 'library',
    details: 'library.details',
    viewer: 'media-viewer',
    viewerBg: 'preferences.viewer',
    online: 'online',
    journal: 'preferences.event-journal',
    notify: 'windows-notification',
    toast: 'global.toast',
    shortcuts: 'preferences.shortcuts',
    tray: 'system-tray',
    smart: 'home.smart-panel',
    val: 'global',
  };
  return areas[namespace] || 'global';
}

function suffixKind(key) {
  if (/^toast\./.test(key)) return 'toast';
  if (/^tray\./.test(key)) return 'menu-item';
  if (/^notify\..*Title$/.test(key)) return 'notification-title';
  if (/^notify\..*Body$/.test(key)) return 'notification-body';
  if (/^journal\./.test(key)) return 'event-message';
  if (/^smart\.tips\.\d+$/.test(key)) return 'tip';
  if (/(?:Tooltip|Hint)$/.test(key)) return 'tooltip';
  if (/(?:Ph|Placeholder)$/.test(key)) return 'placeholder';
  if (/(?:Group|Title)$/.test(key)) return 'heading';
  if (/(?:Sub|Subtitle|Body|Text)$/.test(key)) return 'description';
  if (/(?:Error|Failed|Failure)$/.test(key)) return 'error-message';
  return 'label';
}

function htmlViewArea(nodes, key) {
  const all = nodes.slice().reverse();
  for (const node of all) {
    const id = node.attrs.id || '';
    const view = /^view(.+)$/.exec(id);
    if (view) {
      const name = view[1].toLowerCase();
      if (name === 'prefs') return 'preferences';
      return name;
    }
    if (id === 'titlebar' || node.tag === 'nav') return 'navigation';
    if (/viewer/i.test(id) || classList(node.attrs).some((x) => /viewer/.test(x))) return 'media-viewer';
    if (/details/i.test(id) || classList(node.attrs).some((x) => /details/.test(x))) return 'library.details';
  }
  return namespaceArea(key);
}

function inferHtmlKind(tag, attr, attrs, ancestors) {
  if (attr === 'data-i18n-title' || attr === 'data-i18n-tooltip') return 'tooltip';
  if (attr === 'data-i18n-ph') return 'placeholder';
  const classes = classList(attrs);
  if (tag === 'button' || ancestors.some((node) => node.tag === 'button')) return 'button';
  if (tag === 'option') return 'option';
  if (/^h[1-6]$/.test(tag) || classes.includes('group-title')) return 'heading';
  if (tag === 'label' || classes.includes('row-title')) return 'setting-title';
  if (
    tag === 'p'
    || tag === 'small'
    || classes.includes('row-sub')
    || classes.some((name) => /(?:^|-)sub(?:$|-)/.test(name))
  ) return 'description';
  if (classes.includes('navbtn')) return 'navigation-item';
  return 'label';
}

function makeLineIndex(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (offset) => {
    let lo = 0;
    let hi = starts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  };
}

function scanHtml(source, file, referenceKeys) {
  const contexts = [];
  const definiteReferences = new Set();
  const references = new Set(referenceKeys);
  const stack = [];
  const positionAt = makeLineIndex(source);
  const tokenRe = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g;
  let token;

  while ((token = tokenRe.exec(source))) {
    const raw = token[0];
    if (raw.startsWith('<!--')) continue;
    const closing = /^<\//.test(raw);
    const nameMatch = /^<\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(raw);
    if (!nameMatch) continue;
    const tag = nameMatch[1].toLowerCase();

    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const popped = stack.pop();
        if (popped.tag === tag) break;
      }
      continue;
    }

    const attrs = parseHtmlAttributes(raw.slice(nameMatch[0].length, raw.length - 1));
    const current = { tag, attrs };
    const nodes = [...stack, current];

    for (const attr of Object.keys(I18N_ATTRS)) {
      const key = attrs[attr];
      if (!key) continue;
      definiteReferences.add(key);
      if (!references.has(key)) continue;
      const attrOffset = raw.indexOf(key);
      const pos = positionAt(token.index + Math.max(0, attrOffset));
      const context = {
        type: inferHtmlKind(tag, attr, attrs, stack),
        area: htmlViewArea(nodes, key),
        file,
        line: pos.line,
        column: pos.column,
        via: I18N_ATTRS[attr],
        confidence: 'high',
        element: tag,
        selector: selectorFor(tag, attrs),
      };
      contexts.push({ key, context });
    }

    if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(raw)) stack.push(current);
  }

  return { contexts, definiteReferences };
}

// Replace JavaScript comments while preserving strings and offsets. This prevents
// examples in comments from becoming fake references in the generated catalog.
function maskJsComments(source) {
  const out = source.split('');
  let state = 'code';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      else if (ch === '/' && next === '/') {
        out[i] = out[i + 1] = ' ';
        state = 'line-comment';
        i++;
      } else if (ch === '/' && next === '*') {
        out[i] = out[i + 1] = ' ';
        state = 'block-comment';
        i++;
      }
      continue;
    }
    if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
      else out[i] = ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        out[i] = out[i + 1] = ' ';
        state = 'code';
        i++;
      } else if (ch !== '\n' && ch !== '\r') out[i] = ' ';
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (
      (state === 'single' && ch === "'")
      || (state === 'double' && ch === '"')
      || (state === 'template' && ch === '`')
    ) state = 'code';
  }
  return out.join('');
}

// A second mask keeps only executable punctuation/identifiers. It is used for brace
// ranges, so braces inside a string or comment cannot end a function/object early.
function maskJsNonCode(source) {
  const out = source.split('');
  let state = 'code';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === "'" || ch === '"' || ch === '`') {
        state = ch === "'" ? 'single' : ch === '"' ? 'double' : 'template';
        out[i] = ' ';
      } else if (ch === '/' && next === '/') {
        out[i] = out[i + 1] = ' ';
        state = 'line-comment';
        i++;
      } else if (ch === '/' && next === '*') {
        out[i] = out[i + 1] = ' ';
        state = 'block-comment';
        i++;
      }
      continue;
    }
    if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
      else out[i] = ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        out[i] = out[i + 1] = ' ';
        state = 'code';
        i++;
      } else if (ch !== '\n' && ch !== '\r') out[i] = ' ';
      continue;
    }
    if (ch === '\\') {
      out[i] = ' ';
      if (i + 1 < out.length) out[++i] = ' ';
      continue;
    }
    if (
      (state === 'single' && ch === "'")
      || (state === 'double' && ch === '"')
      || (state === 'template' && ch === '`')
    ) {
      out[i] = ' ';
      state = 'code';
    } else if (ch !== '\n' && ch !== '\r') out[i] = ' ';
  }
  return out.join('');
}

function regexCanStartAt(source, offset) {
  let i = offset - 1;
  while (i >= 0 && /\s/.test(source[i])) i--;
  if (i < 0) return true;
  if (/[([{,:;=!?&|+\-*%^~<>]/.test(source[i])) return true;
  if (source[i] === ')') {
    let depth = 1;
    let open = i - 1;
    for (; open >= 0; open--) {
      if (source[open] === ')') depth++;
      else if (source[open] === '(' && --depth === 0) break;
    }
    if (open >= 0) {
      const beforeControl = source.slice(0, open).trimEnd();
      if (/\b(?:if|while|for|with|switch|catch)$/.test(beforeControl)) return true;
    }
  }
  const before = source.slice(0, i + 1);
  const word = /([A-Za-z_$][\w$]*)$/.exec(before);
  return Boolean(
    word
    && /^(?:return|case|throw|yield|await|typeof|delete|void|new|else|do)$/.test(word[1]),
  );
}

// Return real JavaScript string/template tokens, excluding comments and regex
// literals. Template-expression code is scanned recursively, while raw template
// prose is kept inside the outer token and cannot fake a t('key') call.
function lexJavaScriptStrings(source) {
  const tokens = [];
  const templateExpressions = [];

  function readQuoted(start, quote, end) {
    let i = start + 1;
    while (i < end) {
      if (source[i] === '\\') {
        i += 2;
        continue;
      }
      if (source[i] === quote) {
        tokens.push({
          quote,
          value: source.slice(start + 1, i),
          start,
          contentStart: start + 1,
          end: i + 1,
          dynamic: false,
        });
        return i + 1;
      }
      i++;
    }
    return end;
  }

  function skipRegex(start, end) {
    let inClass = false;
    let i = start + 1;
    while (i < end) {
      const ch = source[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        i++;
        while (i < end && /[A-Za-z]/.test(source[i])) i++;
        return i;
      }
      i++;
    }
    return end;
  }

  function readTemplate(start, end) {
    let i = start + 1;
    let dynamic = false;
    while (i < end) {
      if (source[i] === '\\') {
        i += 2;
        continue;
      }
      if (source[i] === '`') {
        tokens.push({
          quote: '`',
          value: source.slice(start + 1, i),
          start,
          contentStart: start + 1,
          end: i + 1,
          dynamic,
        });
        return i + 1;
      }
      if (source[i] === '$' && source[i + 1] === '{') {
        dynamic = true;
        const closing = scanCode(i + 2, end, true);
        if (closing < end) templateExpressions.push({ start: i + 2, end: closing });
        i = closing < end ? closing + 1 : end;
        continue;
      }
      i++;
    }
    return end;
  }

  function scanCode(start, end, stopAtBrace = false) {
    let braceDepth = 0;
    let i = start;
    while (i < end) {
      const ch = source[i];
      const next = source[i + 1];
      if (stopAtBrace && ch === '}') {
        if (braceDepth === 0) return i;
        braceDepth--;
        i++;
        continue;
      }
      if (stopAtBrace && ch === '{') {
        braceDepth++;
        i++;
        continue;
      }
      if (ch === '/' && next === '/') {
        i += 2;
        while (i < end && source[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < end && !(source[i] === '*' && source[i + 1] === '/')) i++;
        i = Math.min(end, i + 2);
        continue;
      }
      if (ch === "'" || ch === '"') {
        i = readQuoted(i, ch, end);
        continue;
      }
      if (ch === '`') {
        i = readTemplate(i, end);
        continue;
      }
      if (ch === '/' && regexCanStartAt(source, i)) {
        i = skipRegex(i, end);
        continue;
      }
      i++;
    }
    return end;
  }

  scanCode(0, source.length);
  const sorted = tokens.sort((a, b) => a.start - b.start || a.end - b.end);
  Object.defineProperty(sorted, 'templateExpressions', {
    value: templateExpressions.sort((a, b) => a.start - b.start || a.end - b.end),
  });
  return sorted;
}

function maskJsStructure(source, stringTokens) {
  const out = maskJsNonCode(source).split('');
  const expressions = Array.from((stringTokens && stringTokens.templateExpressions) || [])
    .sort((a, b) => (b.end - b.start) - (a.end - a.start));
  for (const expression of expressions) {
    const masked = maskJsNonCode(source.slice(expression.start, expression.end));
    for (let i = 0; i < masked.length; i++) out[expression.start + i] = masked[i];
  }
  return out.join('');
}

function matchingBrace(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function matchingParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

const KEY_ARGUMENTS_BY_CALL = {
  t: new Set([0]),
  tMain: new Set([0]),
  tPath: new Set([1]),
  setLibEmptyText: new Set([0]),
  addAction: new Set([2]),
  reportChannelFailure: new Set([1]),
  reportChannelSuccess: new Set([1]),
};

function namedCallRanges(code) {
  const accepted = new Set(Object.keys(KEY_ARGUMENTS_BY_CALL));
  const ranges = [];
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = re.exec(code))) {
    const name = match[1];
    if (!accepted.has(name)) continue;
    const open = code.indexOf('(', match.index + name.length);
    const end = open >= 0 ? matchingParen(code, open) : -1;
    if (end >= 0) ranges.push({ name, start: open, end });
  }
  return ranges;
}

function containingCall(ranges, offset) {
  return ranges
    .filter((range) => range.start <= offset && offset <= range.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] || null;
}

function callArgumentIndex(code, call, offset) {
  if (!call || offset <= call.start || offset >= call.end) return -1;
  let index = 0;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  for (let i = call.start + 1; i < offset; i++) {
    switch (code[i]) {
      case '(': parens++; break;
      case ')': if (parens > 0) parens--; break;
      case '[': brackets++; break;
      case ']': if (brackets > 0) brackets--; break;
      case '{': braces++; break;
      case '}': if (braces > 0) braces--; break;
      case ',':
        if (parens === 0 && brackets === 0 && braces === 0) index++;
        break;
      default:
        break;
    }
  }
  return index;
}

function keyCallAt(code, calls, offset) {
  const call = containingCall(calls, offset);
  if (call) {
    const acceptedArguments = KEY_ARGUMENTS_BY_CALL[call.name];
    if (acceptedArguments && acceptedArguments.has(callArgumentIndex(code, call, offset))) {
      return call.name;
    }
    return '';
  }
  return '';
}

function namedRanges(code) {
  const ranges = [];
  const patterns = [
    { kind: 'function', re: /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g },
    {
      kind: 'function',
      re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g,
    },
    { kind: 'object', re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g },
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.re.exec(code))) {
      const open = code.indexOf('{', match.index);
      const end = open >= 0 ? matchingBrace(code, open) : -1;
      if (end >= 0) {
        ranges.push({
          name: match[1],
          kind: pattern.kind,
          declarationStart: match.index,
          start: open,
          end,
        });
      }
    }
  }
  return ranges;
}

function containingRange(ranges, offset, kind) {
  return ranges
    .filter((range) => range.kind === kind && range.start <= offset && offset <= range.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] || null;
}

function jsContextWindow(source, offset) {
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const lineEndRaw = source.indexOf('\n', offset);
  const lineEnd = lineEndRaw < 0 ? source.length : lineEndRaw;
  const line = source.slice(lineStart, lineEnd);
  // Multi-line helper calls commonly put t('key') on its own continuation line.
  // Include the previous line only in that shape; ordinary assignment lines stay
  // isolated so a toast on the preceding line cannot contaminate their sink type.
  if (/^\s*(?:t|tMain)\s*\(/.test(line)) {
    const previousStart = source.lastIndexOf('\n', Math.max(0, lineStart - 2)) + 1;
    return source.slice(previousStart, lineEnd);
  }
  return line;
}

function linePrefix(source, offset) {
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  return source.slice(lineStart, offset);
}

function literalPropertyBefore(source, offset) {
  const match = /\b([A-Za-z_$][\w$]*)\s*:\s*$/.exec(linePrefix(source, offset));
  return match ? match[1] : '';
}

function objectPropertyBeforeCall(source, offset) {
  const match = /\b([A-Za-z_$][\w$]*)\s*:[^,;{}]*\b(?:t|tMain)\s*\(\s*$/.exec(
    linePrefix(source, offset),
  );
  return match ? match[1] : '';
}

function datasetAssignmentBefore(source, offset) {
  return /\.dataset\.i18n\s*=\s*[^;]*$/.test(linePrefix(source, offset));
}

function discoverElementKinds(source) {
  const kinds = new Map();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.createElement\(\s*(['"])([A-Za-z][\w-]*)\2\s*\)/g;
  let match;
  while ((match = re.exec(maskJsComments(source)))) {
    const name = match[1];
    const tag = match[3].toLowerCase();
    if (!kinds.has(name)) kinds.set(name, tag);
    else if (kinds.get(name) !== tag) kinds.set(name, '');
  }
  return kinds;
}

function inferJsType(
  key,
  file,
  window,
  via,
  elementKinds = new Map(),
  objectProperty = '',
  literalProperty = '',
) {
  if (file === 'src/tray.js' || /^tray\./.test(key)) return ['menu-item', 'high'];
  if (/^smart\.tips\.\d+$/.test(key)) return ['tip', 'high'];
  if (via === 'helper-key:setLibEmptyText') return ['empty-state', 'high'];
  if (via === 'helper-key:addAction' && /(?:Failed|Failure)$/.test(key)) return ['error-message', 'high'];
  if (via === 'dataset-i18n') return ['label', 'high'];
  if (literalProperty === 'titleKey' || /^notify\..*Title$/.test(key)) return ['notification-title', 'high'];
  if (literalProperty === 'bodyKey' || /^notify\..*Body$/.test(key)) return ['notification-body', 'high'];
  if (literalProperty === 'messageKey' || /reportChannel(?:Failure|Success)\s*\(/.test(window)) {
    return ['event-message', 'high'];
  }
  if (/\btoast\s*\(/.test(window) || /^toast\./.test(key)) return ['toast', 'high'];
  if (via === 'tMain' || /showOpenDialog/.test(window)) return ['dialog-title', 'high'];
  if (/setAttribute\s*\(\s*['"]aria-label['"]/.test(window)) return ['aria-label', 'high'];
  if (objectProperty === 'placeholder' || /\.placeholder\s*=/.test(window)) return ['placeholder', 'high'];
  if (/\baddAction\s*\(/.test(window)) return ['button', 'high'];
  if (/\bdetailsRow\s*\(/.test(window)) return ['field-label', 'high'];
  if (/^(?:subtitle|detail)$/.test(objectProperty)) return ['description', 'high'];
  if (objectProperty === 'title') return ['heading', 'high'];
  if (/\.title\s*=/.test(window)) return ['tooltip', 'high'];
  const textTarget = /\b([A-Za-z_$][\w$]*)\.(?:textContent|innerHTML)\s*=/.exec(window);
  if (textTarget) {
    const tag = elementKinds.get(textTarget[1]);
    if (tag === 'button') return ['button', 'high'];
    if (tag === 'option') return ['option', 'high'];
    // The assignment is certain, but the receiver's semantic role is not.
    return ['label', 'medium'];
  }
  return [suffixKind(key), 'medium'];
}

function functionArea(file, functionName, key) {
  if (file === 'src/tray.js') return 'system-tray';
  if (file === 'renderer/viewer.js') return 'media-viewer';
  const keyedArea = namespaceArea(key);
  if (keyedArea !== 'global') return keyedArea;
  const name = String(functionName || '').toLowerCase();
  if (/welcome/.test(name)) return 'welcome';
  if (/journal|eventlog/.test(name)) return 'preferences.event-journal';
  if (/online|cloud|wallhaven|internet|\bwh/.test(name)) return 'online';
  if (/viewer|gallery/.test(name)) return 'media-viewer';
  if (/details/.test(name)) return 'library.details';
  if (/library|\blib|folder|card|assign|tag|selection/.test(name)) return 'library';
  if (/home|recent|hero|pager/.test(name)) return 'home';
  if (/prefs|shortcut|update/.test(name)) return 'preferences';
  return keyedArea;
}

function mapSinkFor(source, code, range) {
  const nameRe = new RegExp(`\\b${range.name.replace(/[$]/g, '\\$&')}\\b`, 'g');
  let match;
  while ((match = nameRe.exec(code))) {
    if (range.declarationStart <= match.index && match.index <= range.end) continue;
    const window = jsContextWindow(source, match.index);
    if (/\btoast\s*\(/.test(window)) return { type: 'toast', confidence: 'high', offset: match.index };
    if (/\.textContent\s*=/.test(window)) return { type: 'label', confidence: 'high', offset: match.index };
    if (/\.title\s*=/.test(window)) return { type: 'tooltip', confidence: 'high', offset: match.index };
    if (/\bt\s*\(/.test(window)) return { type: 'label', confidence: 'medium', offset: match.index };
  }
  return null;
}

function scanJavaScript(source, file, referenceKeys) {
  const contexts = [];
  const definiteReferences = new Set();
  const referenceList = Array.from(referenceKeys);
  const references = new Set(referenceList);
  const commentMasked = maskJsComments(source);
  const stringTokens = lexJavaScriptStrings(source);
  const code = maskJsStructure(source, stringTokens);
  const ranges = namedRanges(code);
  const calls = namedCallRanges(code);
  const elementKinds = discoverElementKinds(source);
  const positionAt = makeLineIndex(source);
  const literalMatches = [];

  for (const token of stringTokens) {
    if (token.dynamic || !/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/.test(token.value)) continue;
    const key = token.value;
    const keyOffset = token.contentStart;
    const callName = keyCallAt(code, calls, token.start);
    const via = callName === 't' || callName === 'tMain' || callName === 'tPath'
      ? callName
      : callName ? `helper-key:${callName}` : 'literal-reference';
    const window = jsContextWindow(commentMasked, token.start);
    const literalProperty = literalPropertyBefore(commentMasked, token.start);
    const propertyRef = /^(?:messageKey|titleKey|bodyKey)$/.test(literalProperty);
    const datasetRef = datasetAssignmentBefore(commentMasked, token.start);
    const objectRange = containingRange(ranges, token.start, 'object');
    const functionRange = containingRange(ranges, token.start, 'function');
    const direct = Boolean(callName || propertyRef || datasetRef);
    literalMatches.push({
      key,
      keyOffset,
      via: datasetRef ? 'dataset-i18n' : via,
      window,
      objectProperty: objectPropertyBeforeCall(commentMasked, token.start),
      literalProperty,
      objectRange,
      functionRange,
      direct,
    });
  }

  const mapSinks = new Map();
  for (const item of literalMatches) {
    if (!item.objectRange || mapSinks.has(item.objectRange)) continue;
    mapSinks.set(item.objectRange, mapSinkFor(source, code, item.objectRange));
  }

  for (const item of literalMatches) {
    const descendants = !references.has(item.key) && item.via === 'tPath'
      ? referenceList.filter((key) => key.startsWith(`${item.key}.`))
      : [];
    const keys = references.has(item.key) ? [item.key] : descendants;
    const mapSink = item.objectRange ? mapSinks.get(item.objectRange) : null;
    if (item.direct || mapSink) definiteReferences.add(item.key);
    for (const key of keys) {
      const pos = positionAt(item.keyOffset);
      const inferred = mapSink
        ? [mapSink.type, mapSink.confidence]
        : inferJsType(
          key,
          file,
          item.window,
          item.via,
          elementKinds,
          item.objectProperty,
          item.literalProperty,
        );
      const sinkFunction = mapSink
        ? containingRange(ranges, mapSink.offset, 'function')
        : item.functionRange;
      const context = {
        type: inferred[0],
        area: item.via === 'tMain'
          ? 'native-file-picker'
          : functionArea(file, sinkFunction && sinkFunction.name, key),
        file,
        line: pos.line,
        column: pos.column,
        via: descendants.length ? 'collection-reference' : (mapSink ? `lookup-map:${item.objectRange.name}` : item.via),
        confidence: inferred[1],
      };
      if (sinkFunction) context.function = sinkFunction.name;
      // Keep the variable name as traceable context for an indirect lookup.
      if (mapSink && item.objectRange) context.lookup = item.objectRange.name;
      contexts.push({ key, context });
    }
  }

  // Expand a dynamic template family and also register its explicit finite domain
  // as definite references. This lets lint catch deletion of one family member.
  for (const token of stringTokens) {
    if (!token.dynamic) continue;
    const familyMatch = /^([A-Za-z][A-Za-z0-9_.-]*)\$\{[\s\S]*\}([A-Za-z0-9_.-]*)$/.exec(token.value);
    if (!familyMatch) continue;
    if (keyCallAt(code, calls, token.start) !== 't') continue;
    const prefix = familyMatch[1];
    const suffix = familyMatch[2] || '';
    const pattern = `${prefix}*${suffix}`;
    const expectedFamily = DYNAMIC_KEY_FAMILIES[pattern]
      || referenceList.filter((key) => key.startsWith(prefix) && key.endsWith(suffix));
    for (const key of expectedFamily) definiteReferences.add(key);
    const family = expectedFamily.filter((key) => references.has(key));
    const functionRange = containingRange(ranges, token.start, 'function');
    const pos = positionAt(token.contentStart);
    for (const key of family) {
      const inferred = inferJsType(
        key,
        file,
        jsContextWindow(commentMasked, token.start),
        'dynamic-template',
        elementKinds,
        objectPropertyBeforeCall(commentMasked, token.start),
      );
      const context = {
        type: inferred[0],
        area: functionArea(file, functionRange && functionRange.name, key),
        file,
        line: pos.line,
        column: pos.column,
        via: 'dynamic-template',
        confidence: 'medium',
        pattern,
      };
      if (functionRange) context.function = functionRange.name;
      contexts.push({ key, context });
    }
  }

  return { contexts, definiteReferences };
}

function contextSignature(context) {
  return [
    context.file, context.line, context.column, context.type, context.area,
    context.via, context.function || '', context.selector || '', context.pattern || '',
  ].join('\u0000');
}

function sortContexts(contexts) {
  return contexts.sort((a, b) => (
    a.file.localeCompare(b.file)
    || a.line - b.line
    || a.column - b.column
    || a.type.localeCompare(b.type)
    || a.area.localeCompare(b.area)
    || a.via.localeCompare(b.via)
  ));
}

function buildContextCatalog({ reference, sources } = {}) {
  const referenceFlat = flatten(reference || {});
  const referenceKeys = Object.keys(referenceFlat);
  const referenceSet = new Set(referenceKeys);
  const sourceList = Array.isArray(sources) ? sources.slice() : [];
  sourceList.sort((a, b) => String(a.file).localeCompare(String(b.file)));

  const byKey = new Map(referenceKeys.map((key) => [key, []]));
  const definiteReferences = new Set();
  for (const item of sourceList) {
    if (!item || typeof item.file !== 'string' || typeof item.content !== 'string') continue;
    const result = /\.html?$/i.test(item.file)
      ? scanHtml(item.content, item.file, referenceSet)
      : scanJavaScript(item.content, item.file, referenceSet);
    for (const ref of result.definiteReferences) definiteReferences.add(ref);
    for (const occurrence of result.contexts) {
      if (byKey.has(occurrence.key)) byKey.get(occurrence.key).push(occurrence.context);
    }
  }

  const entries = {};
  const unresolved = [];
  let contextualized = 0;
  for (const key of referenceKeys) {
    const seen = new Set();
    const contexts = [];
    for (const context of sortContexts(byKey.get(key))) {
      const signature = contextSignature(context);
      if (seen.has(signature)) continue;
      seen.add(signature);
      contexts.push(context);
    }
    entries[key] = { contexts };
    if (contexts.some((context) => context.type !== 'unknown' && context.area !== 'unknown')) contextualized++;
    else unresolved.push(key);
  }

  const total = referenceKeys.length;
  return {
    schemaVersion: SCHEMA_VERSION,
    sources: sourceList.map((item) => item.file),
    stats: {
      total,
      contextualized,
      coveragePct: total ? Math.round((contextualized / total) * 1000) / 10 : 100,
      unresolved: unresolved.length,
    },
    entries,
    unresolved,
    danglingReferences: Array.from(definiteReferences)
      .filter((key) => !referenceSet.has(key) && !referenceKeys.some((leaf) => leaf.startsWith(`${key}.`)))
      .sort(),
  };
}

function validateManualCatalog(manual, reference) {
  const errors = [];
  const referenceKeys = new Set(Object.keys(flatten(reference || {})));
  if (!manual || typeof manual !== 'object' || Array.isArray(manual)) {
    return ['manual catalog must be an object'];
  }
  if (manual.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`manual schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (!manual.keys || typeof manual.keys !== 'object' || Array.isArray(manual.keys)) {
    errors.push('manual keys must be an object');
    return errors;
  }
  for (const [key, entry] of Object.entries(manual.keys)) {
    if (!referenceKeys.has(key)) errors.push(`manual key is absent from en.json: ${key}`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`manual entry must be an object: ${key}`);
      continue;
    }
    for (const field of ['meaning', 'doesNotMean', 'note']) {
      if (field in entry && typeof entry[field] !== 'string') {
        errors.push(`manual ${key}.${field} must be a string`);
      }
    }
    if ('contexts' in entry) {
      if (!Array.isArray(entry.contexts)) {
        errors.push(`manual ${key}.contexts must be an array`);
      } else {
        entry.contexts.forEach((context, index) => {
          if (!context || typeof context !== 'object' || Array.isArray(context)) {
            errors.push(`manual ${key}.contexts[${index}] must be an object`);
            return;
          }
          if (typeof context.type !== 'string' || !context.type) {
            errors.push(`manual ${key}.contexts[${index}].type is required`);
          }
          if (typeof context.area !== 'string' || !context.area) {
            errors.push(`manual ${key}.contexts[${index}].area is required`);
          }
        });
      }
    }
  }
  return errors;
}

function manualEntry(manual, key) {
  return manual
    && manual.keys
    && Object.prototype.hasOwnProperty.call(manual.keys, key)
    ? manual.keys[key]
    : null;
}

function combinedCoverage(catalog, manual) {
  const contextualized = new Set();
  for (const [key, entry] of Object.entries((catalog && catalog.entries) || {})) {
    if (entry.contexts && entry.contexts.length) contextualized.add(key);
  }
  for (const [key, entry] of Object.entries((manual && manual.keys) || {})) {
    if (entry && Array.isArray(entry.contexts) && entry.contexts.length) contextualized.add(key);
  }
  const total = catalog && catalog.stats ? catalog.stats.total : 0;
  return {
    total,
    contextualized: contextualized.size,
    coveragePct: total ? Math.round((contextualized.size / total) * 1000) / 10 : 100,
  };
}

function normalizeEol(value) {
  return String(value || '').replace(/\r\n?/g, '\n');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_SOURCE_FILES,
  parseHtmlAttributes,
  namespaceArea,
  suffixKind,
  maskJsComments,
  lexJavaScriptStrings,
  scanHtml,
  scanJavaScript,
  buildContextCatalog,
  validateManualCatalog,
  manualEntry,
  combinedCoverage,
  normalizeEol,
  stableJson,
};
