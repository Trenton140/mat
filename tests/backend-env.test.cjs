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

function plannerWorld({ props = {}, get, tabs = ["Payments"], noAccess = false, update, append }) {
  const logged = [];
  const asked = [];
  const ctx = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    Utilities: { formatDate: (d, tz, fmt) => { asked.push(["formatDate", tz, fmt]); return "2026-11-20 10:00"; } },
    Sheets: { Spreadsheets: {
      Values: {
        get: (...a) => { asked.push(a); return get(...a); },
        update: (...a) => { asked.push(["update", ...a]); return update ? update(...a) : {}; },
        append: (...a) => { asked.push(["append", ...a]); return append ? append(...a) : {}; },
      },
      get: (...a) => { asked.push(a); if (noAccess) throw new Error("no access"); return { sheets: tabs.map((title) => ({ properties: { title } })) }; },
    } },
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
  // R40 fix 6: no Payments tab (the range can't be read, but the sheet can): null.
  const noTab = plannerWorld({ props: { PLANNER_ID }, tabs: ["Budget"], get: () => { throw new Error("Unable to parse range: Payments!A1:R"); } });
  assert.equal(noTab.ctx.plannerRows_(), null);
  assert.deepEqual(JSON.parse(JSON.stringify(noTab.asked[1])), [PLANNER_ID, { fields: "sheets.properties.title" }]);
  // Any other failure still throws.
  const tabThere = plannerWorld({ props: { PLANNER_ID }, get: () => { throw new Error("quota"); } });
  assert.throws(() => tabThere.ctx.plannerRows_(), /quota/);
  const shut = plannerWorld({ props: { PLANNER_ID }, noAccess: true, get: () => { throw new Error("denied"); } });
  assert.throws(() => shut.ctx.plannerRows_());
});

// Book Now and Change Log as the planner holds them (made up), for checkPlanner.
const BOOK = [["Before we go"], ["#", "Item", "Book by", "Status"], [1, "Secret Tour", "Dec 5", ""], [2, "Hidden Inn", "", "Booked"], ["* footnote"]];
const CLOG = [["#", "Tab", "Old value", "New value"], [1, "Book Now", "Private old", "Private new"]];
const byRange = (payments, book = BOOK, log = CLOG) => (id, range) => {
  if (range.startsWith("Payments!")) return { values: payments };
  if (range.startsWith("'Book Now'!")) { if (book instanceof Error) throw book; return { values: book }; }
  if (range.startsWith("'Change Log'!")) { if (log instanceof Error) throw log; return { values: log }; }
  throw new Error("Unable to parse range: " + range);
};

test("checkPlanner logs the row count or the problem, never a value or the id", () => {
  const row = PHEAD.map((h) => ({ payment_id: "X7", payer: "Mo", description: "Secret Inn", amount: 24750, currency: "JPY", split_between: "Mo", split_type: "equal", include_in_split: "yes" })[h] || "");
  const tabs = ["Payments", "Book Now", "Change Log"];
  const good = plannerWorld({ props: { PLANNER_ID }, tabs, get: byRange([PHEAD, row, [], row.map((c, i) => (i === 0 ? "X8" : c))]) });
  good.ctx.checkPlanner();
  assert.deepEqual(good.logged, ["Planner: 2 payment rows, columns ok", "Book Now: 2 items, columns ok", "Book Now: 0 Status cells are formulas (the app leaves those alone).", "Change Log: found"]);

  const missing = plannerWorld({ props: { PLANNER_ID }, tabs, get: byRange([PHEAD.filter((h) => h !== "amount_cad"), row], [["#", "Item", "Book by"]], [["#", "Tab"]]) });
  missing.ctx.checkPlanner();
  assert.deepEqual(missing.logged, ["Planner: The planner’s Payments tab is missing the column amount_cad.", "Book Now: The planner’s Book Now tab has no row with the columns #, Item, Book by and Status.", "Change Log: not found"]);

  const fails = plannerWorld({ props: { PLANNER_ID }, tabs, get: () => { throw new Error("Requested entity was not found: " + PLANNER_ID); } });
  fails.ctx.checkPlanner();
  assert.deepEqual(fails.logged, ["Planner: couldn’t read its Payments tab. Check the id and that this account can open the sheet.", "Book Now: couldn’t read it.", "Change Log: couldn’t read it."]);

  const noTab = plannerWorld({ props: { PLANNER_ID }, tabs: [], get: () => { throw new Error("Unable to parse range"); } });
  noTab.ctx.checkPlanner();
  assert.deepEqual(noTab.logged, ["Planner: The planner has no Payments tab to read.", "Book Now: The planner has no Book Now tab to read.", "Change Log: not found"]);

  const none = plannerWorld({ props: {}, get: () => { throw new Error("not called"); } });
  none.ctx.checkPlanner();
  assert.deepEqual(none.logged, ["Planner: not linked yet. Link it with linkPlanner first."]);

  const all = [good, missing, fails, noTab, none].flatMap((w) => w.logged).join("\n");
  assert.equal(all.includes(PLANNER_ID), false);
  assert.equal(/Secret Inn|24750|X7|Secret Tour|Hidden Inn|Private/.test(all), false);
});

test("checkPlanner asks for every permission first, the full Sheets one included (R46)", () => {
  const s = src("Setup.js");
  const body = s.slice(s.indexOf("function checkPlanner()"));
  assert.ok(body.indexOf("ScriptApp.requireAllScopes") < body.indexOf("plannerId_()"));
  const manifest = JSON.parse(src("appsscript.json"));
  assert.deepEqual(manifest.oauthScopes, [
    "https://www.googleapis.com/auth/spreadsheets.currentonly",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/spreadsheets",
  ]);
});

