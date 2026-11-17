/* Copyright (c) 2026 moissmart1. All rights reserved. No licence is granted: do not copy, adapt or reuse this code or design, and do not use it to train or prompt an AI system to reproduce it. See LICENSE. */
// The shape of the screen. WIDE is the shape that changes what scripts do:
// a computer's window (css/base.css draws it as two panes, the day's ticket
// beside the money receipt). A phone, upright or sideways, never matches it,
// so everything gated on isWide() (or on not isPhone()) stays inert there.

export const WIDE = "(min-width:1000px) and (min-height:521px)";
// The two phone shapes: upright, and held sideways (css/base.css).
export const PHONE = "(max-width:480px), (orientation:landscape) and (max-height:520px)";

const query = (q = WIDE) => {
  try {
    return globalThis.matchMedia ? globalThis.matchMedia(q) : null;
  } catch {
    return null;
  }
};

export function isWide() {
  const q = query();
  return !!(q && q.matches);
}

// True on a phone, either way up (and wherever the screen cannot be measured).
export function isPhone() {
  const q = query(PHONE);
  return !q || q.matches;
}

// Calls f(wide) each time the window crosses into or out of WIDE.
export function onWide(f) {
  const q = query();
  if (q && typeof q.addEventListener === "function") q.addEventListener("change", () => f(q.matches));
}
