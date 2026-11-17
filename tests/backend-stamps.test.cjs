/* Copyright (c) 2026 moissmart1. All rights reserved. No licence is granted: do not copy, adapt or reuse this code or design, and do not use it to train or prompt an AI system to reproduce it. See LICENSE. */
// The stamp book on the backend: definitions, presses, the window rule, undo,
// and an older Sheet with no stamp tabs. Through the fake backend (the real
// Actions.js, Pure.js and Mcp.js). Every definition here is invented.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const P = require("../backend/Pure.js");
const { createFakeBackend } = require("./fake-backend.cjs");

const KEY = "test-key";
const DEFS = [
  { id: "d1", date: "2030-01-05", name_ja: "試験", name_en: "Testville", place: "Test Hall", motif: "lantern", ink: "shu", shape: "round" },
  { id: "d2", date: "2030-01-06", name_ja: "二", name_en: "Second", place: "Second Place", motif: "tower", ink: "ai", shape: "square" },
  { id: "iss", date: "", name_ja: "発行", name_en: "Issued", place: "", motif: "crest", ink: "shu", shape: "round" },
];
// Jan 5 in Japan is 15:00 UTC on Jan 4 to 18:00 UTC on Jan 5.
const IN_D1 = "2030-01-05T01:00:00.000Z";

function book({ over = {}, defs = DEFS, now = IN_D1 } = {}) {
  const at = { now };
  const fake = createFakeBackend(over, { clock: () => at.now });
  for (const d of defs) fake.tables.StampDefs.push({ ...d });
  const call = (action, args = {}, actor = "Mo", extra = {}) => fake({ key: KEY, actor, action, args, ...extra });
  call.fake = fake;
  call.at = at;
  return call;
}
const iso = (ms) => new Date(ms).toISOString();
const rows = (call) => call.fake.tables.Stamps;
const lines = (call) => call.fake.tables.Log.filter((r) => r.kind === "stamp");

test("a press inside the window writes one row and one History line", async () => {
  const call = book();
  const r = await call("pressStamp", { def: "d1", at: IN_D1 });
  assert.equal(r.ok, true);
  assert.deepEqual([r.data.stamp.def, r.data.stamp.who, r.data.stamp.at], ["d1", "Mo", IN_D1]);
  assert.ok(Number.isInteger(r.data.stamp.seed) && r.data.stamp.seed >= 1 && r.data.stamp.seed <= 4294967295);
  assert.equal(rows(call).length, 1);
  assert.equal(rows(call)[0].id, "d1|Mo");
  const h = (await call("history")).data.entries;
  assert.deepEqual(h.map((e) => e.who + " " + e.summary), ["Mo stamped Jan 5"]);
  assert.equal(h[0].canUndo, true);
});

test("the issue stamp's line reads: stamped the book", async () => {
  const call = book();
  assert.equal((await call("pressStamp", { def: "iss", at: IN_D1 }, "Ajen")).ok, true);
  assert.equal(lines(call)[0].summary, "stamped the book");
});

test("a seed the phone sends is kept, so the ink does not change when the answer comes; an odd one is replaced", async () => {
  const call = book();
  assert.equal((await call("pressStamp", { def: "d1", at: IN_D1, seed: 123456 })).data.stamp.seed, 123456);
  const other = (await call("pressStamp", { def: "d1", at: IN_D1, seed: 0 }, "Ajen")).data.stamp.seed;
  assert.ok(other >= 1 && other <= 4294967295);
  const frac = (await call("pressStamp", { def: "d1", at: IN_D1, seed: 1.5 }, "Trenton")).data.stamp.seed;
  assert.ok(Number.isInteger(frac));
});

test("the same press twice is one row and one History line, and the second answers the first", async () => {
  const call = book();
  const a = await call("pressStamp", { def: "d1", at: IN_D1 });
  const b = await call("pressStamp", { def: "d1", at: IN_D1 });
  assert.deepEqual(b.data.stamp, a.data.stamp);
  assert.equal(rows(call).length, 1);
  assert.equal(lines(call).length, 1);
  // a resend that arrives after the window closed still answers the first
  call.at.now = "2030-01-07T00:00:00.000Z";
  assert.deepEqual((await call("pressStamp", { def: "d1", at: IN_D1 })).data.stamp, a.data.stamp);
  assert.equal(lines(call).length, 1);
  // a different `at` the same day is still the one stamp
  assert.deepEqual((await call("pressStamp", { def: "d1", at: "2030-01-05T05:00:00.000Z" })).data.stamp, a.data.stamp);
  assert.equal(rows(call).length, 1);
});

