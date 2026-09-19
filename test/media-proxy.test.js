'use strict';

/*
 * PERF-008. Адресация потокового прокси картинок.
 *
 * Опасность этого модуля не в производительности, а в том, что строку составляет ОКНО, а
 * разбирает её главный процесс — и по разобранному потом идёт настоящий сетевой запрос.
 * Прежний путь передавал карточку через IPC и сверял адрес с объявленными хостами
 * провайдера; здесь адрес едет в строке, и проверка остаётся той же. Значит разбор обязан
 * быть придирчивым: всё, что не совпало с ожидаемой формой, — отказ, а не догадка.
 *
 * Отдельно проверяется потолок размера. На потоке он считается ПО МЕРЕ чтения: смысл
 * потоковой отдачи в том, что «после загрузки» не наступает, пока файл не доехал, — а
 * рвать соединение надо раньше. Ошибка в эту сторону означает «качаем сколько дадут».
 */

const assert = require('assert');
const proxy = require('../src/media-proxy');

let passed = 0;
function ok(name, fn) { fn(); console.log('  OK ' + name); passed += 1; }

/* ------------------------------------------------------------- ступени ---- */

ok('ступень — закрытый список, а не любое поле карточки', () => {
  assert.strictEqual(proxy.tierField('thumb'), 'thumb');
  assert.strictEqual(proxy.tierField('sample'), 'sample');
  assert.strictEqual(proxy.tierField('full'), 'full');
  // «Любое поле» здесь означало бы «любой адрес из карточки» — дыра в той самой проверке,
  // ради сохранения которой прокси и остаётся.
  for (const junk of ['page', 'source', '__proto__', 'constructor', 'toString', '', null, undefined, 0]) {
    assert.strictEqual(proxy.tierField(junk), '', 'ступень ' + String(junk) + ' не должна проходить');
  }
});

ok('наследованные свойства объекта не становятся ступенями', () => {
  // hasOwnProperty, а не `tier in map`: иначе `toString` и `constructor` прошли бы.
  assert.strictEqual(proxy.tierField('hasOwnProperty'), '');
  assert.strictEqual(proxy.tierField('valueOf'), '');
});

/* -------------------------------------------------------------- потолки ---- */

ok('у миниатюры свой потолок, у полной свой', () => {
  assert.strictEqual(proxy.limitFor('thumb'), proxy.THUMB_MAX_BYTES);
  assert.strictEqual(proxy.limitFor('full'), proxy.FULL_MAX_BYTES);
  assert.strictEqual(proxy.limitFor('sample'), proxy.FULL_MAX_BYTES);
  assert.ok(proxy.THUMB_MAX_BYTES < proxy.FULL_MAX_BYTES,
    'миниатюра в 30 МБ значит, что сайт отдал не то — молча тащить это в сетку нельзя');
});

ok('неизвестная ступень не даёт потолка, а значит не пропускает ничего', () => {
  assert.strictEqual(proxy.limitFor('whatever'), 0);
  assert.strictEqual(proxy.overLimit(1, proxy.limitFor('whatever')), true);
});

ok('потолок считается по мере чтения и держит границу точно', () => {
  const cap = proxy.THUMB_MAX_BYTES;
  assert.strictEqual(proxy.overLimit(cap - 1, cap), false);
  assert.strictEqual(proxy.overLimit(cap, cap), false, 'ровно потолок — ещё не превышение');
  assert.strictEqual(proxy.overLimit(cap + 1, cap), true);
});

ok('мусор вместо счётчика или потолка запрещает, а не разрешает', () => {
  // Направление отказа выбрано намеренно: ошибка здесь должна ронять загрузку,
  // а не превращаться в «качаем сколько дадут».
  for (const [seen, limit] of [
    [NaN, 100], [Infinity, 100], [-1, 100], [10, NaN], [10, 0], [10, -5], [10, Infinity],
  ]) {
    assert.strictEqual(proxy.overLimit(seen, limit), true,
      'seen=' + String(seen) + ' limit=' + String(limit) + ' обязан считаться превышением');
  }
});

/* --------------------------------------------------------------- адрес ---- */

