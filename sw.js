// The offline shell. Keeps the app's own files on the phone so it opens
// with no signal, and keeps the Google Fonts it has seen.
//
// - The shell (SHELL below) is cached on install, under a cache named with
//   SW_VERSION, and served cache-first. There is no build step, so SHELL is
//   written by hand: tests/sw-list.test.js fails when a file under css/ or
//   js/, index.html, the manifest or an icon is missing from it, or when it
//   names a file that does not exist. SW_VERSION is a short hash of every
//   shell file, written by `npm run stamp` (scripts/stamp-sw.mjs); the same
//   test fails when it no longer matches the files, so a changed shell always
//   reaches the phones as a new worker.
// - A new worker takes over at once (skipWaiting, then clients.claim) and
//   deletes the older shells. The page is not reloaded for it: the next
//   open gets the new shell.
// - Google Fonts: stale-while-revalidate. When a font cannot be fetched and
//   none is kept, the answer is an empty one, never an error.
// - Never touched: the trip backend (script.google.com and
//   script.googleusercontent.com), and anything else not listed here.
// - Only OK answers are ever kept.

const SW_VERSION = "f0d2b818d6";
const SHELL_CACHE = "mat-shell-" + SW_VERSION;
const FONT_CACHE = "mat-fonts";

const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "css/base.css",
  "css/days.css",
  "css/history.css",
  "css/money.css",
  "css/register.css",
  "css/sheet.css",
  "js/api.js",
  "js/app.js",
  "js/clip.js",
  "js/clock.js",
  "js/config.js",
  "js/format.js",
  "js/money.js",
  "js/plan.js",
  "js/sound.js",
  "js/stamp.js",
  "js/store.js",
  "js/time.js",
  "js/views/alldays.js",
  "js/views/days.js",
  "js/views/first.js",
  "js/views/history.js",
  "js/views/line.js",
  "js/views/money.js",
  "js/views/net.js",
  "js/views/register.js",
  "js/views/slip.js",
  "js/views/staycard.js",
  "js/views/stopsheet.js",
  "js/views/ticket.js",
  "js/views/ubar.js",
  "js/views/uneven.js",
  "js/views/working.js",
  "js/views/you.js",
];

const SHELL_URLS = new Set(SHELL.map((path) => new URL(path, self.registration.scope).href));
const BACKEND_HOSTS = ["script.google.com", "script.googleusercontent.com"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith("mat-shell-") && n !== SHELL_CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// An answer for a font that could not be fetched: empty, so the page falls
// back to the system faces without an error.
function emptyFont(request) {
  const css = new URL(request.url).hostname === "fonts.googleapis.com";
  return css ? new Response("", { status: 200, headers: { "Content-Type": "text/css" } }) : new Response(null, { status: 204 });
}

async function font(event) {
  const request = event.request;
  const cache = await caches.open(FONT_CACHE);
  const kept = await cache.match(request);
  const fresh = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  if (kept) {
    event.waitUntil(fresh);
    return kept;
  }
  return (await fresh) || emptyFont(request);
}

// Opening the app with nothing kept and no signal: a plain page, not an error.
function offlinePage() {
  const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>MAT</title><body style=\"margin:0;min-height:100vh;display:grid;place-items:center;background:#1A1614;color:#F4F0EA;" +
    'font:700 17px/1.4 system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box"><p>No signal. Open again when you have some.</p></body>';
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function shell(request) {
  const navigate = request.mode === "navigate";
  const cache = await caches.open(SHELL_CACHE);
  // Opening the app is always the kept front page.
  const kept = navigate ? await cache.match("./") : await cache.match(request);
  if (kept) return kept;
  try {
    return await fetch(request);
  } catch {
    return navigate ? offlinePage() : Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (BACKEND_HOSTS.includes(url.hostname)) return;
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(font(event));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // Opening the app (with any query) or one of its files.
  const navigate = request.mode === "navigate";
  if (SHELL_URLS.has(navigate ? url.origin + url.pathname : url.href)) event.respondWith(shell(request));
});
