'use strict';

const assert = require('assert/strict');
const create = require('../renderer/viewer-video');
const flush = () => new Promise(resolve => { setImmediate(resolve); });

// A DOM just big enough for the player, with a clock and timers the test drives itself:
// "the panel hides after a pause" and "a late report must not move the handle back" are
// statements about time, and real timers would make them slow and flaky.
function harness({ saved } = {}) {
  const requests = [], first = [], errors = [], timers = new Map(), docEvents = {}, winEvents = {}, store = new Map();
  let clock = 1000, timerId = 0, onState, popup = null;
  if (saved) store.set('znada.viewer.videoSound', JSON.stringify(saved));
  class Node {
    constructor(tag) {
      this.tag = tag; this.children = []; this.events = {}; this.attrs = {}; this.hidden = false; this.className = '';
      const classes = this.classes = new Set(), vars = this.vars = {};
      this.classList = { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name) };
      this.style = { setProperty: (key, value) => { vars[key] = value; } };
    }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    prepend(child) { child.parent = this; this.children.unshift(child); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(key, callback) { this.events[key] = callback; }
    getBoundingClientRect() { return { left: 100, width: 414 }; } // 400px of travel + the 14px handle
    get offsetWidth() { return this.className === 'video-tip' ? 60 : 0; }
    getContext() { return { drawImage: frame => { if (frame.broken) throw new Error('lost'); this.drawn = frame; } }; }
    // Only what the player asks: "is this inside the panel / a text field".
    closest(selector) {
      for (let node = this; node; node = node.parent) {
        if (selector.split(',').some(part => node.className.split(' ').includes(part.trim().replace(/^\./, '')) || node.tag === part.trim())) return node;
      }
      return null;
    }
    find(name) {
      for (const child of this.children) { if (child.className.split(' ').includes(name)) return child; const deep = child.find(name); if (deep) return deep; }
      return null;
    }
  }
  const root = new Node('root'), stage = new Node('stage'), html = new Node('html');
  const document = { createElement: tag => new Node(tag), activeElement: null, documentElement: html,
    querySelector: key => key === '#viewerRoot' ? root : key === '#viewerStage' ? stage : key === '.lib-popup' ? popup : null,
    addEventListener: (key, callback) => { docEvents[key] = callback; } };
  const window = { addEventListener: (key, callback) => { winEvents[key] = callback; },
    localStorage: { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => { store.set(key, value); } } };
  const api = { videoCommand: request => { requests.push(request); return Promise.resolve({ ok: true }); }, onVideoState: cb => { onState = cb; } };
  const player = create({ window, document, api, t: key => key, onFirstFrame: (width, height) => first.push([width, height]), onError: () => errors.push(1),
    now: () => clock, setTimer: (fn, ms) => { timers.set(++timerId, { fn, at: clock + ms }); return timerId; }, clearTimer: id => { timers.delete(id); } });
  function frame(generation, broken = false) {
    const f = { closes: 0, broken, close() { this.closes++; } };
    winEvents.message({ source: window, data: { type: 'znada-video-frame', info: { generation, width: 640, height: 360 }, frame: f } }); return f;
  }
  // Move the clock and run every timer that came due, in order.
  function advance(ms) {
    const end = clock + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); clock = due[1].at; due[1].fn();
    }
    clock = end;
  }
  const parts = () => ({ controls: root.find('media-video-controls'), play: root.find('video-play'), seek: root.find('video-seek'), tip: root.find('video-tip'),
    time: root.find('video-time'), mute: root.find('video-mute'), volume: root.find('video-volume'), sound: root.find('video-sound'),
    flash: root.find('video-flash'), guard: root.find('video-guard'), canvas: stage.children[0] });
  const key = (code, extra = {}) => { const event = { code, target: root, prevented: false, preventDefault() { this.prevented = true; }, ...extra }; return [player.key(event), event]; };
  return { player, document, root, stage, requests, first, errors, frame, advance, parts, key, store, docEvents,
    state: s => onState(s), last: () => requests.at(-1), sent: action => requests.filter(r => r.action === action),
    idle: () => root.classList.contains('video-idle'), setPopup: node => { popup = node; } };
}
const playing = (h, extra = {}) => h.state({ type: 'state', generation: 1, time: 10, duration: 60, paused: false, volume: 100, ...extra });