test("plannerTab_ reads a tab from A1 by its quoted name; null when the sheet has no such tab", () => {
  const w = plannerWorld({ props: { PLANNER_ID }, tabs: ["Book Now"], get: () => ({ values: BOOK }) });
  assert.deepEqual(JSON.parse(JSON.stringify(w.ctx.plannerTab_("Book Now"))), BOOK);
  assert.deepEqual(JSON.parse(JSON.stringify(w.asked)), [[PLANNER_ID, "'Book Now'!A1:Z", { valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" }]]);
  const odd = plannerWorld({ props: { PLANNER_ID }, get: () => ({}) });
  assert.deepEqual(JSON.parse(JSON.stringify(odd.ctx.plannerTab_("Mo's tab"))), []);
  assert.equal(odd.asked[0][1], "'Mo''s tab'!A1:Z");
  const none = plannerWorld({ props: { PLANNER_ID }, tabs: ["Payments"], get: () => { throw new Error("Unable to parse range"); } });
  assert.equal(none.ctx.plannerTab_("Change Log"), null);
  const shut = plannerWorld({ props: { PLANNER_ID }, tabs: ["Change Log"], get: () => { throw new Error("denied"); } });
  assert.throws(() => shut.ctx.plannerTab_("Change Log"), /denied/);
});

test("the two planner writers: one cell, RAW; one row appended under the table, RAW, rows inserted; Toronto time", () => {
  const w = plannerWorld({ props: { PLANNER_ID }, get: () => ({}) });
  w.ctx.plannerSetCell_("Book Now", "E4", "Booked");
  w.ctx.plannerAppendRow_("Change Log", 2, [8, "x", "", "y"]);
  assert.equal(w.ctx.torontoNow_(), "2026-11-20 10:00 ET");
  assert.deepEqual(JSON.parse(JSON.stringify(w.asked)), [
    ["update", { values: [["Booked"]] }, PLANNER_ID, "'Book Now'!E4", { valueInputOption: "RAW" }],
    ["append", { values: [[8, "x", "", "y"]] }, PLANNER_ID, "'Change Log'!A2:D2", { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" }],
    ["formatDate", "America/Toronto", "yyyy-MM-dd HH:mm"],
  ]);
  const refused = plannerWorld({ props: { PLANNER_ID }, get: () => ({}), update: () => { throw new Error("no permission"); } });
  assert.throws(() => refused.ctx.plannerSetCell_("Book Now", "E4", "Booked"), /no permission/);
});

test("withPlannerLock_ takes the document lock, never the script lock withLock_ uses; null when it can't be had (R49)", () => {
  const seen = [];
  const lock = (name, ok) => ({ tryLock: (ms) => { seen.push(name + ".tryLock:" + ms); return ok; }, releaseLock: () => seen.push(name + ".release") });
  const mk = (docOk, doc = true) => vm.createContext({
    LockService: {
      getScriptLock: () => { seen.push("script"); return lock("script", true); },
      getDocumentLock: () => (doc ? lock("doc", docOk) : null),
      getUserLock: () => lock("user", true),
    },
  });
  const w = mk(true);
  vm.runInContext(src("Env.js"), w, { filename: "Env.js" });
  assert.equal(w.withPlannerLock_(() => 5), 5);
  assert.deepEqual(seen, ["doc.tryLock:5000", "doc.release"]);
  seen.length = 0;
  const busy = mk(false);
  vm.runInContext(src("Env.js"), busy, { filename: "Env.js" });
  assert.equal(busy.withPlannerLock_(() => { throw new Error("not run"); }), null);
  assert.deepEqual(seen, ["doc.tryLock:5000"]);
  seen.length = 0;
  const unbound = mk(true, false);
  vm.runInContext(src("Env.js"), unbound, { filename: "Env.js" });
  assert.equal(unbound.withPlannerLock_(() => 1), 1);
  assert.deepEqual(seen, ["user.tryLock:5000", "user.release"]);
});

test("plannerCellFormula_ reads one cell as a formula: its text, or an empty string for a plain cell", () => {
  const seen = [];
  const w = plannerWorld({ props: { PLANNER_ID }, get: (id, range, opt) => { seen.push([range, opt]); return range.endsWith("E4") ? { values: [["=A1&B1"]] } : range.endsWith("E5") ? { values: [["Booked"]] } : {}; } });
  assert.equal(w.ctx.plannerCellFormula_("Book Now", 4, 4), "=A1&B1");
  assert.equal(w.ctx.plannerCellFormula_("Book Now", 5, 4), "");
  assert.equal(w.ctx.plannerCellFormula_("Book Now", 6, 4), "");
  assert.deepEqual(JSON.parse(JSON.stringify(seen[0])), ["'Book Now'!E4", { valueRenderOption: "FORMULA" }]);
});

test("checkPlanner counts the Status cells that are formulas, with no value in the line", () => {
  const tabs = ["Payments", "Book Now", "Change Log"];
  const mk = (formulas) => plannerWorld({ props: { PLANNER_ID }, tabs, get: (id, range, opt) => {
    if (opt && opt.valueRenderOption === "FORMULA") { const v = formulas[range.replace("'Book Now'!", "")]; return v ? { values: [[v]] } : {}; }
    return byRange([PHEAD])(id, range);
  } });
  const none = mk({});
  none.ctx.checkPlanner();
  assert.ok(none.logged.includes("Book Now: 0 Status cells are formulas (the app leaves those alone)."), none.logged.join("|"));
  const two = mk({ D3: "=1+1", D4: "=\"Booked\"" });
  two.ctx.checkPlanner();
  assert.ok(two.logged.includes("Book Now: 2 Status cells are formulas (the app leaves those alone)."), two.logged.join("|"));
  assert.equal(two.logged.join("\n").includes("=1+1"), false);
});
