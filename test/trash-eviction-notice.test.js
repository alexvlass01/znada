'use strict';

// LIB-009. Само вытеснение было сделано честно и покрыто тестами в `src/library-store.js`:
// `pushEntry` ограничивает корзину на входе и ВОЗВРАЩАЕТ выпавшие записи, чтобы вызывающий
// мог на них среагировать. Не хватало последнего шага — самой реакции.
//
// Почему это не косметика. Запись, выпавшая из корзины, теряет защиту от сборщика обоев:
// её файл уходит в `wallpapers/.trash`, и вернуть его одним нажатием уже нельзя. Корзина
// при этом прямо обещает пользователю обратное («убранное попадает сюда, и его можно
// вернуть»). Обещание переставало действовать молча: знала об этом только консоль
// разработчика, а человек обнаруживал пропажу позже, когда искать уже негде.
//
// Здесь проверяется именно ДОСТАВКА, а не механика: что настоящий обработчик удаления
// выносит счёт наружу, и что оба окна превращают его в надпись — и молчат, когда
// вытеснять было нечего. Оба случая, как требует задача.
//
// Run: node test/trash-eviction-notice.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./helpers/main-harness');
const library = require('../src/library');
const store = require('../src/library-store');

let passed = 0;
const failures = [];

async function test(name, fn) {
  const dir = H.makeTempProfile('evict');
  const real = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    await fn(dir);
    console.log = real.log; console.error = real.error;
    console.log('  OK ' + name);
    passed += 1;
  } catch (e) {
    console.log = real.log; console.error = real.error;
    failures.push({ name, e });
    console.log('  FAIL ' + name + '\n    ' + (e && e.message));
  } finally {
    H.unloadMain();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function ok(name, fn) {
  try { fn(); console.log('  OK ' + name); passed += 1; }
  catch (e) { failures.push({ name, e }); console.log('  FAIL ' + name + '\n    ' + (e && e.message)); }
}

// Надгробие для когда-то удалённой фотографии. Файла на диске у неё нет и не нужно:
// корзина хранит запись, а не содержимое.
function tombstone(i) {
  const p = path.win32.join('C:\\', 'seed', 'old-' + i + '.png');
  return {
    item: { id: library.idFor(p), path: p, type: 'image', rev: 1 },
    removedAt: 1000 + i,
    via: '',
    group: '',
    slots: [],
  };
}

const cfgFile = (dir) => path.join(dir, 'config.json');
const storeFile = (dir) => path.join(dir, 'config.library.json');

// Профиль с одной живой фотографией и корзиной заданной длины.
function seed(dir, trashCount) {
  const photo = H.writeImage(path.join(dir, 'photos', 'live.png'));
  const id = library.idFor(photo);
  const pool = { [id]: { id, path: photo, type: 'image', rev: 1, addedAt: 1 } };
  const trash = [];
  for (let i = 0; i < trashCount; i++) trash.push(tombstone(i));
  H.writeJson(cfgFile(dir), { autoSwitch: true, style: 'fill', monitors: {} });
  H.writeJson(storeFile(dir), { version: 1, library: pool, trash });
  return { photo, id };
}

console.log('\nLIB-009: вытеснение из корзины доходит до человека\n');

(async () => {
  // ---- сторона main: обработчик обязан вынести счёт наружу ----

  await test('корзина полна — обработчик сообщает, сколько записей выпало', async (dir) => {
    const { photo, id } = seed(dir, store.TRASH_LIMIT);
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    const res = await m.invoke('library-remove-many', [{ id, path: photo, type: 'image' }]);
    assert.strictEqual(res.error, null, 'удаление не прошло');
    assert.ok(res.evicted > 0,
      'вытеснение произошло, но обработчик о нём молчит (evicted=' + res.evicted + ')');
    assert.strictEqual(m.__test.getConfig().libraryTrash.length, store.TRASH_LIMIT,
      'корзина перестала держать свой предел');
  });

  await test('в корзине есть место — обработчик не выдумывает вытеснение', async (dir) => {
    const { photo, id } = seed(dir, 3);
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    const res = await m.invoke('library-remove-many', [{ id, path: photo, type: 'image' }]);
    assert.strictEqual(res.error, null, 'удаление не прошло');
    assert.strictEqual(res.evicted, 0,
      'вытеснять было нечего, а обработчик насчитал ' + res.evicted);
  });

  // ---- сторона окон: счёт обязан стать надписью, и только когда он есть ----
  //
  // Функции берутся из настоящих файлов, а не переписываются здесь: тест, сверяющий
  // копию, доказывает лишь то, что копия согласована сама с собой.

  const grab = (file, name) => {
    const src = fs.readFileSync(path.join(H.ROOT, file), 'utf8').split('\r\n').join('\n');
    const found = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
    assert.ok(found, name + ' должна оставаться отдельной функцией в ' + file);
    return found[0];
  };

  // Подставной перевод возвращает сам ключ с подставленным числом: так видно, КАКОЙ текст
  // собрался, не завися от формулировок локали.
  const fakeT = (key, vars) => (vars && vars.n !== undefined ? key + ':' + vars.n : key);

  {
    const ctx = { t: fakeT, shown: null };
    ctx.toast = (msg) => { ctx.shown = { msg, action: null }; };
    ctx.toastAction = (msg, label) => { ctx.shown = { msg, action: label }; };
    ctx.undoLastRemoval = () => {};
    vm.createContext(ctx);
    vm.runInContext(grab('renderer/renderer.js', 'toastRemoved'), ctx);

    ok('окно: вытеснение попадает в тост вместе с числом', () => {
      ctx.shown = null;
      ctx.toastRemoved(2, 'token-1', 3);
      assert.ok(ctx.shown, 'тост не показан вовсе');
      assert.ok(ctx.shown.msg.includes('library.trashEvictedN:3'),
        'в тосте нет сообщения о вытеснении: ' + ctx.shown.msg);
      assert.ok(ctx.shown.msg.includes('library.removedToastN:2'),
        'сообщение об удалении потеряно');
    });

    ok('окно: без вытеснения тост о нём молчит', () => {
      ctx.shown = null;
      ctx.toastRemoved(2, 'token-1', 0);
      assert.ok(ctx.shown, 'тост не показан вовсе');
      assert.ok(!ctx.shown.msg.includes('trashEvictedN'),
        'сообщение о вытеснении показано без причины: ' + ctx.shown.msg);
    });

    // Ради этого всё и собирается в ОДНУ строку: тост в окне один, и второй затёр бы
    // «Отменить» у только что сделанного удаления — то есть отнял бы возможность
    // предотвратить ровно ту потерю, о которой сообщает.
    ok('окно: сообщение о вытеснении не отнимает кнопку «Отменить»', () => {
      ctx.shown = null;
      ctx.toastRemoved(1, 'token-1', 5);
      assert.strictEqual(ctx.shown.action, 'library.undo',
        'вместе с вытеснением пропала возможность отменить удаление');
    });
  }

  {
    const ctx = { t: fakeT };
    vm.createContext(ctx);
    // Извлечение внутри проверки, а не рядом с ней: если функции нет, это должно быть
    // названным провалом в общем списке, а не исключением, обрывающим остальные тесты.
    ok('просмотрщик: надпись собирается отдельной функцией', () => {
      vm.runInContext(grab('renderer/viewer.js', 'removalNoticeText'), ctx);
      assert.strictEqual(typeof ctx.removalNoticeText, 'function');
    });

    ok('просмотрщик: вытеснение попадает в надпись', () => {
      assert.ok(ctx.removalNoticeText(4).includes('library.trashEvictedN:4'),
        'просмотрщик удаляет тем же обработчиком, но о вытеснении не говорит');
    });

    ok('просмотрщик: без вытеснения надпись прежняя', () => {
      const text = ctx.removalNoticeText(0);
      assert.ok(!text.includes('trashEvictedN'), 'лишнее сообщение: ' + text);
      assert.ok(text.includes('library.removedToast'), 'потеряно сообщение об удалении');
    });
  }

  // ---- просмотрщик: предупреждение должно быть видно целиком ----
  //
  // Ревью #6 показало, что проверка текста здесь ничего не доказывала: строка собиралась
  // верно, а на экране уведомление обрезалось многоточием ровно на «уже не вернуть» —
  // у него одна строка, `white-space: nowrap` и потолок 520 px. Настоящую ширину node не
  // измерит, поэтому проверяется правило, при котором текст не прячется НИ ПРИ КАКОЙ длине,
  // языке и ширине окна: уведомление с вытеснением получает класс переноса, стиль этого
  // класса переносит строку и ничего не прячет, а кнопка «Отменить» сохраняет свою ширину.
  // Замер ширин в настоящем Chromium — в авторском отчёте.
  {
    const viewerCss = fs.readFileSync(path.join(H.ROOT, 'renderer', 'viewer.css'), 'utf8')
      .split('\r\n').join('\n');
    const rule = (selector) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
      const found = viewerCss.match(new RegExp('(^|\\n)' + escaped + '\\s*\\{([^}]*)\\}'));
      return found ? found[2] : null;
    };
    const decl = (body, prop) => {
      const found = body && body.match(new RegExp('(?:^|[;\\s])' + prop + '\\s*:\\s*([^;]+);'));
      return found ? found[1].trim() : null;
    };

    // Настоящие строки обоих эталонов: так видно и то, что число стоит в конце.
    const dict = (lang) => JSON.parse(fs.readFileSync(path.join(H.ROOT, 'locales', lang + '.json'), 'utf8'));
    const translator = (lang) => {
      const d = dict(lang);
      return (key, vars) => {
        const text = key.split('.').reduce((node, part) => (node ? node[part] : undefined), d);
        return String(text).replace(/\{(\w+)\}/g, (m, name) => (vars && vars[name] !== undefined ? vars[name] : m));
      };
    };

    // Минимальный DOM: ровно то, чем пользуются функции уведомлений.
    const mount = (lang) => {
      const nodes = [];
      const make = (tag) => {
        const node = {
          tag, className: '', type: '', textContent: '', children: [], parent: null, attrs: {}, disabled: false,
          setAttribute(k, v) { this.attrs[k] = v; },
          appendChild(child) { child.parent = this; this.children.push(child); return child; },
          remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
          addEventListener() {},
          classes() { return this.className.split(/\s+/).filter(Boolean); },
        };
        nodes.push(node);
        return node;
      };
      const root = make('main');
      const timers = [];
      const ctx = {
        t: translator(lang),
        document: { createElement: make },
        $: (selector) => (selector === '#viewerRoot' ? root : null),
        setTimeout: (fn, ms) => { timers.push(ms); return timers.length; },
        clearTimeout: () => {},
      };
      vm.createContext(ctx);
      const viewerSrc = fs.readFileSync(path.join(H.ROOT, 'renderer', 'viewer.js'), 'utf8').split('\r\n').join('\n');
      const state = viewerSrc.match(/const VIEWER_NOTICE = \{[^}]*\};/);
      assert.ok(state, 'VIEWER_NOTICE должна оставаться общим состоянием уведомлений');
      vm.runInContext(state[0].replace('const ', 'var '), ctx);
      for (const name of ['dismissViewerNotice', 'createViewerNotice', 'showViewerMessage',
        'removalNoticeText', 'showRemovalUndo', 'showRemovalResult']) {
        vm.runInContext(grab('renderer/viewer.js', name), ctx);
      }
      const notice = () => root.children.find((c) => c.classes().includes('media-notice'));
      return { ctx, notice, timers };
    };

    for (const lang of ['ru', 'en']) {
      for (const n of [1, 500]) {
        ok(`просмотрщик (${lang}, ${n}): предупреждение переносится, «Отменить» на месте`, () => {
          const v = mount(lang);
          v.ctx.showRemovalResult({}, {}, { undo: { token: 'tok' }, evicted: n });
          const el = v.notice();
          assert.ok(el, 'уведомление не показано');
          assert.ok(el.classes().includes('media-notice-wrap'),
            'уведомление с вытеснением осталось однострочным — хвост уйдёт под многоточие');
          const text = el.children.find((c) => c.tag === 'span');
          const warning = v.ctx.t('library.trashEvictedN', { n });
          assert.ok(text && text.textContent.endsWith(warning),
            'в уведомлении нет полного предупреждения: ' + (text && text.textContent));
          assert.ok(text.textContent.endsWith(': ' + n), 'число должно стоять в конце: ' + text.textContent);
          const undo = el.children.find((c) => c.tag === 'button');
          assert.ok(undo && undo.classes().includes('media-notice-action'), 'пропала кнопка «Отменить»');
        });
      }
    }

    ok('просмотрщик: без вытеснения уведомление прежнее, в одну строку', () => {
      const v = mount('ru');
      v.ctx.showRemovalResult({}, {}, { undo: { token: 'tok' }, evicted: 0 });
      assert.ok(!v.notice().classes().includes('media-notice-wrap'), 'короткое уведомление стало переносимым');
    });

    ok('просмотрщик: без «Отменить» предупреждение тоже переносится и висит 6 с', () => {
      const v = mount('ru');
      v.ctx.showRemovalResult({}, {}, { undo: null, evicted: 3 });
      assert.ok(v.notice().classes().includes('media-notice-wrap'), 'предупреждение без «Отменить» однострочное');
      assert.deepStrictEqual(v.timers, [6000], 'предупреждение исчезнет раньше, чем его прочтут');
    });

    ok('стиль: перенос включает строку и ничего не прячет', () => {
      const wrap = rule('.media-notice.media-notice-wrap > span');
      assert.ok(wrap, 'в viewer.css нет правила для .media-notice-wrap');
      assert.strictEqual(decl(wrap, 'white-space'), 'normal');
      assert.strictEqual(decl(wrap, 'overflow'), 'visible');
      assert.notStrictEqual(decl(wrap, 'text-overflow'), 'ellipsis');
      // Без этого блок, поставленный от середины окна, получает правую половину ширины и
      // складывается в узкий столбец: на 640 px — 320 px и четыре строки вместо двух.
      assert.strictEqual(decl(rule('.media-notice.media-notice-wrap'), 'width'), 'max-content');
    });

    ok('стиль: короткие уведомления по-прежнему в одну строку, «Отменить» не сжимается', () => {
      assert.strictEqual(decl(rule('.media-notice > span'), 'white-space'), 'nowrap');
      assert.strictEqual(decl(rule('.media-notice-action'), 'flex'), '0 0 auto');
    });
  }

  if (failures.length) {
    console.log('\n' + failures.length + ' test(s) failed.');
    for (const f of failures) console.log('\n--- ' + f.name + ' ---\n' + (f.e && f.e.stack));
    process.exit(1);
  }
  console.log('\nAll ' + passed + ' trash-eviction-notice tests passed.');
})();