(async () => {
  // --- the original contract: open, frames, clock, end, stale, error, close -------------------
  {
    const h = harness(); h.player.show(4, 1); await flush();
    assert.deepEqual(h.requests[0], { action: 'open', index: 4, generation: 1 });
    assert.equal(h.requests.length, 1, 'full volume is the decoder default: nothing more to ask');
    assert.equal(h.frame(1).closes, 1); assert.deepEqual(h.first, [[640, 360]]);
    assert.equal(h.frame(1).closes, 1); assert.equal(h.first.length, 1);
    const p = h.parts();
    assert.ok(h.root.classList.contains('has-video')); assert.ok(p.guard && p.flash, 'guard strip and centre feedback exist');
    // Until the decoder reports, nothing in the panel can be pressed; its first report unlocks it.
    assert.deepEqual([p.play.disabled, p.mute.disabled, p.volume.disabled, p.seek.disabled], [true, true, true, true]);
    h.state({ type: 'state', generation: 1, time: 3725, duration: 3725 * 2, paused: true, volume: 100 });
    assert.equal(p.time.textContent, '1:02:05 / 2:04:10', 'an hour and more is h:mm:ss');
    h.state({ type: 'state', generation: 1, time: 3.4, duration: 60, paused: true, volume: 100 });
    assert.deepEqual([p.play.disabled, p.mute.disabled, p.volume.disabled, p.seek.disabled], [false, false, false, false]);
    assert.equal(p.play.attrs['data-state'], 'paused'); assert.equal(p.play.title, 'video.play'); assert.equal(p.time.textContent, '0:03 / 1:00');
    assert.equal(p.seek.vars['--p'], (3.4 / 60).toFixed(4), 'the fill follows the position');
    p.play.events.click(); await flush(); assert.equal(h.last().action, 'pause');
    h.state({ type: 'state', generation: 1, time: 50, duration: 60, paused: false, volume: 30 });
    assert.equal(p.play.attrs['data-state'], 'playing'); assert.equal(p.seek.value, '50');
    assert.equal(p.volume.value, '30'); assert.equal(p.mute.attrs['data-level'], 'low');
    p.mute.events.click(); await flush(); assert.deepEqual(h.last(), { action: 'volume', generation: 1, value: 0 });
    assert.equal(p.mute.attrs['data-level'], 'off'); assert.equal(p.mute.title, 'video.unmute');
    h.state({ type: 'state', generation: 1, time: 59.967, duration: 60, ended: true, volume: 0 });
    assert.equal(p.time.textContent, '1:00 / 1:00'); assert.equal(p.play.attrs['data-state'], 'ended', 'the end offers a replay');
    assert.equal(p.seek.value, '60'); assert.equal(h.sent('open').length, 1, 'end never auto-advances');
    p.mute.events.click(); await flush(); assert.equal(h.last().value, 30, 'unmute returns to the level before the mute');
    h.player.zoom({ x: 12, y: 5, scale: 2 }); assert.match(p.canvas.style.transform, /scale\(2\)/);
    h.player.stop(1); h.player.show(5, 2); await flush();
    assert.deepEqual(h.last(), { action: 'volume', generation: 2, value: 30 }, 'the level carries over to the next video');
    assert.equal(h.frame(1).closes, 1, 'late old frames must close without showing');
    assert.equal(h.first.length, 1); h.frame(2); assert.equal(h.first.length, 2);
    h.state({ type: 'error', generation: 1 }); assert.equal(h.errors.length, 0);
    h.state({ type: 'error', generation: 2 }); assert.equal(h.errors.length, 1);
    assert.equal(h.frame(2).closes, 1); assert.equal(h.parts().canvas.hidden, true);
    assert.equal(h.parts().controls.hidden, true); assert.ok(!h.root.classList.contains('has-video'), 'a failed video leaves the photo look');
    await h.player.external(); assert.deepEqual(h.last(), { action: 'external', generation: 2 });
    h.player.stop(2); h.player.show(0, 3); const broken = h.frame(3, true);
    assert.equal(broken.closes, 1); assert.equal(h.errors.length, 2);
    assert.equal(h.last().action, 'abort', 'canvas failure must stop sound/decoding');
    h.player.stop(4); assert.equal(h.stage.children.length, 0); assert.equal(h.root.children.length, 0);
    assert.ok(!h.root.classList.contains('has-video') && !h.idle());
    assert.deepEqual(h.last(), { action: 'stop', generation: 4 });
  }

  // --- seeking: live while dragging, never faster than the decoder, never jumping back ---------
  {
    const h = harness(); h.player.show(0, 1); await flush(); h.frame(1); playing(h);
    const p = h.parts();
    p.seek.events.pointerdown();
    p.seek.value = '20'; p.seek.events.input(); await flush();
    assert.deepEqual(h.last(), { action: 'seek', generation: 1, value: 20 }, 'the first move seeks at once');
    assert.ok(p.tip.classes.has('on')); assert.equal(p.tip.textContent, '0:20');
    assert.equal(p.tip.style.left, `${7 + (20 / 60) * 400}px`, 'the label sits over the handle');
    h.advance(30); p.seek.value = '25'; p.seek.events.input();
    h.advance(30); p.seek.value = '30'; p.seek.events.input(); await flush();
    assert.equal(h.sent('seek').length, 1, 'moves inside the gap wait');
    playing(h, { time: 10.4 });
    assert.equal(p.seek.value, '30', 'a report must not pull the handle from under the pointer');
    h.advance(120); await flush();
    assert.equal(h.sent('seek').length, 2); assert.equal(h.last().value, 30, 'the waiting move goes out with the LATEST position');
    p.seek.value = '42.5'; p.seek.events.input(); p.seek.events.pointerup(); p.seek.events.change(); await flush();
    assert.equal(h.last().value, 42.5, 'release always sends the final position');
    assert.ok(!p.tip.classes.has('on'));
    const seeks = h.sent('seek').length; h.advance(500); await flush();
    assert.equal(h.sent('seek').length, seeks, 'no stray seek after release');
    playing(h, { time: 20.2 });
    assert.equal(p.seek.value, '42.5', 'a report older than the seek is ignored'); assert.equal(p.time.textContent, '0:42 / 1:00');
    playing(h, { time: 42.6 });
    assert.equal(p.seek.value, '42.6', 'the decoder caught up: its position is the truth again');
    // A decoder that never confirms must not freeze the timeline.
    p.seek.value = '5'; p.seek.events.input(); p.seek.events.change();
    h.advance(1600); playing(h, { time: 33 });
    assert.equal(p.seek.value, '33');
    // Pointer over the timeline: time under the pointer, without seeking.
    const before = h.requests.length;
    p.seek.events.pointermove({ clientX: 100 + 7 + 100 });
    assert.equal(p.tip.textContent, '0:15'); assert.equal(p.seek.vars['--h'], '0.2500'); assert.equal(h.requests.length, before);
    p.seek.events.pointerleave(); assert.ok(!p.tip.classes.has('on')); assert.equal(p.seek.vars['--h'], '0');
    // At the ends the label stops at the window edge instead of running off it.
    p.seek.events.pointermove({ clientX: 100 + 414 }); assert.equal(p.tip.textContent, '1:00'); assert.equal(p.tip.style.left, `${414 - 18}px`);
    p.seek.events.pointermove({ clientX: 100 }); assert.equal(p.tip.textContent, '0:00'); assert.equal(p.tip.style.left, '18px');
    p.seek.events.pointerleave();
    // A focused timeline steps by seconds and keeps the key from the viewer (no file change).
    const pressed = { key: 'ArrowRight', stops: 0, prevented: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stops++; } };
    p.seek.events.keydown(pressed); await flush();
    assert.equal(h.last().value, 38); assert.deepEqual([pressed.prevented, pressed.stops], [1, 1]);
    const tab = { key: 'Tab', preventDefault() { throw new Error('Tab must stay free'); }, stopPropagation() {} };
    p.seek.events.keydown(tab);
  }

  // --- keyboard and presses on the picture ------------------------------------------------------
  {
    const h = harness(); h.player.show(0, 1); await flush();
    assert.equal(h.key('Space')[0], false, 'no keys before the first frame');
    h.frame(1); playing(h);
    const p = h.parts();
    const [handled, event] = h.key('Space'); await flush();
    assert.ok(handled && event.prevented); assert.equal(h.last().action, 'pause');
    assert.equal(p.flash.attrs['data-icon'], 'pause'); assert.ok(p.flash.classes.has('on'), 'the frame answers a key press');
    assert.equal(h.key('KeyK')[0], true);
    assert.equal(h.key('ArrowLeft')[0], false, 'plain arrows stay with the viewer: previous/next file');
    assert.equal(h.key('ArrowRight')[0], false);
    h.key('ArrowRight', { shiftKey: true }); await flush(); assert.deepEqual(h.last(), { action: 'seek', generation: 1, value: 15 });
    h.key('ArrowRight', { shiftKey: true }); await flush(); assert.equal(h.last().value, 20, 'repeated steps add up before the decoder answers');
    h.key('KeyJ'); await flush(); assert.equal(h.last().value, 10);
    h.key('KeyL'); h.key('KeyL'); await flush(); assert.equal(h.last().value, 30);
    h.key('Digit5'); await flush(); assert.equal(h.last().value, 30); h.key('Digit9'); await flush(); assert.equal(h.last().value, 54);
    h.key('KeyL'); await flush(); assert.equal(h.last().value, 60, 'never past the end');
    h.key('Home'); await flush(); assert.equal(h.last().value, 0);
    h.key('ArrowDown'); await flush(); assert.deepEqual(h.last(), { action: 'volume', generation: 1, value: 95 });
    h.key('ArrowUp'); h.key('ArrowUp'); await flush(); assert.equal(h.last().value, 100, 'never above full');
    h.key('KeyM'); await flush(); assert.equal(h.last().value, 0); h.key('KeyM'); await flush(); assert.equal(h.last().value, 100);
    const count = h.requests.length;
    assert.equal(h.key('KeyM', { ctrlKey: true })[0], false); assert.equal(h.key('Space', { target: p.play })[0], false, 'a focused button presses itself');
    assert.equal(h.key('Digit5', { target: p.seek })[0], false); assert.equal(h.key('KeyX')[0], false);
    h.setPopup(h.root); assert.equal(h.key('Space')[0], false, 'an open menu owns the keyboard'); h.setPopup(null);
    assert.equal(h.requests.length, count);
    // The picture is play/pause; anything else is the viewer's business (close / fit).
    assert.equal(h.player.click(h.root), false); assert.equal(h.player.click(p.guard), false); assert.equal(h.player.owns(p.canvas), true);
    assert.equal(h.requests.length, count);
    playing(h, { paused: true });
    assert.equal(h.player.click(p.canvas), true); await flush();
    assert.equal(h.last().action, 'pause'); assert.equal(p.flash.attrs['data-icon'], 'play', 'the feedback shows what the press did');
    h.state({ type: 'error', generation: 1 }); assert.equal(h.player.click(p.canvas), false); assert.equal(h.key('Space')[0], false);
  }

  // --- the panel leaves only while the video plays and nobody uses it ---------------------------
  {
    const h = harness(); h.player.show(0, 1); await flush();
    const p = h.parts(), move = (x, target = h.root) => h.docEvents.pointermove({ type: 'pointermove', clientX: x, clientY: 5, target });
    h.advance(10000); assert.ok(!h.idle(), 'nothing hides while the video is still opening');
    h.frame(1); playing(h);
    h.advance(2500); assert.ok(!h.idle()); h.advance(200); assert.ok(h.idle(), 'playing and untouched: the panel leaves');
    move(40); assert.ok(!h.idle(), 'a movement brings it back');
    h.advance(2700); assert.ok(h.idle());
    move(40); assert.ok(h.idle(), 'the same point again is not a movement (Chromium repeats it after layout)');
    move(41, p.play); h.advance(9000); assert.ok(!h.idle(), 'the pointer rests on the panel: it stays');
    move(42); h.advance(2700); assert.ok(h.idle());
    playing(h, { paused: true }); assert.ok(!h.idle(), 'pause shows the panel');
    h.advance(60000); assert.ok(!h.idle(), 'and it stays while paused');
    playing(h); h.advance(2700); assert.ok(h.idle(), 'playing again hides it again');
    h.docEvents.keydown({}); assert.ok(!h.idle(), 'a key press shows it');
    h.setPopup(h.root); h.advance(9000); assert.ok(!h.idle(), 'an open menu keeps everything visible'); h.setPopup(null);
    h.document.activeElement = p.volume; h.advance(9000); assert.ok(!h.idle(), 'keyboard focus in the panel keeps it visible');
    h.document.activeElement = null; h.advance(2700); assert.ok(h.idle());
    move(43); p.seek.events.pointerdown(); move(44); h.advance(9000); assert.ok(!h.idle(), 'never while the timeline is being dragged');
    p.seek.events.pointerup(); h.advance(2700); assert.ok(h.idle());
    h.player.stop(1); assert.ok(!h.idle(), 'a photo after the video must not inherit a hidden panel');
    h.advance(60000); assert.ok(!h.idle());
  }

  // --- the sound level is remembered, and asked for before the first sound -----------------------
  {
    const h = harness(); h.player.show(0, 1); await flush(); h.frame(1); playing(h);
    const p = h.parts();
    p.volume.value = '35'; p.volume.events.input(); await flush();
    assert.deepEqual(h.last(), { action: 'volume', generation: 1, value: 35 }); assert.equal(p.volume.vars['--p'], '0.35');
    playing(h, { volume: 100 });
    assert.equal(p.volume.value, '35', 'a report older than the request must not move the level back');
    playing(h, { volume: 35 }); playing(h, { volume: 60 });
    assert.equal(p.volume.value, '60', 'once confirmed, the decoder is the truth again');
    let wheel = 0; p.sound.events.wheel({ deltaY: -100, preventDefault() { wheel++; } }); await flush();
    assert.equal(h.last().value, 65); assert.equal(wheel, 1, 'the wheel over the sound control changes the level, not the zoom');
    p.mute.events.click();
    assert.deepEqual(JSON.parse(h.store.get('znada.viewer.videoSound')), { level: 65, muted: true });
  }
  {
    const h = harness({ saved: { level: 40, muted: false } }); h.player.show(0, 1); await flush();
    assert.deepEqual(h.last(), { action: 'volume', generation: 1, value: 40 }, 'asked right after open, before the first sound');
    const p = h.parts(); assert.equal(p.volume.value, '40');
    h.frame(1); playing(h, { volume: 100 });
    assert.equal(p.volume.value, '40'); assert.equal(h.sent('volume').length, 1, 'no second request inside the retry window');
    h.advance(500); playing(h, { volume: 100 }); await flush();
    assert.equal(h.sent('volume').length, 2, 'a request the decoder was not ready to hear is repeated');
    playing(h, { volume: 40 }); h.advance(500); playing(h, { volume: 40 });
    assert.equal(h.sent('volume').length, 2, 'and not repeated once it landed');
    h.player.stop(1); h.player.show(1, 2); await flush();
    assert.deepEqual(h.last(), { action: 'volume', generation: 2, value: 40 }, 'the next video in the same viewer keeps the level');
  }
  {
    const h = harness({ saved: { level: 70, muted: true } }); h.player.show(0, 1); await flush();
    assert.equal(h.last().value, 0); assert.equal(h.parts().mute.attrs['data-level'], 'off');
    h.parts().mute.events.click(); await flush(); assert.equal(h.last().value, 70);
  }
  {
    const h = harness({ saved: { level: 'loud' } }); h.player.show(0, 1); await flush();
    assert.equal(h.requests.length, 1, 'unreadable storage means the default: with sound, full level');
  }
  console.log('PASS viewer-video: controls, clock/end, frames, stale/error/close, zoom, seek, keys, idle panel, sound memory');
})().catch(error => { console.error(error); process.exitCode = 1; });
