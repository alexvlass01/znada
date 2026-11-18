'use strict';

/*
 * PERF-011. Решение «что готовить заранее и что держать» в просмотрщике.
 * Сама загрузка и отмена — в `test/viewer-payload-lifecycle.test.js`; здесь чистые правила.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const P = require('../renderer/viewer-prefetch.js');

test('по ходу листания готовится больше, чем назад, и ближние раньше дальних', () => {
  assert.deepEqual(P.plan(10, 100, 1), [11, 9, 12, 13, 8, 14]);
  assert.deepEqual(P.plan(10, 100, -1), [9, 11, 8, 7, 12, 6]);
});

test('первый шаг назад идёт сразу за первым шагом вперёд — смена направления не ждёт', () => {
  const order = P.plan(50, 100, 1);
  assert.equal(order[0], 51);
  assert.equal(order[1], 49);
});

test('галерея закольцована, как и стрелки', () => {
  assert.deepEqual(P.plan(0, 10, 1), [1, 9, 2, 3, 8, 4]);
  assert.deepEqual(P.plan(9, 10, 1), [0, 8, 1, 2, 7, 3]);
});

test('в маленькой галерее кадр берётся один раз, текущий — никогда', () => {
  assert.deepEqual(P.plan(0, 2, 1), [1]);
  assert.deepEqual(P.plan(1, 3, 1), [2, 0]);
  const order = P.plan(2, 5, 1);
  assert.equal(new Set(order).size, order.length);
  assert.equal(order.includes(2), false);
  assert.equal(order.length, 4);
});

test('нечего готовить: один кадр, пусто, мусор на входе', () => {
  assert.deepEqual(P.plan(0, 1, 1), []);
  assert.deepEqual(P.plan(0, 0, 1), []);
  assert.deepEqual(P.plan(5, 3, 1), []);
  assert.deepEqual(P.plan(-1, 10, 1), []);
  assert.deepEqual(P.plan(NaN, 10, 1), []);
});

test('направление: всё, кроме отрицательного, — вперёд', () => {
  assert.equal(P.direction(-1), -1);
  assert.equal(P.direction(-3), -1);
  assert.equal(P.direction(1), 1);
  assert.equal(P.direction(0), 1);
  assert.equal(P.direction(undefined), 1);
});

test('стоимость кадра — 4 байта на точку; неизвестный размер не держится', () => {
  assert.equal(P.decodedBytes(3840, 2160), 3840 * 2160 * 4);
  assert.equal(P.decodedBytes(0, 100), 0);
  assert.equal(P.worthKeeping(P.decodedBytes(3840, 2160)), true);
  assert.equal(P.worthKeeping(0), false);
  // Исполин из BUG-042: 14204×10652 — 605 МиБ раскодированным.
  assert.equal(P.worthKeeping(P.decodedBytes(14204, 10652)), false);
});

test('всё окно 4K-кадров помещается в бюджет', () => {
  const window = 1 + P.AHEAD + P.BEHIND;
  assert.ok(window * P.decodedBytes(3840, 2160) <= P.DECODED_BUDGET);
});

test('вне окна выбрасывается всё, внутри — дальние раньше ближних', () => {
  const MB = 1024 * 1024;
  const order = [10, 11, 9, 12, 13, 8, 14];
  const held = [
    { index: 3, bytes: 1 },
    { index: 14, bytes: 100 * MB },
    { index: 11, bytes: 100 * MB },
    { index: 9, bytes: 100 * MB },
  ];
  const drop = P.evict(held, order, 250 * MB);
  assert.ok(drop.includes(3), 'кадр вне окна остался');
  assert.ok(drop.includes(14), 'вытеснен ближний вместо дальнего');
  assert.ok(!drop.includes(11) && !drop.includes(9));
});

test('без центра выбрасывается всё', () => {
  assert.deepEqual(P.evict([{ index: 1, bytes: 1 }], []).sort(), [1]);
});
