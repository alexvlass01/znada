'use strict';

// TRG-004. Общая обвязка тестов расписаний на НАСТОЯЩЕМ main.js (тема — этап 1, обои — этап 2).
//
// Расписания ждут двух вещей: ответа хоста обоев («идёт ли игра», «какие мониторы», «применил
// ли») и системных процессов. Здесь хост заменён поддельным по его настоящему протоколу, и
// любой его ответ можно придержать, пока тест не отпустит. Таймеры настоящие: тест их не ждёт,
// а считает, сколько долгих таймеров живо, и может сам «дождаться» единственного из них.

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const schedule = require('../../src/schedule');

// Таймеры расписаний — минута и дольше; всё короче (ожидание ответа хоста, склейка записи,
// сроки процессов) к расписаниям не относится.
const LONG_MS = 60000;

function installTimerCensus() {
  const realSet = global.setTimeout;
  const realClear = global.clearTimeout;
  const live = new Map();
  global.setTimeout = function censusSetTimeout(fn, ms, ...args) {
    let handle = null;
    const run = typeof fn === 'function'
      ? function censusFire(...a) { live.delete(handle); return fn.apply(this, a); }
      : fn;
    handle = realSet(run, ms, ...args);
    if (Number(ms) >= LONG_MS) {
      live.set(handle, {
        ms: Number(ms),
        src: String(fn).replace(/\s+/g, ' ').slice(0, 90),
        fire: () => run(...args),
      });
    }
    return handle;
  };
  global.clearTimeout = function censusClearTimeout(handle) {
    live.delete(handle);
    return realClear(handle);
  };
  return {
    live: () => live.size,
    describe: () => [...live.values()].map((t) => `${t.ms} мс: ${t.src}`).join(' | ') || 'нет',
    // Срок единственного живого долгого таймера наступил сейчас: срабатывает ровно то, что
    // завёл проверяемый код, так же, как это сделал бы сам таймер. Живых должно быть ровно
    // один — тест, который «дожидается таймера расписания», обязан знать, что он один.
    fireOnly() {
      if (live.size !== 1) {
        throw new Error(`ждали один живой долгий таймер, а их ${live.size}: ${this.describe()}`);
      }
      const [handle, timer] = [...live.entries()][0];
      realClear(handle);
      live.delete(handle);
      timer.fire();
    },
    restore() {
      // Утёкший таймер держал бы процесс теста до часа.
      for (const handle of live.keys()) realClear(handle);
      live.clear();
      global.setTimeout = realSet;
      global.clearTimeout = realClear;
    },
  };
}

function deadChild() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => {};
  proc.killed = false;
  proc.pid = -1;
  return proc;
}

// Хост обоев по его настоящему протоколу (src/wallpaper-host.js, версия 2 с WIN-002): @@READY@@v2,
// затем на каждую строку-команду одна строка @@R@@<json> с id этой команды, строго по порядку.
// Отложенный ответ задерживает и все следующие — как у настоящего хоста, который читает команды
// по одной. Любой другой процесс, запущенный через spawn, умирает сразу.
function makeFakeHost() {
  const commands = [];
  const queue = [];
  const held = new Set();
  const answers = { 'check-fullscreen': { ok: true, busy: false } };
  const pump = () => {
    while (queue.length && queue[0].answer !== undefined) {
      const entry = queue.shift();
      entry.write(entry.answer);
    }
  };
  const spawn = (file, args) => {
    const proc = deadChild();
    if (!(args || []).some((a) => /wallpaper-host\.ps1$/i.test(String(a)))) {
      setImmediate(() => {
        if (proc.listenerCount('error')) proc.emit('error', new Error('child processes are disabled in tests'));
        proc.emit('exit', 1, null);
      });
      return proc;
    }
    proc.pid = 4242;
    let buf = '';
    proc.stdin.setEncoding('utf8');
    proc.stdin.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const cmd = JSON.parse(line);
        commands.push(cmd);
        queue.push({
          cmd,
          answer: held.has(cmd.op) ? undefined : (answers[cmd.op] || { ok: true }),
          write: (a) => proc.stdout.write('@@R@@' + JSON.stringify({ ...a, id: cmd.id }) + '\n'),
        });
        pump();
      }
    });
    setImmediate(() => proc.stdout.write('@@READY@@v2\n'));
    return proc;
  };
  return {
    spawn,
    commands,
    // Порядок, в котором команды дошли до хоста, — только их имена.
    get seen() { return commands.map((c) => c.op); },
    hold: (op) => held.add(op),
    // Следующие команды этого вида отвечают сразу; уже придержанные ждут release().
    unhold: (op) => held.delete(op),
    answer: (op, value) => { answers[op] = value; },
    waiting: (op) => queue.filter((e) => e.cmd.op === op && e.answer === undefined).length,
    release(op, value) {
      const entry = queue.find((e) => e.cmd.op === op && e.answer === undefined);
      if (!entry) throw new Error(`нечего отпускать: ${op}`);
      entry.answer = value;
      pump();
    },
  };
}

function hhmm(offsetMin) {
  const d = new Date(Date.now() + offsetMin * 60000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
// Час в обе стороны от «сейчас»: следующая граница ~через час, и её таймер точно долгий.
const darkNow = () => ({ mode: 'time', darkStart: hhmm(-60), lightStart: hhmm(60) });
const lightNow = () => ({ mode: 'time', lightStart: hhmm(-60), darkStart: hhmm(60) });
const saysDarkNow = (sch) => schedule.saysDark(schedule.boundaries(sch, new Date()), new Date());

const turns = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => { setImmediate(r); }); };
// По времени, а не по числу итераций: сроки запускателя и хоста — настоящие таймеры.
async function until(predicate, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => { setImmediate(r); });
  }
  if (predicate()) return;
  throw new Error(`не дождались: ${what}`);
}

module.exports = {
  LONG_MS,
  installTimerCensus,
  deadChild,
  makeFakeHost,
  hhmm,
  darkNow,
  lightNow,
  saysDarkNow,
  turns,
  until,
};
