'use strict';

/*
 * BUG-046. Которые картинки окно просит через потоковый прокси (PERF-008), а которые берёт само.
 *
 * Главный процесс пропускает через прокси только адреса из объявленных хостов провайдера, и у
 * сайта, чьи картинки окно грузит напрямую (`loadsDirectly: true`), список хостов превью пуст —
 * «никаких», а не «любые». Попросить у прокси такую картинку значит получить 403. Прежде это
 * решал каждый вызов сам, и просмотрщик в `previewSource` решить забыл: превью Wallhaven
 * просилось через прокси, приходил отказ, и до оригинала экран оставался тёмным.
 *
 * Проверяются не отдельные строки, а все пути окна, для каждого сайта из реестра: превью,
 * промежуточная и полная картинка в просмотрщике, миниатюра карточки и лист «Подробнее» в главном
 * окне. Функции берутся из настоящих файлов, а не переписываются здесь.
 *
 * Run: node test/media-proxy-window.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mediaProxy = require('../src/media-proxy');
const registry = require('../src/provider-registry');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
const failures = [];

async function ok(name, fn) {
  try { await fn(); console.log('  OK ' + name); passed += 1; }
  catch (e) { failures.push({ name, e }); console.log('  FAIL ' + name + '\n    ' + (e && e.message)); }
}

const grab = (file, name) => {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\r\n').join('\n');
  const found = src.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  assert.ok(found, name + ' должна оставаться отдельной функцией в ' + file);
  return found[0];
};

function load(file, names) {
  const ctx = { ZnadaMediaProxy: mediaProxy, String, window: {} };
  vm.createContext(ctx);
  for (const name of names) vm.runInContext(grab(file, name), ctx);
  return ctx;
}

const proxied = (url) => typeof url === 'string' && url.startsWith(mediaProxy.SCHEME + '://');
const cardFor = (p) => ({
  provider: p.id,
  loadsDirectly: p.loadsDirectly === true,
  thumb: 'https://thumb.example/' + p.id + '.jpg',
  sample: 'https://sample.example/' + p.id + '.jpg',
  full: 'https://full.example/' + p.id + '.jpg',
});

console.log('\nBUG-046: что окно просит через прокси, а что берёт само\n');

(async () => {
  const providers = registry.PROVIDERS;
  const direct = providers.filter((p) => p.loadsDirectly === true);
  const viaMain = providers.filter((p) => p.loadsDirectly !== true);

  await ok('в реестре есть сайты обоих видов — иначе проверка ниже ничего не доказывает', () => {
    assert.ok(direct.some((p) => p.id === 'wallhaven'), 'Wallhaven должен грузиться окном напрямую');
    assert.ok(viaMain.length > 0, 'нет ни одного сайта, идущего через главный процесс');
  });

  // Связь, из-за которой ошибка стоит 403, а не лишний круг: прокси проверяет превью по
  // объявленным хостам, а сайт, который окно грузит само, их не объявляет.
  await ok('сайт, который окно грузит само, не объявляет хостов превью — прокси ему откажет', () => {
    for (const p of direct) {
      assert.deepStrictEqual(registry.hostList(p.id, 'thumb'), [], p.id + ' объявил хосты превью');
    }
  });

  const viewer = load('renderer/viewer.js', ['mediaProxyUrl', 'previewSource', 'fullSource', 'sampleSource']);
  const main = load('renderer/renderer.js', ['internetThumbUrl', 'detailsPreviewUrl', 'setInternetCardThumbnail']);

  // Строители адреса — единственное место, где решается «через прокси или нет». Прежде
  // решал каждый вызов, и один забыл.
  await ok('строители адреса не делают адрес прокси для сайта, который окно грузит само', () => {
    for (const p of direct) {
      const card = cardFor(p);
      for (const tier of ['thumb', 'sample', 'full']) {
        assert.strictEqual(viewer.mediaProxyUrl(card, tier), '', 'просмотрщик: ' + p.id + ' ' + tier);
      }
      assert.strictEqual(main.internetThumbUrl(card), '', 'главное окно: ' + p.id);
    }
  });

  for (const p of providers) {
    const card = cardFor(p);
    const entry = { kind: 'internet', raw: card };
    const how = card.loadsDirectly ? 'напрямую' : 'через прокси';

    await ok(`просмотрщик, ${p.id}: превью ${how}`, async () => {
      const src = await viewer.previewSource(entry);
      if (card.loadsDirectly) assert.strictEqual(src, card.thumb);
      else assert.ok(proxied(src), 'ожидался адрес прокси, получено ' + src);
    });

    await ok(`просмотрщик, ${p.id}: промежуточная и полная ${how}`, async () => {
      const sample = await viewer.sampleSource(entry);
      const full = await viewer.fullSource(entry);
      if (card.loadsDirectly) {
        assert.strictEqual(sample, '', 'промежуточной ступени у сайта, который грузится напрямую, нет');
        assert.strictEqual(full, card.full);
      } else {
        assert.ok(proxied(sample), 'промежуточная: ' + sample);
        assert.ok(proxied(full), 'полная: ' + full);
      }
    });

    await ok(`главное окно, ${p.id}: карточка и «Подробнее» ${how}`, async () => {
      const tile = { style: {} };
      main.setInternetCardThumbnail(tile, card);
      const sheet = await main.detailsPreviewUrl({ kind: 'online', loadsDirectly: card.loadsDirectly, item: card });
      if (card.loadsDirectly) {
        assert.strictEqual(tile.style.backgroundImage, `url("${card.thumb}")`);
        assert.strictEqual(sheet, card.thumb);
      } else {
        assert.ok(proxied(tile.style.backgroundImage.slice(5, -2)), 'карточка: ' + tile.style.backgroundImage);
        assert.ok(proxied(sheet), '«Подробнее»: ' + sheet);
      }
    });
  }

  if (failures.length) {
    console.log('\n' + failures.length + ' test(s) failed.');
    for (const f of failures) console.log('\n--- ' + f.name + ' ---\n' + (f.e && f.e.stack));
    process.exit(1);
  }
  console.log(`\nAll ${passed} media-proxy-window tests passed.`);
})();
