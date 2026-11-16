/* Copyright (c) 2026 moissmart1. All rights reserved. No licence is granted: do not copy, adapt or reuse this code or design, and do not use it to train or prompt an AI system to reproduce it. See LICENSE. */
// The one clock the Days screen reads. Normally the real time; a demo can
// pretend to be a trip day (07:00, running 120x, holding at 23:30). The demo
// lives in memory only, so a reload ends it.

import { instantOf } from "./plan.js";

const SPEED = 120;

export function createClock({ now = () => Date.now(), getTz }) {
  let demo = null; // { date, realStart, base, cap }
  const listeners = new Set();
  const tell = () => listeners.forEach((fn) => fn());
  return {
    now() {
      if (!demo) return now();
      return Math.min(demo.base + (now() - demo.realStart) * SPEED, demo.cap);
    },
    demoDay: () => (demo ? demo.date : null),
    // A demo that has reached its end of day and stands still.
    holding: () => !!demo && demo.base + (now() - demo.realStart) * SPEED >= demo.cap,
    start(date) {
      const tz = getTz();
      demo = { date, realStart: now(), base: instantOf(tz, date, 7 * 60), cap: instantOf(tz, date, 23 * 60 + 30) };
      tell();
    },
    stop() {
      demo = null;
      tell();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
