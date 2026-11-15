const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../backend/Pure.js");
const NAMES = ["Mo", "Ajen", "Trenton"];
const good = { id: "a1b2c3d4e5", day: "2026-12-11", title: "Ramen", amount: 4200, currency: "JPY", paidBy: "Mo", split: NAMES };

test("cells that look like formulas are neutralised", () => {
  assert.equal(P.sanitizeCell("=1+1"), "'=1+1");
  assert.equal(P.sanitizeCell("+81 3"), "'+81 3");
  assert.equal(P.sanitizeCell("Ramen"), "Ramen");
  assert.equal(P.sanitizeCell(42), 42);
});

test("a good expense passes, yen is whole, and the defaults are filled", () => {
  const r = P.validateExpense({ ...good, amount: 4200.6 }, NAMES);
  assert.equal(r.ok, true);
  assert.equal(r.value.amount, 4201);
  assert.equal(r.value.splitMode, "equal");
  assert.deepEqual(r.value.splitVals, []);
  assert.equal(r.value.note, "");
  assert.equal(r.value.kind, "");
});

test("bad expenses are refused with a message", () => {
  for (const bad of [
    { title: "" }, { title: "x".repeat(81) }, { amount: 0 }, { amount: -5 }, { amount: 10000001 },
    { amount: NaN }, { currency: "USD" }, { paidBy: "Nobody" }, { split: [] }, { split: ["Mo", "Nobody"] },
    { split: ["Mo", "Mo"] }, { day: "tomorrow" }, { id: "short" }, { id: "has spaces in it" }, { id: "-abc12345" }, { id: "_abc12345" },
    { note: "x".repeat(201) }, { kind: "misc" }, { splitMode: "percent" },
    { splitMode: "parts", splitVals: [2, 3] }, { splitMode: "parts", splitVals: [2, 0, 3] },
    { splitMode: "parts", splitVals: [2, 1.5, 3] }, { splitMode: "parts", splitVals: [2, 100, 3] },
    { splitMode: "exact", splitVals: [2000, 1000, 1000] }, { splitMode: "exact", splitVals: [4200, 0, 0] },
  ]) {
    const r = P.validateExpense({ ...good, ...bad }, NAMES);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(typeof r.message, "string");
  }
  assert.equal(P.validateExpense({ ...good, day: "pre" }, NAMES).ok, true);
  assert.equal(P.validateExpense({ ...good, currency: "CAD", amount: 12.345 }, NAMES).value.amount, 12.35);
  assert.equal(P.validateExpense({ ...good, splitMode: "parts", splitVals: [2, 3, 3] }, NAMES).ok, true);
  assert.equal(P.validateExpense({ ...good, splitMode: "exact", splitVals: [2000, 1200, 1000] }, NAMES).ok, true);
  assert.equal(P.validateExpense({ ...good, currency: "CAD", amount: 100, splitMode: "exact", splitVals: [33.34, 33.33, 33.33] }, NAMES).ok, true);
  assert.equal(P.validateExpense({ ...good, kind: "food", note: "ref 8841" }, NAMES).value.kind, "food");
});

test("exact splits are rounded, each at least one unit, and must sum exactly", () => {
  const cad = { ...good, currency: "CAD", splitMode: "exact" };
  assert.equal(P.validateExpense({ ...cad, amount: 0.01, splitVals: [0.004, 0.004, 0.01] }, NAMES).ok, false);
  assert.equal(P.validateExpense({ ...cad, amount: 100, splitVals: [33.334, 33.333, 33.333] }, NAMES).ok, false);
  const r = P.validateExpense({ ...cad, amount: 100, splitVals: [33.334, 33.336, 33.33] }, NAMES);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.splitVals, [33.33, 33.34, 33.33]);
  const y = P.validateExpense({ ...good, amount: 100, splitMode: "exact", splitVals: [50.4, 49.6, 0.4] }, NAMES);
  assert.equal(y.ok, false);
  const y2 = P.validateExpense({ ...good, amount: 100, splitMode: "exact", splitVals: [50.4, 49.6, 0.6] }, NAMES);
  assert.equal(y2.ok, false);
  const y3 = P.validateExpense({ ...good, amount: 100, splitMode: "exact", splitVals: [50.4, 48.6, 1.2] }, NAMES);
  assert.equal(y3.ok, true);
  assert.deepEqual(y3.value.splitVals, [50, 49, 1]);
});

