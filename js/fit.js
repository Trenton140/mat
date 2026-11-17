/* Copyright (c) 2026 moissmart1. All rights reserved. No licence is granted: do not copy, adapt or reuse this code or design, and do not use it to train or prompt an AI system to reproduce it. See LICENSE. */
// Reaching the bottom of the screen in a Home Screen app.
//
// Some iPhones tell a Home Screen page it is shorter than the screen, and
// draw nothing a page pins below that height, so the bottom bar floats above
// a dead band. What works differs by iOS version and cannot be seen from a
// desk, so there are four ways here, each a class on <html> (css/base.css),
// and the Screen check under You tries them on the phone itself. The one
// picked is remembered on that phone.
//
//   ""  as it is: the page is the height it is told
//   a   the page is the screen's height, in px
//   b   the page is 100lvh
//   c   as a, and the page may show past its told height
//   d   the told height plus the top inset
//
// FITS: [[mode, name]] in the order shown.
// fullSide(win) -> the screen's height the way the phone is held, in px
// applyFit(doc, win, mode): sets the class and --full-h; unknown mode = "".
// loadFit(storage) / saveFit(storage, mode): never throw.
// watchFit(doc, win, storage): applies the remembered way now and keeps
//   --full-h right as the phone turns.

export const FITS = [["", "Now"], ["a", "A"], ["b", "B"], ["c", "C"], ["d", "D"]];
// "mat.fit" was the trial before the default was fixed (version 18): not read any more.
const KEY = "mat.fit2";
const known = (mode) => FITS.some(([m]) => m === mode);

export function fullSide(win) {
  const w = win.screen && win.screen.width;
  const h = win.screen && win.screen.height;
  if (!(w > 0 && h > 0)) return 0;
  const upright = !(win.innerWidth > win.innerHeight);
  return upright ? Math.max(w, h) : Math.min(w, h);
}

export function applyFit(doc, win, mode) {
  const root = doc.documentElement;
  const use = known(mode) ? mode : "";
  for (const [m] of FITS) if (m) root.classList.toggle("fit-" + m, m === use);
  const full = fullSide(win);
  if (use && full) root.style.setProperty("--full-h", full + "px");
  else root.style.removeProperty("--full-h");
  return use;
}

export function loadFit(storage) {
  try {
    const v = storage.getItem(KEY);
    return known(v) ? v : "";
  } catch {
    return "";
  }
}

export function saveFit(storage, mode) {
  try {
    storage.setItem(KEY, known(mode) ? mode : "");
  } catch {
    // kept for this visit only
  }
}

export function watchFit(doc, win, storage) {
  let mode = applyFit(doc, win, loadFit(storage));
  const again = () => {
    mode = applyFit(doc, win, loadFit(storage));
  };
  win.addEventListener("resize", again);
  win.addEventListener("orientationchange", again);
  return () => mode;
}