test("two people stamping the same day are two rows", async () => {
  const call = book();
  await call("pressStamp", { def: "d1", at: IN_D1 }, "Mo");
  await call("pressStamp", { def: "d1", at: IN_D1 }, "Ajen");
  assert.deepEqual(rows(call).map((r) => r.id).sort(), ["d1|Ajen", "d1|Mo"]);
});

test("pressed offline, arriving 30 hours later (window closed): accepted, stored with the time it was pressed", async () => {
  const call = book({ now: "2030-01-06T07:00:00.000Z" }); // 30 hours after IN_D1
  const r = await call("pressStamp", { def: "d1", at: IN_D1 });
  assert.equal(r.ok, true);
  assert.equal(r.data.stamp.at, IN_D1);
  assert.equal(rows(call)[0].at, IN_D1);
  assert.equal(lines(call).length, 1);
});

test("not_open, closed, late, future and no_such_stamp are refused with no write", async () => {
  const cases = [
    ["not_open", { def: "d2", at: IN_D1 }, IN_D1],
    ["closed", { def: "d1", at: "2030-01-05T18:00:00.000Z" }, "2030-01-05T18:00:00.000Z"],
    ["late", { def: "d1", at: IN_D1 }, "2030-01-07T01:00:01.000Z"],
    ["future", { def: "d1", at: "2030-01-05T01:06:00.000Z" }, IN_D1],
    ["no_such_stamp", { def: "nope", at: IN_D1 }, IN_D1],
  ];
  for (const [code, args, now] of cases) {
    const call = book({ now });
    const r = await call("pressStamp", args);
    assert.deepEqual([r.ok, r.error], [false, code], code);
    assert.ok(r.message.length > 5);
    assert.equal(rows(call).length, 0, code);
    assert.equal(lines(call).length, 0, code);
    assert.equal(call.fake.props.REV, "0", code + ": the rev did not move");
  }
});

test("a press with no usable time is refused as a bad request", async () => {
  const call = book();
  for (const at of [undefined, "", "yesterday", 123, "2030-01-05", "2030-13-45T00:00:00Z"]) {
    const r = await call("pressStamp", { def: "d1", at });
    assert.deepEqual([r.ok, r.error], [false, "bad_input"], String(at));
  }
  assert.equal(rows(call).length, 0);
});

test("through the connector a press is refused with exactly: Press this one in the app.", async () => {
  const call = book();
  const r = await call("pressStamp", { def: "d1", at: IN_D1 }, "Mo", { via: "claude" });
  assert.deepEqual([r.ok, r.message], [false, "Press this one in the app."]);
  assert.equal(rows(call).length, 0);
  assert.equal(lines(call).length, 0);
});

test("the connector keeps exactly 12 tools and none of them presses", () => {
  const call = book();
  const tools = call.fake.mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { t: "claude-token" }).result.tools;
  assert.equal(tools.length, 12);
  assert.equal(tools.some((t) => /stamp/i.test(t.name)), false);
});

test("undo lifts the press: load no longer lists it; pressing again inside the window clears gone with a new time and seed", async () => {
  const call = book();
  const first = (await call("pressStamp", { def: "d1", at: IN_D1 })).data;
  const undone = await call("undo", { logId: first.logId });
  assert.equal(undone.ok, true);
  assert.equal(undone.data.stamp.gone, true);
  assert.equal(rows(call)[0].gone, "yes");
  assert.deepEqual((await call("load")).data.stamps, []);
  assert.equal((await call("history")).data.entries[0].summary, "undid: stamped Jan 5");

  call.at.now = "2030-01-05T03:00:00.000Z";
  const again = await call("pressStamp", { def: "d1", at: "2030-01-05T03:00:00.000Z" });
  assert.equal(again.ok, true);
  assert.equal(again.data.stamp.at, "2030-01-05T03:00:00.000Z");
  assert.notEqual(again.data.stamp.seed, first.stamp.seed);
  assert.equal(rows(call).length, 1);
  assert.equal(rows(call)[0].gone, "");
  assert.equal((await call("load")).data.stamps.length, 1);
  // the new press is a new line, which can be undone itself
  assert.equal(lines(call).filter((r) => r.action === "press").length, 2);
});

