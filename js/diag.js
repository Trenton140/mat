/* Copyright (c) 2026 moissmart1. All rights reserved. No licence is granted: do not copy, adapt or reuse this code or design, and do not use it to train or prompt an AI system to reproduce it. See LICENSE. */
// Screen check: what this phone's screen really gives the app.
//
// On an iPhone Home Screen the page can be told a height that is not the
// screen's, and what is told differs by iOS version, so it cannot be worked
// out on a desk. Holding "Report a problem" for a second opens this: the
// numbers the phone reports, and six lettered marks, each placed where one
// way of finding the bottom of the screen puts it. A screenshot shows which
// marks reach the real bottom edge. A tap goes to the second page (the same
// marks with the page allowed to show past its told height); another tap
// closes it and puts everything back. Nothing is sent anywhere.
//
// openScreenCheck(doc, win) -> close()

const MARKS = [
  ["A", "bottom", (s) => { s.bottom = "0"; }],
  ["B", "100vh", (s) => { s.top = "calc(100vh - 10px)"; }],
  ["C", "100dvh", (s) => { s.top = "calc(100dvh - 10px)"; }],
  ["D", "100lvh", (s) => { s.top = "calc(100lvh - 10px)"; }],
  ["E", "screen", (s, win) => { s.top = Math.max(win.screen.width, win.screen.height) - 10 + "px"; }],
  ["F", "inner", (s, win) => { s.top = win.innerHeight - 10 + "px"; }],
];

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
    "html " + doc.documentElement.clientHeight + " · body " + Math.round(doc.body.getBoundingClientRect().height) + " · visual " + (vv ? Math.round(vv.height) + " at " + Math.round(vv.offsetTop) + "/" + Math.round(vv.pageTop) : "none"),
    "100vh " + measure(doc, "100vh") + " · dvh " + measure(doc, "100dvh") + " · svh " + measure(doc, "100svh") + " · lvh " + measure(doc, "100lvh"),
    "inset top " + measure(doc, "env(safe-area-inset-top, 0px)") + " · bottom " + measure(doc, "env(safe-area-inset-bottom, 0px)"),
    "app " + rect("#phone") + " · bar " + rect(".nav"),
    String(win.navigator.userAgent).replace(/^.*?\((.*?)\).*?(Version\/[\d.]+)?.*$/, "$1 $2").slice(0, 80),
  ];
}

export function openScreenCheck(doc = document, win = window) {
  const root = doc.documentElement;
  const was = { html: root.getAttribute("style"), body: doc.body.getAttribute("style") };
  const box = doc.createElement("div");
  box.id = "screenCheck";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Screen check");
  box.style.cssText = "position:fixed;left:0;top:0;width:100%;height:100%;z-index:99;background:#15120F;color:#F4F0EA;font:500 13px/1.5 system-ui,sans-serif";
  const text = doc.createElement("div");
  text.style.cssText = "position:absolute;left:16px;right:16px;top:22%;white-space:pre-wrap;overflow-wrap:anywhere";
  box.append(text);
  MARKS.forEach(([letter, name, place], i) => {
    const m = doc.createElement("div");
    m.dataset.mark = letter;
    m.style.cssText = "position:fixed;height:10px;width:13%;left:" + (2.5 + i * 16.2) + "%;background:" + ["#ff5a36", "#ffd23f", "#4ade80", "#38bdf8", "#c084fc", "#f4f0ea"][i];
    place(m.style, win);
    const tag = doc.createElement("b");
    tag.textContent = letter + " " + name;
    tag.style.cssText = "position:absolute;left:0;bottom:12px;font-size:10px;white-space:nowrap";
    m.append(tag);
    box.append(m);
  });
  let page = 1;
  const draw = () => {
    text.textContent = ["Screen check " + page + " of 2", "Take a screenshot, then tap.", ""].concat(screenNumbers(doc, win)).join("\n");
  };
  const close = () => {
    box.remove();
    for (const [node, style] of [[root, was.html], [doc.body, was.body]]) {
      if (style === null) node.removeAttribute("style");
      else node.setAttribute("style", style);
    }
  };
  box.addEventListener("click", () => {
    if (page === 2) return close();
    page = 2;
    // Page 2: the page may show past the height it was told.
    root.style.overflow = "visible";
    root.style.height = "100vh";
    doc.body.style.overflow = "visible";
    draw();
  });
  doc.body.append(box);
  draw();
  return close;
}