test("a day must be a real calendar date", () => {
  for (const day of ["2026-13-45", "2026-02-30", "2026-00-10", "2026-04-31", "2026-12-00", "2027-02-29"]) {
    assert.equal(P.validateExpense({ ...good, day }, NAMES).ok, false, day);
  }
  for (const day of ["2026-12-31", "2028-02-29", "pre"]) {
    assert.equal(P.validateExpense({ ...good, day }, NAMES).ok, true, day);
  }
});

test("an expense value carries exactly the client-settable fields, trimmed", () => {
  const r = P.validateExpense({ ...good, title: "  Ramen ", note: " n ", rate: 99, addedBy: "Ajen", addedAt: "t", deleted: true }, NAMES);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.value).sort(), ["amount", "currency", "day", "id", "kind", "note", "paidBy", "split", "splitMode", "splitVals", "title"]);
  assert.equal(r.value.title, "Ramen");
  assert.equal(r.value.note, "n");
});

test("odd input is refused with a message, never thrown", () => {
  for (const bad of [null, undefined, "text", 5, [], { ...good, split: "Mo" }, { ...good, title: 5 }, { ...good, paidBy: ["Mo"] }, { ...good, amount: "4200" }, { ...good, note: 7 }]) {
    let r;
    assert.doesNotThrow(() => { r = P.validateExpense(bad, NAMES); }, JSON.stringify(bad));
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(typeof r.message, "string");
    assert.ok(r.message.length > 0);
  }
});

test("payments need two different known people and a sane amount", () => {
  const pay = { id: "p1p2p3p4p5", from: "Ajen", to: "Mo", cad: 250.304, seed: 7, rot: -4.2 };
  assert.equal(P.validatePayment(pay, NAMES).value.cad, 250.3);
  assert.equal(P.validatePayment({ ...pay, to: "Ajen" }, NAMES).ok, false);
  assert.equal(P.validatePayment({ ...pay, cad: 0 }, NAMES).ok, false);
  assert.equal(P.validatePayment({ ...pay, cad: 100001 }, NAMES).ok, false);
});

test("a payment carries seed and rot, and refuses missing or odd ones", () => {
  const pay = { id: "p1p2p3p4p5", from: "Ajen", to: "Mo", cad: 250.304, seed: 7, rot: -4.2 };
  assert.deepEqual(P.validatePayment(pay, NAMES).value, { id: "p1p2p3p4p5", from: "Ajen", to: "Mo", cad: 250.3, seed: 7, rot: -4.2 });
  const { seed, ...noSeed } = pay;
  const { rot, ...noRot } = pay;
  for (const bad of [noSeed, noRot, { ...pay, seed: 0 }, { ...pay, seed: 1.5 }, { ...pay, seed: "7" }, { ...pay, rot: NaN }, { ...pay, rot: Infinity }, { ...pay, rot: "1" }, null, "x", { ...pay, id: "short" }, { ...pay, id: "-abc12345" }, { ...pay, id: "_abc12345" }, { ...pay, from: "Nobody" }]) {
    const r = P.validatePayment(bad, NAMES);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(typeof r.message, "string");
  }
  assert.equal(P.validatePayment({ ...pay, seed: 1, rot: 0 }, NAMES).ok, true);
});

test("a person can change only their e-Transfer address and Simplify", () => {
  assert.deepEqual(P.validatePersonPatch({ etransfer: "  mo@example.com ", simplify: false }).value, { etransfer: "mo@example.com", simplify: false });
  assert.equal(P.validatePersonPatch({ etransfer: "x".repeat(81) }).ok, false);
  assert.equal(P.validatePersonPatch({ simplify: "no" }).ok, false);
  assert.equal(P.validatePersonPatch({ initials: "XX" }).ok, false);
  assert.equal(P.validatePersonPatch({}).ok, false);
});