test("a lifted stamp's old press, resent, is not a new press", async () => {
  const call = book();
  const first = (await call("pressStamp", { def: "d1", at: IN_D1 })).data;
  await call("undo", { logId: first.logId });
  const resent = await call("pressStamp", { def: "d1", at: IN_D1 });
  assert.equal(resent.ok, false);
  assert.equal(rows(call)[0].gone, "yes");
});

test("after the window, a lifted stamp cannot be pressed again, and undoing the lift is refused too", async () => {
  const call = book();
  const first = (await call("pressStamp", { def: "d1", at: IN_D1 })).data;
  call.at.now = "2030-01-05T18:30:00.000Z"; // closed
  const lift = await call("undo", { logId: first.logId });
  assert.equal(lift.ok, true, "lifting is always allowed");
  const again = await call("pressStamp", { def: "d1", at: "2030-01-05T18:20:00.000Z" });
  assert.deepEqual([again.ok, again.error], [false, "closed"]);
  const put = await call("undo", { logId: lift.data.logId });
  assert.deepEqual([put.ok, put.error], [false, "closed"]);
  assert.equal(rows(call)[0].gone, "yes");
  assert.deepEqual((await call("load")).data.stamps, []);
});

test("undoing a lift inside the window puts the stamp back as it was; Claude cannot", async () => {
  const call = book();
  const first = (await call("pressStamp", { def: "d1", at: IN_D1, seed: 777 })).data;
  const lift = await call("undo", { logId: first.logId });
  const viaClaude = await call("undo", { logId: lift.data.logId }, "Mo", { via: "claude" });
  assert.deepEqual([viaClaude.ok, viaClaude.message], [false, "Press this one in the app."]);
  const back = await call("undo", { logId: lift.data.logId });
  assert.equal(back.ok, true);
  assert.deepEqual([back.data.stamp.at, back.data.stamp.seed, back.data.stamp.gone], [IN_D1, 777, undefined]);
  assert.equal((await call("load")).data.stamps.length, 1);
});

test("Claude can lift a stamp through undo (lifting is not pressing)", async () => {
  const call = book();
  const first = (await call("pressStamp", { def: "d1", at: IN_D1 })).data;
  const r = await call("undo", { logId: first.logId }, "Mo", { via: "claude" });
  assert.equal(r.ok, true);
});

test("History: another person's press is not blocked by mine; only the latest line per stamp can be undone", async () => {
  const call = book();
  const a = (await call("pressStamp", { def: "d1", at: IN_D1 }, "Mo")).data;
  const b = (await call("pressStamp", { def: "d1", at: IN_D1 }, "Ajen")).data;
  const h = (await call("history")).data.entries;
  assert.deepEqual(h.map((e) => e.canUndo), [true, true]);
  assert.equal((await call("undo", { logId: a.logId })).ok, true);
  assert.equal((await call("undo", { logId: b.logId })).ok, true);
});

test("load lists the definitions in full and everyone's stamps without the lifted ones", async () => {
  const call = book();
  await call("pressStamp", { def: "d1", at: IN_D1 }, "Mo");
  const ajen = (await call("pressStamp", { def: "d1", at: IN_D1 }, "Ajen")).data;
  await call("undo", { logId: ajen.logId });
  const d = (await call("load")).data;
  assert.deepEqual(d.stampDefs, DEFS);
  assert.deepEqual(d.stamps.map((s) => [s.def, s.who]), [["d1", "Mo"]]);
  assert.deepEqual(Object.keys(d.stamps[0]).sort(), ["at", "def", "seed", "who"]);
});

