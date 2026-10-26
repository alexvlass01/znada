'use strict';

// DESIGN-010i. The highlight of the active tab in the title-bar switcher (Home / Library /
// Appearance) travels to the clicked tab instead of jumping. The owner's reference is
// Takayu Studio "s-split" (https://motion-reference.takayustudio.jp/#motion=s-split): the
// edge on the side of the new tab leaves first on a stiff spring, the other edge follows on
// a softer one, so the highlight stretches towards the new tab and then shrinks back to its
// width. Owner's answers 2026-10-17: springs as in the reference, about 400 ms in total;
// when Settings opens (no tab is active) the highlight fades out where it stands.
//
// renderer.js is not touched: showPage keeps toggling `.navbtn.active`, and this module
// watches that class. The highlight is one absolutely positioned element inside `.tb-nav`,
// so animating its left/width lays out nothing but itself — the page and the gallery never
// move. With "reduce motion" it is placed instantly.

(function initNavPill(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NavPill = api;
  if (root && root.document && typeof module === 'undefined') {
    const nav = root.document.getElementById('tbNav');
    if (nav) api.attach(nav);
  }
}(typeof window !== 'undefined' ? window : globalThis, function navPillFactory() {
  // The reference's springs, as (stiffness, damping) with mass 1.
  const FRONT = { stiffness: 320, damping: 30 };
  const BACK = { stiffness: 140, damping: 22 };
  const DURATION = 400;      // ms; the two springs are played over exactly this time
  const STEPS = 48;          // keyframes, ~8 ms apart — smoother than a 60 Hz frame
  const SETTLED = 0.005;     // both edges within 0.5% of the distance: the springs are done
  const SIM_DT = 1 / 2000;   // seconds per simulation step

  // Progress 0 → 1 of a spring released from rest, sampled every SIM_DT seconds until it
  // has settled. Semi-implicit Euler is plenty at this step for these stiffnesses.
  function springTrack(spring) {
    const out = [0];
    let x = 0;
    let v = 0;
    for (let i = 0; i < 20000; i += 1) {
      v += (-spring.stiffness * (x - 1) - spring.damping * v) * SIM_DT;
      x += v * SIM_DT;
      out.push(x);
      if (Math.abs(1 - x) < SETTLED && Math.abs(v) < SETTLED * 10) break;
    }
    return out;
  }

  const sampleAt = (track, index) => (index < track.length ? track[index] : 1);

  // Keyframes for moving the highlight from [fromL, fromR] to [toL, toR] (pixels from the
  // switcher's left edge). The edge on the side of the movement is the front one. Both
  // springs share one clock — the slower one decides when the move is over — and that clock
  // is stretched or squeezed to DURATION, so the shape is the reference's and the length is
  // the owner's. The first and last frames are exact.
  function splitFrames(fromL, fromR, toL, toR, steps = STEPS) {
    const rightward = (toL + toR) >= (fromL + fromR);
    const front = springTrack(FRONT);
    const back = springTrack(BACK);
    const last = Math.max(front.length, back.length) - 1;
    const frames = [];
    for (let i = 0; i <= steps; i += 1) {
      const at = Math.round((i / steps) * last);
      const pf = i === steps ? 1 : sampleAt(front, at);
      const pb = i === steps ? 1 : sampleAt(back, at);
      const pl = rightward ? pb : pf;
      const pr = rightward ? pf : pb;
      const left = fromL + (toL - fromL) * pl;
      const right = fromR + (toR - fromR) * pr;
      frames.push({ left: `${left}px`, width: `${Math.max(0, right - left)}px` });
    }
    return frames;
  }

  // Wires the highlight to `.tb-nav`. `env` exists for tests; in the window it is the window.
  function attach(nav, env = globalThis) {
    const pill = nav.querySelector('.tb-nav-pill');
    if (!pill) return null;
    let anim = null;
    let lastActive = null;
    const reduced = () => Boolean(env.matchMedia
      && env.matchMedia('(prefers-reduced-motion: reduce)').matches);

    function place(btn, animate) {
      if (!btn) { pill.classList.add('off'); return; } // Settings: fade out where it stands
      const toL = btn.offsetLeft;
      const toW = btn.offsetWidth;
      if (!toW) return; // switcher not shown yet (first run); the resize watch places it later
      const style = env.getComputedStyle(pill); // mid-move this is where the pill is NOW
      const fromL = parseFloat(style.left) || 0;
      const fromW = parseFloat(style.width) || 0;
      const wasHidden = pill.classList.contains('off') || !fromW;
      if (anim) { anim.cancel(); anim = null; }
      pill.style.left = `${toL}px`;
      pill.style.width = `${toW}px`;
      pill.classList.remove('off');
      if (!animate || wasHidden || reduced() || (fromL === toL && fromW === toW)) return;
      anim = pill.animate(splitFrames(fromL, fromL + fromW, toL, toL + toW),
        { duration: DURATION, easing: 'linear' });
      anim.onfinish = () => { anim = null; };
    }

    const sync = (animate) => {
      const btn = nav.querySelector('.navbtn.active');
      if (animate && btn === lastActive) return;
      lastActive = btn;
      place(btn, animate);
    };

    new env.MutationObserver(() => sync(true))
      .observe(nav, { subtree: true, attributes: true, attributeFilter: ['class'] });
    // A language switch changes the tabs' widths; the first-run screen hides the switcher.
    if (env.ResizeObserver) {
      const ro = new env.ResizeObserver(() => sync(false));
      ro.observe(nav);
      nav.querySelectorAll('.navbtn').forEach((b) => ro.observe(b));
    }
    sync(false);
    return { sync, place };
  }

  return { FRONT, BACK, DURATION, springTrack, splitFrames, attach };
}));
