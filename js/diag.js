/* Copyright (c) 2026 moissmart1. All rights reserved. No licence is granted: do not copy, adapt or reuse this code or design, and do not use it to train or prompt an AI system to reproduce it. See LICENSE. */
// What this phone says about its screen, for the Report a problem note.
//
// A layout fault can show on one phone only (a Home Screen app on an iPhone
// was told its page is shorter than the screen: css/base.css), and cannot be
// seen from a desk. These lines say what that phone reports.
//
// screenNumbers(doc, win) -> lines of text. Nothing is sent anywhere.

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
  return [
    "home screen app: " + (win.navigator.standalone === true ? "yes" : "no") + " · " + (win.matchMedia && win.matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser"),
    "screen " + win.screen.width + " x " + win.screen.height + " · inner " + win.innerWidth + " x " + win.innerHeight,
    "page " + doc.documentElement.clientHeight + " · body " + Math.round(doc.body.getBoundingClientRect().height) + " · visual " + (vv ? Math.round(vv.height) + " at " + Math.round(vv.offsetTop) + "/" + Math.round(vv.pageTop) : "none"),
    "100vh " + measure(doc, "100vh") + " · dvh " + measure(doc, "100dvh") + " · svh " + measure(doc, "100svh") + " · lvh " + measure(doc, "100lvh"),
    "inset top " + measure(doc, "env(safe-area-inset-top, 0px)") + " · bottom " + measure(doc, "env(safe-area-inset-bottom, 0px)"),
    "app " + rect("#phone") + " · bar " + rect(".nav"),
    String(win.navigator.userAgent).replace(/^.*?\((.*?)\).*?(Version\/[\d.]+)?.*$/, "$1 $2").slice(0, 80),
  ];
}
