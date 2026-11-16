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

// ---------- the planner sheet (Task 12, R39) ----------
// Made-up id and rows. Setup.js and Env.js over stand-ins for Sheets and Logger.
const PLANNER_ID = "fakePlannerSheet_0123456789abcdefXYZ";
const PHEAD = ["payment_id", "date_paid", "payer", "description", "category", "vendor", "booking_ref", "amount", "currency", "amount_cad", "cad_is_exact", "split_between", "split_type", "status", "include_in_split", "source", "added_by", "notes"];

function plannerWorld({ props = {}, get }) {
  const logged = [];
  const asked = [];
  const ctx = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    Sheets: { Spreadsheets: { Values: { get: (...a) => { asked.push(a); return get(...a); } } } },
    Logger: { log: (x) => logged.push(String(x)) },
  });
  for (const f of ["Pure.js", "Env.js", "Setup.js"]) vm.runInContext(src(f), ctx, { filename: f });
  return { ctx, logged, asked, props };
}

test("plannerRows_ asks the Sheets service for Payments!A1:R, unformatted, dates as shown; setPlannerId_ keeps the id in PLANNER_ID", () => {
  const w = plannerWorld({ props: {}, get: () => ({ values: [PHEAD] }) });
  assert.equal(w.ctx.plannerId_(), null);
  w.ctx.setPlannerId_(PLANNER_ID);
  assert.equal(w.props.PLANNER_ID, PLANNER_ID);
  assert.deepEqual(JSON.parse(JSON.stringify(w.ctx.plannerRows_())), [PHEAD]);
  assert.deepEqual(JSON.parse(JSON.stringify(w.asked)), [[PLANNER_ID, "Payments!A1:R", { valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" }]]);
  const empty = plannerWorld({ props: { PLANNER_ID }, get: () => ({}) });
  assert.deepEqual(JSON.parse(JSON.stringify(empty.ctx.plannerRows_())), []);
});

test("checkPlanner logs the row count or the problem, never a value or the id", () => {
  const row = PHEAD.map((h) => ({ payment_id: "X7", payer: "Mo", description: "Secret Inn", amount: 24750, currency: "JPY", split_between: "Mo", split_type: "equal", include_in_split: "yes" })[h] || "");
  const good = plannerWorld({ props: { PLANNER_ID }, get: () => ({ values: [PHEAD, row, [], row.map((c, i) => (i === 0 ? "X8" : c))] }) });
  good.ctx.checkPlanner();
  assert.deepEqual(good.logged, ["Planner: 2 payment rows, columns ok"]);

  const missing = plannerWorld({ props: { PLANNER_ID }, get: () => ({ values: [PHEAD.filter((h) => h !== "amount_cad"), row] }) });
  missing.ctx.checkPlanner();
  assert.deepEqual(missing.logged, ["Planner: The planner’s Payments tab is missing the column amount_cad."]);

  const fails = plannerWorld({ props: { PLANNER_ID }, get: () => { throw new Error("Requested entity was not found: " + PLANNER_ID); } });
  fails.ctx.checkPlanner();
  assert.deepEqual(fails.logged, ["Planner: couldn’t read its Payments tab. Check the id and that this account can open the sheet."]);

  const none = plannerWorld({ props: {}, get: () => { throw new Error("not called"); } });
  none.ctx.checkPlanner();
  assert.deepEqual(none.logged, ["Planner: not linked yet. Link it with linkPlanner first."]);

  const all = [good, missing, fails, none].flatMap((w) => w.logged).join("\n");
  assert.equal(all.includes(PLANNER_ID), false);
  assert.equal(/Secret Inn|24750|X7/.test(all), false);
});