ok('адрес собирается и разбирается обратно без потерь', () => {
  const url = 'https://cdn.donmai.us/sample/7f/2f/sample-abc.jpg';
  const built = proxy.buildUrl({ provider: 'danbooru', tier: 'sample', url });
  assert.ok(built.startsWith(proxy.SCHEME + '://'), 'адрес не в своей схеме: ' + built);
  const back = proxy.parseUrl(built);
  assert.deepStrictEqual(
    { tier: back.tier, provider: back.provider, url: back.url, field: back.field },
    { tier: 'sample', provider: 'danbooru', url, field: 'sample' });
  assert.strictEqual(back.limit, proxy.FULL_MAX_BYTES);
});

ok('одна и та же картинка даёт одну и ту же строку', () => {
  // Иначе кэш браузера бесполезен, а ради него мы и уходим от словаря data-URL в памяти.
  const a = proxy.buildUrl({ provider: 'gelbooru', tier: 'thumb', url: 'https://img.gelbooru.com/x.jpg' });
  const b = proxy.buildUrl({ provider: 'gelbooru', tier: 'thumb', url: 'https://img.gelbooru.com/x.jpg' });
  assert.strictEqual(a, b);
});

ok('адрес с запросом и странными символами переживает круг', () => {
  const url = 'https://cdn.example/i.jpg?a=1&b=%20+%2F&c=привет';
  const back = proxy.parseUrl(proxy.buildUrl({ provider: 'danbooru', tier: 'full', url }));
  assert.strictEqual(back.url, url, 'адрес исказился при кодировании');
});

ok('неполный запрос собрать нельзя', () => {
  for (const bad of [
    { provider: '', tier: 'thumb', url: 'https://a/b.jpg' },
    { provider: 'danbooru', tier: '', url: 'https://a/b.jpg' },
    { provider: 'danbooru', tier: 'thumb', url: '' },
    { provider: 'danbooru', tier: 'page', url: 'https://a/b.jpg' },
    {}, null, undefined,
  ]) {
    assert.strictEqual(proxy.buildUrl(bad), '',
      'собрался адрес из ' + JSON.stringify(bad) + ' — окно получило бы рабочую ссылку из мусора');
  }
});

/* ------------------------------------------------------------- разбор ---- */

ok('чужая схема не разбирается', () => {
  for (const href of [
    'https://media/?t=thumb&p=danbooru&u=https://a/b.jpg',
    'file:///c:/secret.txt',
    'znada-mediax://media/?t=thumb&p=danbooru&u=https://a/b.jpg',
    '', null, undefined, 42,
  ]) {
    assert.strictEqual(proxy.parseUrl(href), null, 'разобралось чужое: ' + String(href));
  }
});

ok('подменённый хост не разбирается', () => {
  // Хост ничего не выбирает, но его подмена — признак, что строку собрали не мы.
  assert.strictEqual(proxy.parseUrl(proxy.SCHEME + '://elsewhere/?t=thumb&p=danbooru&u=https://a/b.jpg'), null);
});

ok('пропущенная часть запроса не разбирается', () => {
  const S = proxy.SCHEME;
  for (const href of [
    `${S}://media/?p=danbooru&u=https://a/b.jpg`,
    `${S}://media/?t=thumb&u=https://a/b.jpg`,
    `${S}://media/?t=thumb&p=danbooru`,
    `${S}://media/?t=page&p=danbooru&u=https://a/b.jpg`,
    `${S}://media/`,
  ]) {
    assert.strictEqual(proxy.parseUrl(href), null, 'разобралось неполное: ' + href);
  }
});

ok('битая строка даёт отказ, а не исключение', () => {
  // Строку составляет окно; исключение в обработчике протокола — это упавшая картинка
  // в лучшем случае и упавший обработчик в худшем.
  for (const href of [
    proxy.SCHEME + '://[',
    proxy.SCHEME + '://a b/',
    proxy.SCHEME + '://host:99999/',
    proxy.SCHEME + '://media/?t=%',
  ]) {
    assert.doesNotThrow(() => proxy.parseUrl(href), 'разбор бросил исключение на ' + href);
  }
});

console.log(`\nAll ${passed} media-proxy tests passed.`);
