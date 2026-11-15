// The Apps Script glue (Env.js, Rate.js, Setup.js) evaluated over stand-ins
// for the Google services, to pin down the order of calls and the messages.
// Not proof that Google behaves this way: that needs the real thing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BACKEND = path.join(__dirname, "..", "backend");
const src = (f) => fs.readFileSync(path.join(BACKEND, f), "utf8");

function world({ props = {}, fetch } = {}) {
  const calls = [];
  const cache = new Map();
  const ctx = vm.createContext({
    calls,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => { calls.push("prop:" + k); return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
      setProperty: (k, v) => { props[k] = String(v); },
    }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => (cache.has(k) ? cache.get(k) : null),
      put: (k, v, s) => { calls.push("cache.put:" + k + ":" + s); cache.set(k, v); },
      remove: (k) => cache.delete(k),
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => calls.push("release") }) },
    SpreadsheetApp: { flush: () => calls.push("flush") },
    Utilities: { formatDate: () => "2026-12-10" },
    UrlFetchApp: { fetch: (url, opts) => { calls.push("fetch:" + url); return fetch(); } },
  });
  for (const f of ["Pure.js", "Env.js", "Rate.js"]) vm.runInContext(src(f), ctx, { filename: f });
  ctx.props = props;
  return ctx;
}

const reply = (code, body) => () => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });

test("withLock_ flushes pending Sheet writes before it lets go of the lock, even when fn throws (F8)", () => {
  const w = world();
  assert.equal(w.withLock_(() => 7), 7);
  assert.deepEqual(w.calls.slice(-2), ["flush", "release"]);
  assert.throws(() => w.withLock_(() => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(w.calls.slice(-2), ["flush", "release"]);
});

test("tripKey_ keeps the key in the script cache for six hours, reading Script Properties only on a miss (F12)", () => {
  const w = world({ props: { TRIP_KEY: "k1" } });
  assert.equal(w.tripKey_(), "k1");
  assert.equal(w.tripKey_(), "k1");
  assert.equal(w.tripKey_(), "k1");
  assert.equal(w.calls.filter((c) => c === "prop:TRIP_KEY").length, 1);
  assert.ok(w.calls.includes("cache.put:TRIP_KEY:21600"));
  const none = world();
  assert.equal(none.tripKey_(), null);
});

test("getRateInfo_ says live for a fetched rate, last for an earlier day's, fallback for 111 (F7)", () => {
  const live = world({ fetch: reply(200, { rates: { JPY: 108.4 } }) });
  assert.deepEqual(JSON.parse(JSON.stringify(live.getRateInfo_())), { rate: 108.4, source: "live" });
  assert.equal(live.getRate_(), 108.4);
  const last = world({ props: { RATE_LAST: "107.9" }, fetch: reply(500, {}) });
  assert.deepEqual(JSON.parse(JSON.stringify(last.getRateInfo_())), { rate: 107.9, source: "last" });
  const none = world({ fetch: () => { throw new Error("DNS error"); } });
  assert.deepEqual(JSON.parse(JSON.stringify(none.getRateInfo_())), { rate: 111, source: "fallback" });
});

test("requireLiveRate_ (run by setup) fetches once and fails loudly with the reason (F7)", () => {
  const ok = world({ fetch: reply(200, { rates: { JPY: 108.4 } }) });
  ok.requireLiveRate_();
  assert.equal(ok.props["RATE_2026-12-10"], "108.4");

  const blocked = world({ props: { RATE_FAIL_AT: new Date().toISOString() }, fetch: reply(403, {}) });
  assert.throws(() => blocked.requireLiveRate_(), (e) => e.message === "Couldn’t fetch today’s yen rate from open.er-api.com: HTTP 403. The app would fall back to 111.");
  assert.equal(blocked.calls.filter((c) => c.startsWith("fetch:")).length, 1, "tried even within the hour after a failure");

  const down = world({ fetch: () => { throw new Error("Address unavailable"); } });
  assert.throws(() => down.requireLiveRate_(), /: Address unavailable\. The app would fall back to 111\.$/);

  const odd = world({ fetch: reply(200, { rates: { JPY: 5 } }) });
  assert.throws(() => odd.requireLiveRate_(), /: an unexpected rate \(5\)\./);

  const stored = world({ props: { "RATE_2026-12-10": "108" }, fetch: () => { throw new Error("not called"); } });
  stored.requireLiveRate_();
});

test("setup() checks the rate after building the tabs", () => {
  const s = src("Setup.js");
  const body = s.slice(s.indexOf("function setup()"), s.indexOf("function seedIfEmpty_"));
  assert.match(body, /requireLiveRate_\(\);\s*\}\s*$/);
});