test("load on a sheet without the two tabs answers empty lists, and a press is told to migrate", async () => {
  const call = book({ over: { missingTabs: ["StampDefs", "Stamps"] }, defs: [] });
  const d = (await call("load")).data;
  assert.deepEqual([d.stampDefs, d.stamps], [[], []]);
  assert.equal(d.people.length, 3, "everything else still loads");
  const r = await call("pressStamp", { def: "d1", at: IN_D1 });
  assert.deepEqual([r.ok, r.error], [false, "needs_migrate"]);
  // then migrate adds them
  const m = await call("migrate");
  assert.deepEqual(m.data.added.filter((x) => /^Stamp/.test(x)).length, 14);
  assert.deepEqual((await call("load")).data.stampDefs, []);
});

test("a definition with a date that is not a day, or an empty id, never opens or shows", async () => {
  const call = book({ defs: [...DEFS, { id: "bad", date: "someday", name_en: "x" }, { id: "", date: "2030-01-05" }] });
  const d = (await call("load")).data;
  assert.deepEqual(d.stampDefs.map((x) => x.id), ["d1", "d2", "iss", "bad"]);
  const r = await call("pressStamp", { def: "bad", at: IN_D1 });
  assert.deepEqual([r.ok, r.error], [false, "not_open"]);
});

// ---------- migrate, against the real Sheets.js and a small pretend Spreadsheet ----------

function pretendSpreadsheet(tabs) {
  const sheets = new Map();
  const make = (name, grid) => {
    const sh = { name, grid, frozen: 0, bold: new Set(), formats: new Map(), maxCols: Math.max(26, (grid[0] || []).length), maxRows: 1000 };
    sh.getLastColumn = () => grid.reduce((n, r) => Math.max(n, r.length), 0);
    sh.getMaxColumns = () => sh.maxCols;
    sh.getMaxRows = () => sh.maxRows;
    sh.insertColumnsAfter = (_c, n) => { sh.maxCols += n; };
    sh.setFrozenRows = (n) => { sh.frozen = n; };
    sh.getRange = (r, c, nr = 1, nc = 1) => ({
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (grid[r - 1 + i] && grid[r - 1 + i][c - 1 + j] !== undefined ? grid[r - 1 + i][c - 1 + j] : ""))),
      setValue(v) { while (grid.length < r) grid.push([]); grid[r - 1][c - 1] = v; return this; },
      setFontWeight() { sh.bold.add(r + "," + c); return this; },
      setNumberFormat(f) { sh.formats.set(c, f); return this; },
    });
    sheets.set(name, sh);
    return sh;
  };
  for (const [name, grid] of Object.entries(tabs)) make(name, grid);
  return {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => make(n, []),
    sheets,
  };
}

test("migrate (the real ensureColumns_) adds both tabs with their headers, twice in a row without change, and leaves every other cell alone", () => {
  const old = {};
  for (const [tab, headers] of Object.entries(P.TABS)) if (!/^Stamp/.test(tab)) old[tab] = [headers.slice(), headers.map((h, i) => tab + h + i)];
  const before = JSON.stringify(old);
  const ss = pretendSpreadsheet(old);
  const ctx = vm.createContext({ SpreadsheetApp: { getActiveSpreadsheet: () => ss } });
  const run = (f) => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "backend", f), "utf8"), ctx, { filename: f });
  run("Pure.js");
  run("Sheets.js");
  const added = ctx.ensureColumns_();
  assert.deepEqual(Array.from(added), [...P.TABS.StampDefs.map((h) => "StampDefs." + h), ...P.TABS.Stamps.map((h) => "Stamps." + h)]);
  assert.deepEqual(ss.sheets.get("StampDefs").grid[0], P.TABS.StampDefs);
  assert.deepEqual(ss.sheets.get("Stamps").grid[0], P.TABS.Stamps);
  assert.equal(ss.sheets.get("Stamps").frozen, 1);
  // the seed column is a number, the rest text
  assert.equal(ss.sheets.get("Stamps").formats.get(P.TABS.Stamps.indexOf("seed") + 1), undefined);
  assert.equal(ss.sheets.get("Stamps").formats.get(1), "@");
  assert.deepEqual(Array.from(ctx.ensureColumns_()), [], "the second run adds nothing");
  const after = {};
  for (const name of Object.keys(old)) after[name] = ss.sheets.get(name).grid;
  assert.equal(JSON.stringify(after), before, "no other tab's cells changed");
});
