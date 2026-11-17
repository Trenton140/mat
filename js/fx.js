/* Copyright (c) 2026 moissmart1. All rights reserved. No licence is granted: do not copy, adapt or reuse this code or design, and do not use it to train or prompt an AI system to reproduce it. See LICENSE. */
// Two small effects that need a class added at the right moment (the rest is
// CSS): wet ink on a stamp that has just landed, and a number that rolls in
// when it changes. Neither runs under prefers-reduced-motion: reduce.

export const calm = () => !!(globalThis.matchMedia && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches);

// How long a stamp stays wet before the ink dries back over 1.8 s (css/money.css .stamp).
export const WET_MS = 500;

// A stamp that has just landed: wet at once, drying after WET_MS.
export function wetInk(stamp) {
  if (calm()) return;
  stamp.classList.add("wet");
  setTimeout(() => stamp.classList.remove("wet"), WET_MS);
}

// The new number rolls in with the `roll` keyframes (css/money.css). Taking the
// class off and putting it back after a reflow restarts it for a second change.
export function rollIn(el) {
  if (calm()) return;
  el.classList.remove("rolls");
  void el.offsetWidth;
  el.classList.add("rolls");
}

// How long a count must have been on screen before a change to it rolls: the
// list arrives in steps while the app opens (a cached count, then the fetched
// one), and that is loading, not a change.
export const SETTLE_MS = 2000;

// A count that rolls when it changes after it has settled. set(n) is told each
// draw; reset() when it leaves the screen (the next one is a first count again).
export function rollingCount(el) {
  let shown = null;
  let since = 0;
  return {
    set(n) {
      const t = Date.now();
      if (shown === null) since = t;
      else if (shown !== n && t - since >= SETTLE_MS) rollIn(el);
      shown = n;
    },
    reset() {
      shown = null;
    },
  };
}