test("rows round-trip between sheet and API shapes", () => {
  const h = P.TABS.Expenses;
  const row = P.objToRow(h, { id: "x", title: "=evil", split: "Mo,Ajen", deleted_at: "" });
  assert.equal(row[h.indexOf("title")], "'=evil");
  const e = P.expenseFromRow({ id: "x", day: "pre", title: "T", amount: 80, currency: "CAD", rate: 111, paid_by: "Mo", split: "Mo,Ajen", split_mode: "parts", split_vals: "1,3", note: "n", kind: "food", added_by: "Mo", added_at: "t", deleted_at: "" });
  assert.deepEqual(e.split, ["Mo", "Ajen"]);
  assert.deepEqual(e.splitVals, [1, 3]);
  assert.equal(e.paidBy, "Mo");
  assert.equal(e.deleted, false);
  assert.equal(P.expenseFromRow({ id: "y", split: "Mo", split_mode: "", split_vals: "" }).splitMode, "equal");
  const who = P.personFromRow({ name: "Mo", initials: "MO", order: 1, etransfer: "mo@example.com", simplify: false, email: "private@example.com" });
  assert.deepEqual(who, { name: "Mo", initials: "MO", etransfer: "mo@example.com", simplify: false });
  assert.equal(P.personFromRow({ name: "Ajen", initials: "AJ", simplify: "" }).simplify, true);
});

test("rows coped with as Sheets really hands them back", () => {
  const e = P.expenseFromRow({ id: "x", day: new Date(Date.UTC(2026, 11, 11, 12)), title: "T", amount: "80.5", currency: "CAD", rate: "111", paid_by: "Mo", split: "Mo", split_mode: "parts", split_vals: 3, note: "", kind: "", added_by: "Mo", added_at: new Date(Date.UTC(2026, 11, 11, 3, 4, 5)), deleted_at: new Date(Date.UTC(2026, 11, 12)) });
  assert.deepEqual(e.splitVals, [3]);
  assert.equal(e.amount, 80.5);
  assert.equal(e.rate, 111);
  assert.equal(e.day, "2026-12-11");
  assert.equal(e.addedAt, "2026-12-11T03:04:05.000Z");
  assert.equal(e.deleted, true);
  assert.equal(P.personFromRow({ name: "A", simplify: "FALSE" }).simplify, false);
  assert.equal(P.personFromRow({ name: "A", simplify: "TRUE" }).simplify, true);
  assert.equal(P.personFromRow({ name: "A", simplify: true }).simplify, true);
  const p = P.paymentFromRow({ id: "p", from: "Ajen", to: "Mo", cad: "250.3", stamped_by: "Ajen", stamped_at: new Date(Date.UTC(2026, 11, 13)), seed: "7", rot: "-4.2", removed_at: "" });
  assert.deepEqual(p, { id: "p", from: "Ajen", to: "Mo", cad: 250.3, stampedBy: "Ajen", stampedAt: "2026-12-13T00:00:00.000Z", seed: 7, rot: -4.2, removed: false });
  assert.equal(P.paymentFromRow({ id: "q", removed_at: "2026-12-14T00:00:00.000Z" }).removed, true);
});

