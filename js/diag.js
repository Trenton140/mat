/* Copyright (c) 2026 moissmart1. All rights reserved. No licence is granted: do not copy, adapt or reuse this code or design, and do not use it to train or prompt an AI system to reproduce it. See LICENSE. */
// Screen check: what this phone's screen gives the app, and which way of
// reaching the bottom of the screen works on it (js/fit.js).
//
// A small panel at the top of the screen, with the app still showing under
// it: a button for each way, applied the moment it is tapped, so the person
// can see whether the bottom bar lands on the bottom edge. Done keeps the
// one showing (remembered on this phone). Nothing is sent anywhere.
//
// screenNumbers(doc, win) -> lines of what the phone reports (also put in
//   the Report a problem note).
// openScreenCheck({ doc, win, storage }) -> close()

import { FITS, applyFit, loadFit, saveFit } from "./fit.js";

// The height in px a CSS length comes to on this phone.
function measure(doc, css) {
  const probe = doc.createElement("div");
  probe.style.cssText = "position:fixed;left:-9px;top:0;width:1px;visibility:hidden;pointer-events:none;height:" + css;
  doc.body.append(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return Math.round(h * 10) / 10;
}

export function screenNumbers(doc, win) {
  const vv = win.visualViewport;
  const rect = (sel) => {
    const n = doc.querySelector(sel);
    if (!n) return "none";
    const r = n.getBoundingClientRect();
    return Math.round(r.top) + " to " + Math.round(r.bottom);
  };
  const fit = (String(doc.documentElement.className).match(/(?:^|\s)fit-([a-z])(?:\s|$)/) || [])[1] || "none";
  return [
    "home screen app: " + (win.navigator.standalone === true ? "yes" : "no") + " · " + (win.matchMedia && win.matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser") + " · fit " + fit,
    "screen " + win.screen.width + " x " + win.screen.height + " · inner " + win.innerWidth + " x " + win.innerHeight,
    "html " + doc.documentElement.clientHeight + " · body " + Math.round(doc.body.getBoundingClientRect().height) + " · visual " + (vv ? Math.round(vv.height) + " at " + Math.round(vv.offsetTop) + "/" + Math.round(vv.pageTop) : "none"),
    "100vh " + measure(doc, "100vh") + " · dvh " + measure(doc, "100dvh") + " · svh " + measure(doc, "100svh") + " · lvh " + measure(doc, "100lvh"),
    "inset top " + measure(doc, "env(safe-area-inset-top, 0px)") + " · bottom " + measure(doc, "env(safe-area-inset-bottom, 0px)"),
    "app " + rect("#phone") + " · bar " + rect(".nav"),
    String(win.navigator.userAgent).replace(/^.*?\((.*?)\).*?(Version\/[\d.]+)?.*$/, "$1 $2").slice(0, 80),
  ];
}

export function openScreenCheck({ doc = document, win = window, storage } = {}) {
  let mode = loadFit(storage);
  const box = doc.createElement("div");
  box.id = "screenCheck";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Screen check");
  box.style.cssText = "position:fixed;left:8px;right:8px;top:calc(8px + env(safe-area-inset-top, 0px));z-index:99;padding:12px 14px 14px;border-radius:12px;" +
    "background:rgba(21,18,15,.94);color:#F4F0EA;font:500 13px/1.45 system-ui,sans-serif;box-shadow:0 0 0 1px #4a403b";
  const say = doc.createElement("p");
  say.style.cssText = "margin:0 0 10px;font-weight:700;font-size:14px";
  say.textContent = "Tap A, B, C and D and look at the bottom bar each time. Leave it on the one that sits on the bottom edge, then Done.";
  const row = doc.createElement("div");
  row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
  const text = doc.createElement("div");
  text.style.cssText = "margin-top:10px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;opacity:.8";
  const buttons = [];
  const draw = () => {
    for (const b of buttons) {
      const on = b.dataset.fit === mode;
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.style.background = on ? "#F2F3EF" : "#3B332F";
      b.style.color = on ? "#15120F" : "#F4F0EA";
    }
    text.textContent = screenNumbers(doc, win).slice(0, 6).join("\n");
  };
  const close = () => box.remove();
  const button = (label) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = "flex:1 1 0;min-width:52px;min-height:44px;border:0;border-radius:9px;font:900 15px/1 system-ui,sans-serif";
    row.append(b);
    return b;
  };
  for (const [m, name] of FITS) {
    const b = button(name);
    b.dataset.fit = m;
    buttons.push(b);
    b.addEventListener("click", () => {
      mode = applyFit(doc, win, m);
      saveFit(storage, mode);
      draw();
    });
  }
  const done = button("Done");
  done.id = "screenCheckDone";
  done.style.background = "#D63C1E";
  done.style.color = "#fff";
  done.addEventListener("click", close);
  box.append(say, row, text);
  doc.body.append(box);
  draw();
  return close;
}
