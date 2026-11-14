// Shared tools for the click-through tests (*.e2e.cjs), run by run.cjs.
//
// The fake backend lives in Node (ruling R3): tests/fake-backend.cjs runs the
// real backend action code over in-memory tables, and the page reaches it
// through a function bridged in with page.exposeFunction. So data survives a
// reload, two pages can share one backend, and tests can look at the tables
// or act as "another phone" by calling backend.handle(...) directly.

const fs = require("fs");
const path = require("path");
const { createFakeBackend } = require("../fake-backend.cjs");

const ORIGIN = "http://localhost:4173";
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "seed.json"), "utf8"));
// 2026-12-12 13:20 in Japan.
const NOON12 = Date.parse("2026-12-12T13:20:00+09:00");
// When seed items without an addedAt / stampedAt were made: before the trip,
// so they are never "new" to a viewer who has looked since.
const SEEDED_AT = "2026-11-20T00:00:00.000Z";

const copy = (v) => JSON.parse(JSON.stringify(v));

// backend = { handle(body) -> Promise<envelope>, fake, requests, failWith }.
// failWith: null (normal), "network" (handle rejects, so the page's call
// fails as if there were no signal), or any other string (handle resolves
// { ok: false, error: <that string>, message: "test" }).
// Seed items with no addedAt / stampedAt get SEEDED_AT; later writes are
// dated by `clock` (default: the real time).
function makeBackend(seed, { clock } = {}) {
  let seeding = true;
  const now = clock || (() => new Date().toISOString());
  const fake = createFakeBackend(copy(seed || {}), { clock: () => (seeding ? SEEDED_AT : now()) });
  seeding = false;
  const backend = {
    fake,
    requests: fake.requests,
    failWith: null,
    async handle(body) {
      if (backend.failWith === "network") throw new Error("network");
      if (backend.failWith) return { ok: false, error: backend.failWith, message: "test" };
      return fake(body);
    },
  };
  return backend;
}

// Opens the app on `page` against a fake backend and returns that backend.
// - seed / backend: build a backend from `seed`, or use the one given (pass
//   the same backend to two pages to share it).
// - key, me: put into localStorage as mat.key / mat.me; null leaves it unset.
// - storage: more localStorage keys. Every key is only written when not set
//   already, so a reload keeps whatever the app stored.
// - nowMs: the page's clock is installed and paused at this time; move it
//   with page.clock.fastForward / runFor.
// - hash: appended to the address (for example "#k=test-key").
async function open(page, { seed = SEED, key = "test-key", me = "Mo", nowMs = NOON12, storage = {}, backend, hash = "" } = {}) {
  const startedAt = Date.now();
  const be = backend || makeBackend(seed, { clock: () => new Date(nowMs + (Date.now() - startedAt)).toISOString() });

  await page.exposeFunction("__matBridge", async (body) => {
    try {
      return { env: await be.handle(body) };
    } catch {
      return { network: true };
    }
  });
  await page.addInitScript(() => {
    globalThis.MAT_FAKE_API = async (body) => {
      const r = await globalThis.__matBridge(body);
      if (!r || r.network) throw new Error("No signal");
      return r.env;
    };
  });

  const entries = Object.entries({ ...(key === null ? {} : { "mat.key": key }), ...(me === null ? {} : { "mat.me": me }), ...storage })
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => [k, String(v)]);
  await page.addInitScript((pairs) => {
    try {
      for (const [k, v] of pairs) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    } catch {
      // about:blank and the like have no storage
    }
  }, entries);

  await page.clock.install({ time: nowMs });
  await page.clock.pauseAt(nowMs);
  await page.goto(ORIGIN + "/" + hash);
  return be;
}

// Polls `check` (sync or async, run in Node) until it returns something
// truthy, and returns that. Throws Error(message) after `timeout` ms.
// Uses Node's own timers, so it works whatever the page's clock is doing.
async function until(check, message, timeout = 5000) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const v = await check();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(message + (last ? " (" + last.message + ")" : ""));
    await new Promise((r) => setTimeout(r, 40));
  }
}

// The trimmed textContent of the first match, or null when there is none.
function text(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
  }, selector);
}

// Waits for `selector`'s text to equal `expected` (a string) or match it (a RegExp).
async function expectText(page, selector, expected, timeout) {
  let got;
  const ok = (t) => (expected instanceof RegExp ? expected.test(t || "") : t === expected);
  try {
    await until(async () => ok((got = await text(page, selector))), "", timeout);
  } catch {
    throw new Error(selector + ": expected " + JSON.stringify(String(expected)) + ", got " + JSON.stringify(got));
  }
}

// Whether the first match is present and drawn (not hidden, has a size).
function visible(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el || el.closest("[hidden]")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  }, selector);
}

module.exports = { ORIGIN, SEED, NOON12, SEEDED_AT, makeBackend, open, until, text, expectText, visible };