test("expense and payment rows round-trip from the API shape", () => {
  const x = { id: "a1b2c3d4e5", day: "2026-12-11", title: "Taxi", amount: 3600, currency: "JPY", rate: 111, paidBy: "Ajen", split: ["Ajen", "Trenton"], splitMode: "parts", splitVals: [1, 2], note: "late", kind: "transport", addedBy: "Ajen", addedAt: "2026-12-11T01:00:00.000Z", deleted: true };
  const row = P.expenseToRow(x);
  assert.equal(row.paid_by, "Ajen");
  assert.equal(row.split, "Ajen,Trenton");
  assert.equal(row.split_vals, "1,2");
  for (const k of ["added_at", "deleted_at", "deleted", "paidBy"]) assert.equal(k in row, false, k);
  const back = P.expenseFromRow(row);
  for (const k of Object.keys(x)) if (k !== "addedAt" && k !== "deleted") assert.deepEqual(back[k], x[k], k);
  assert.equal(P.expenseToRow({ ...x, splitMode: "equal", splitVals: [] }).split_vals, "");
  assert.deepEqual(P.expenseFromRow(P.expenseToRow({ ...x, currency: "CAD", amount: 100, splitMode: "exact", splitVals: [33.34, 66.66] })).splitVals, [33.34, 66.66]);
  const noExtras = P.expenseToRow({ id: "a1b2c3d4e5", day: "pre", title: "T", amount: 1, currency: "JPY", paidBy: "Mo", split: ["Mo"], splitMode: "equal", splitVals: [], note: "", kind: "" });
  assert.equal("rate" in noExtras, false);
  assert.equal("added_by" in noExtras, false);

  const pay = { id: "p1p2p3p4p5", from: "Ajen", to: "Mo", cad: 250.3, stampedBy: "Ajen", stampedAt: "2026-12-13T00:00:00.000Z", seed: 7, rot: -4.2, removed: true };
  const prow = P.paymentToRow(pay);
  assert.equal(prow.stamped_by, "Ajen");
  for (const k of ["stamped_at", "removed_at", "removed"]) assert.equal(k in prow, false, k);
  const pback = P.paymentFromRow(prow);
  for (const k of Object.keys(pay)) if (k !== "stampedAt" && k !== "removed") assert.deepEqual(pback[k], pay[k], k);
});

test("the setup seed rows are the trip, three people and one day per date", () => {
  const s = P.setupSeedRows();
  assert.deepEqual(s.Trip.map((r) => r.key), ["name", "start", "end", "home", "currency", "tz"]);
  assert.deepEqual(s.People.map((r) => [r.name, r.initials, r.order, r.simplify]), [["Mo", "MO", 1, true], ["Ajen", "AJ", 2, true], ["Trenton", "TR", 3, true]]);
  assert.equal(s.Days.length, 11);
  assert.equal(s.Days[0].date, "2026-12-10");
  assert.equal(s.Days[10].date, "2026-12-20");
  assert.notEqual(P.setupSeedRows().People[0], s.People[0]);
});

test("every column is plain text except the numbers and the on/off flags", () => {
  const numbers = { Expenses: ["amount", "rate"], Settlements: ["cad", "seed", "rot"], People: ["order"], Stops: ["travel_min"], Log: ["id", "undoes", "undone_by"] };
  const flags = { People: ["simplify"], Stops: ["fixed", "booked"] };
  for (const [tab, headers] of Object.entries(P.TABS)) {
    for (const h of headers) {
      const notText = (numbers[tab] || []).includes(h) || (flags[tab] || []).includes(h);
      assert.equal(P.isTextColumn(tab, h), !notText, tab + "." + h);
    }
  }
  assert.equal(P.isTextColumn("Expenses", "id"), true);
  assert.equal(P.isTextColumn("Settlements", "id"), true);
  assert.equal(P.isTextColumn("Expenses", "split_vals"), true);
  assert.equal(P.isTextColumn("Expenses", "title"), true);
});

test("rows read back from text columns still give numbers where the API wants them", () => {
  const e = P.expenseFromRow({ id: "x", day: "2026-12-11", title: "0012", amount: 4200, currency: "JPY", rate: 111, paid_by: "Mo", split: "Mo,Ajen", split_mode: "parts", split_vals: "1,3", note: "3-4", kind: "", added_by: "Mo", added_at: "t", deleted_at: "" });
  assert.deepEqual(e.splitVals, [1, 3]);
  assert.equal(P.expenseFromRow({ id: "x", split: "Mo", split_mode: "parts", split_vals: "3" }).splitVals[0], 3);
  assert.equal(e.title, "0012");
  assert.equal(e.note, "3-4");
  assert.equal(P.parseLogRow({ id: 7, undoes: 3, undone_by: "" }).undoes, 3);
});

