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
