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