test("unsanitizeCell drops only the escape apostrophe that sanitizeCell adds", () => {
  for (const typed of ["=probe", "-5% off", "+81 3", "@home", "\tx", "\rx"]) {
    assert.equal(P.unsanitizeCell(P.sanitizeCell(typed)), typed, JSON.stringify(typed));
    assert.equal(P.unsanitizeCell(typed), typed);
  }
  for (const v of ["'hello", "''", "'", "it's", "Ramen", "", 42, true, null]) assert.equal(P.unsanitizeCell(v), v, JSON.stringify(v));
  assert.equal(P.unsanitizeCell("''=x"), "''=x");
});

test("rowToObj reads escaped cells back as typed", () => {
  const h = ["id", "title", "note", "amount"];
  assert.deepEqual(P.rowToObj(h, ["a1", "'=probe", "'-probe", 5]), { id: "a1", title: "=probe", note: "-probe", amount: 5 });
  assert.deepEqual(P.rowToObj(h, P.objToRow(h, { id: "a1", title: "@home", note: "+81 3", amount: 5 })), { id: "a1", title: "@home", note: "+81 3", amount: 5 });
  assert.equal(P.rowToObj(h, ["a1", "'plain"]).title, "'plain");
});

test("the rate is fetched only when today's is missing and no failure in the last hour", () => {
  const now = "2026-12-10T12:00:00.000Z";
  assert.equal(P.shouldFetchRate(null, null, now), true);
  assert.equal(P.shouldFetchRate("", "", now), true);
  assert.equal(P.shouldFetchRate("108.4", null, now), false);
  assert.equal(P.shouldFetchRate("108.4", "2026-12-10T11:59:00.000Z", now), false);
  assert.equal(P.shouldFetchRate(null, "2026-12-10T11:30:00.000Z", now), false);
  assert.equal(P.shouldFetchRate(null, "2026-12-10T11:00:00.001Z", now), false);
  assert.equal(P.shouldFetchRate(null, "2026-12-10T11:00:00.000Z", now), true);
  assert.equal(P.shouldFetchRate(null, "2026-12-09T12:00:00.000Z", now), true);
  assert.equal(P.shouldFetchRate("0", null, now), true);
  assert.equal(P.shouldFetchRate("junk", null, now), true);
  assert.equal(P.shouldFetchRate(null, "junk", now), true);
  assert.equal(P.shouldFetchRate(null, "2026-12-10T13:00:00.000Z", now), true);
});

test("rateSource: today's stored rate is live, an earlier day's is last, none is the stand-in (F7)", () => {
  assert.equal(P.rateSource("108.4", "108.4"), "live");
  assert.equal(P.rateSource(null, "107.9"), "last");
  assert.equal(P.rateSource("", "107.9"), "last");
  assert.equal(P.rateSource(null, null), "fallback");
  assert.equal(P.rateSource("junk", "0"), "fallback");
});

test("sameKey compares whole keys and is false for any difference (F12)", () => {
  assert.equal(P.sameKey("abc123", "abc123"), true);
  assert.equal(P.sameKey("abc123", "abc124"), false);
  assert.equal(P.sameKey("abc123", "abc12"), false);
  assert.equal(P.sameKey("abc12", "abc123"), false);
  assert.equal(P.sameKey("", ""), false, "an empty key never matches");
  assert.equal(P.sameKey(null, "abc"), false);
  assert.equal(P.sameKey("abc", undefined), false);
});

test("every message the backend can show uses the curly apostrophe (R20, F10)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "..", "backend");
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const lit of src.match(/"(?:[^"\\\n]|\\.)*"/g) || []) {
      assert.equal(/[A-Za-z]'[A-Za-z]/.test(lit), false, f + ": " + lit);
    }
  }
});
