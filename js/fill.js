/* Copyright (c) 2026 moissmart1. All rights reserved. No licence is granted: do not copy, adapt or reuse this code or design, and do not use it to train or prompt an AI system to reproduce it. See LICENSE. */
// The Home Screen app fills the whole screen.
//
// Opened from an iPhone's Home Screen, the page can be told it is shorter
// than the screen (by about the height of the top inset), so the app ended
// early and the bottom bar floated above an empty band. There the app always
// has the whole screen, so its height is the screen's.
//
// fullHeight({ standalone, innerWidth, innerHeight, screenW, screenH }) -> px or 0
//   The screen's height the way the phone is held, when the page is a Home
//   Screen app as wide as the screen and has been told less than that height;
//   otherwise 0 (leave the page alone). In Safari the toolbars really do take
//   the room, and a window narrower than the screen (an iPad side by side) is
//   not the whole screen.
// fillScreen(win, root): applies it now and whenever the window changes size,
//   as --app-h on the root with the "fill" class (css/base.css).

const near = (a, b) => Math.abs(a - b) <= 1;

export function fullHeight({ standalone, innerWidth, innerHeight, screenW, screenH }) {
  if (standalone !== true) return 0;
  const nums = [innerWidth, innerHeight, screenW, screenH];
  if (!nums.every((n) => Number.isFinite(n) && n > 0)) return 0;
  const short = Math.min(screenW, screenH);
  const long = Math.max(screenW, screenH);
  let height;
  if (near(innerWidth, short)) height = long; // upright
  else if (near(innerWidth, long)) height = short; // sideways
  else return 0;
  return innerHeight < height - 1 ? height : 0;
}

export function fillScreen(win = window, root = document.documentElement) {
  const apply = () => {
    const h = fullHeight({
      standalone: win.navigator.standalone,
      innerWidth: win.innerWidth,
      innerHeight: win.innerHeight,
      screenW: win.screen && win.screen.width,
      screenH: win.screen && win.screen.height,
    });
    if (h) root.style.setProperty("--app-h", h + "px");
    else root.style.removeProperty("--app-h");
    root.classList.toggle("fill", !!h);
  };
  apply();
  win.addEventListener("resize", apply);
  win.addEventListener("orientationchange", apply);
}
