/* Copyright (c) 2026 moissmart1. All rights reserved. No licence is granted: do not copy, adapt or reuse this code or design, and do not use it to train or prompt an AI system to reproduce it. See LICENSE. */
// The Home Screen app gets its full height back after the keyboard.
//
// A known iPhone fault: in an app opened from the Home Screen, the first time
// the keyboard opens the page is told it is shorter, and it is never told
// otherwise when the keyboard closes. Until the app is force-quit the bottom
// bar floats above a dead band, and nothing drawn below the told height
// shows (so stretching the page does not help: version 11 tried).
// What does help is making the phone measure again: taking the app's
// full-height element out of the layout and putting it straight back, in
// one step, with nothing drawn in between.
//
// shrunkBy(win) -> px the page is short of the screen in a Home Screen app (0 elsewhere)
// nudge(doc)    -> takes #phone out and puts it back; every scroll place and
//                  the focus are kept. true when it did.
// watchViewport(win, doc): nudges while the page is short and no field has
//   the keyboard: shortly after a field loses focus, when the app comes back
//   on screen, and once after starting.

import { fullHeight } from "./fill.js";

export const SHORT_BY_PX = 4;
export const NUDGE_AT_MS = [140, 500, 1200];

export function shrunkBy(win) {
  const full = fullHeight({
    standalone: win.navigator && win.navigator.standalone,
    innerWidth: win.innerWidth,
    innerHeight: win.innerHeight,
    screenW: win.screen && win.screen.width,
    screenH: win.screen && win.screen.height,
  });
  return full ? full - win.innerHeight : 0;
}

export function nudge(doc) {
  const phone = doc.getElementById("phone");
  if (!phone) return false;
  const at = doc.activeElement;
  const places = [];
  for (const n of [phone, ...phone.querySelectorAll("*")]) {
    if (n.scrollTop > 0 || n.scrollLeft > 0) places.push([n, n.scrollTop, n.scrollLeft]);
  }
  const was = phone.style.display;
  phone.style.display = "none";
  void phone.offsetHeight; // measured now, before anything is drawn
  phone.style.display = was;
  // At once, not eased: a view that scrolls smoothly would visibly travel back.
  for (const [n, top, left] of places) {
    try {
      n.scrollTo({ top, left, behavior: "instant" });
    } catch {
      n.scrollTop = top;
      n.scrollLeft = left;
    }
  }
  if (at && at !== doc.body && phone.contains(at) && doc.activeElement !== at) {
    try {
      at.focus({ preventScroll: true });
    } catch {
      // focus stays where the phone put it
    }
  }
  return true;
}

const isField = (n) => !!n && /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName || "");

export function watchViewport(win = window, doc = document) {
  const tryNow = () => {
    if (isField(doc.activeElement)) return; // the keyboard is up, or about to be
    if (shrunkBy(win) <= SHORT_BY_PX) return;
    nudge(doc);
  };
  const soon = () => NUDGE_AT_MS.forEach((ms) => win.setTimeout(tryNow, ms));
  doc.addEventListener("focusout", (ev) => {
    if (isField(ev.target)) soon();
  });
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState !== "hidden") soon();
  });
  soon();
}
