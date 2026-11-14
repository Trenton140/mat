const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { createFakeBackend } = require("./fake-backend.cjs");
const { TABS } = require("../backend/Pure.js");

const KEY = "test-key";
const ALL = ["Mo", "Ajen", "Trenton"];
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "seed.json"), "utf8"));

// A caller bound to one fake: call(action, args, extra) sends { key, actor: "Mo", action, args, ...extra }.
function client(seed, opts) {
  const fake = createFakeBackend(seed, opts);
  const call = (action, args = {}, extra = {}) => fake({ key: KEY, actor: "Mo", action, args, ...extra });
  call.fake = fake;
  return call;
}

function ramen(over = {}) {
  return { id: "exp0000001", day: "2026-12-10", title: "Ramen", amount: 4200, currency: "JPY", paidBy: "Mo", split: ALL.slice(), ...over };
}

function stampOf(over = {}) {
  return { id: "pay0000001", from: "Ajen", to: "Mo", cad: 25, seed: 3, rot: -2.5, ...over };
}

async function historyAll(call, args = {}) {
  const r = await call("history", args);
  assert.equal(r.ok, true);
  return r.data.entries;
}

// ---------- the brief's contract tests ----------

test("load returns the trip, three people with Simplify on and no email, no expenses, the rate and eleven days", async () => {
  const call = client();
  const r = await call("load");
  assert.equal(r.ok, true);
  assert.equal(r.rev, 0);
  const d = r.data;
  assert.deepEqual(d.trip, { name: "Japan 2026", start: "2026-12-10", end: "2026-12-20", home: "CAD", currency: "JPY", tz: "Asia/Tokyo" });
  assert.equal(d.people.length, 3);
  assert.deepEqual(d.people.map((p) => p.name), ALL);
  for (const p of d.people) {
    assert.equal(p.simplify, true);
    assert.equal("email" in p, false);
  }
  assert.deepEqual(d.expenses, []);
  assert.deepEqual(d.payments, []);
  assert.deepEqual(d.stops, []);
  assert.deepEqual(d.stays, []);
  assert.equal(d.rateToday, 111);
  assert.equal(d.sheetUrl, "https://example.test/sheet");
  assert.equal(d.days.length, 11);
  assert.equal(d.days[0].date, "2026-12-10");
  assert.equal(d.days[10].date, "2026-12-20");
});

test("a wrong or missing key is refused with bad_key and no data", async () => {
  const fake = createFakeBackend();
  const bodies = [
    { key: "nope", actor: "Mo", action: "load", args: {} },
    { actor: "Mo", action: "load", args: {} },
    { key: "", actor: "Mo", action: "rev", args: {} },
    { key: "nope", actor: "Mo", action: "addExpense", args: { expense: ramen() } },
    { key: null, actor: "Mo", action: "history", args: {} },
  ];
  for (const body of bodies) {
    const r = await fake(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.error, "bad_key");
    assert.equal("data" in r, false);
    assert.equal(typeof r.message, "string");
  }
  assert.equal(fake.tables.Expenses.length, 0);
  assert.equal(fake.tables.Log.length, 0);
});

test("addExpense stamps the rate and the actor, is live, gets a numeric logId and bumps rev by one", async () => {
  const call = client(undefined, { clock: () => "2026-12-10T05:00:00.000Z" });
  const before = (await call("rev")).rev;
  const r = await call("addExpense", { expense: ramen() }, { actor: "Ajen" });
  assert.equal(r.ok, true);
  const e = r.data.expense;
  assert.equal(e.rate, 111);
  assert.equal(e.addedBy, "Ajen");
  assert.equal(e.addedAt, "2026-12-10T05:00:00.000Z");
  assert.equal(e.deleted, false);
  assert.equal(e.title, "Ramen");
  assert.equal(e.amount, 4200);
  assert.equal(e.paidBy, "Mo");
  assert.equal(typeof r.data.logId, "number");
  assert.equal(r.rev, before + 1);
});

test("addExpense twice with the same id records it once and answers the same both times", async () => {
  const call = client();
  const a = await call("addExpense", { expense: ramen() });
  const b = await call("addExpense", { expense: ramen() });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(b.data.expense, a.data.expense);
  assert.equal(b.data.logId, a.data.logId);
  assert.equal(a.rev, 1);
  assert.equal(b.rev, 1);
  assert.equal((await call("load")).data.expenses.length, 1);
  assert.equal((await historyAll(call)).length, 1);
});

test("addExpense with a zero amount is bad_input and changes nothing", async () => {
  const call = client();
  const r = await call("addExpense", { expense: ramen({ amount: 0 }) });
  assert.equal(r.ok, false);
  assert.equal(r.error, "bad_input");
  assert.equal(typeof r.message, "string");
  assert.ok(r.message.length > 0);
  assert.equal(r.rev, 0);
  assert.equal((await call("rev")).rev, 0);
  assert.equal((await historyAll(call)).length, 0);
});

test("updateExpense changing the amount keeps the original rate and logs an edit with the arrow form", async () => {
  const call = client({ expenses: [ramen({ rate: 98 })] });
  const r = await call("updateExpense", { id: "exp0000001", patch: { amount: 4500 } });
  assert.equal(r.ok, true);
  assert.equal(r.data.expense.amount, 4500);
  assert.equal(r.data.expense.rate, 98);
  assert.equal(typeof r.data.logId, "number");
  const [top] = await historyAll(call);
  assert.equal(top.action, "edit");
  assert.equal(top.summary, "changed Ramen ¥4,200 → ¥4,500");
  assert.equal(top.id, r.data.logId);
});

test("updateExpense to an exact split that does not add up is bad_input", async () => {
  const call = client({ expenses: [ramen()] });
  const r = await call("updateExpense", { id: "exp0000001", patch: { splitMode: "exact", splitVals: [2000, 1000, 1000] } });
  assert.equal(r.ok, false);
  assert.equal(r.error, "bad_input");
  assert.equal((await historyAll(call)).length, 1);
});

test("deleteExpense then restoreExpense toggles deleted and logs both; an unknown id is not_found", async () => {
  const call = client({ expenses: [ramen()] });
  const d = await call("deleteExpense", { id: "exp0000001" });
  assert.equal(d.ok, true);
  assert.equal(d.data.expense.deleted, true);
  const r = await call("restoreExpense", { id: "exp0000001" });
  assert.equal(r.ok, true);
  assert.equal(r.data.expense.deleted, false);
  const actions = (await historyAll(call)).map((e) => e.action);
  assert.deepEqual(actions, ["restore", "delete", "add"]);
  for (const action of ["deleteExpense", "restoreExpense", "updateExpense"]) {
    const n = await call(action, { id: "nosuchline1", patch: { amount: 5 } });
    assert.equal(n.ok, false, action);
    assert.equal(n.error, "not_found");
    assert.equal(typeof n.message, "string");
  }
});

test("addPayment, removePayment, restorePayment toggle removed and log stamp, unstamp, restamp; a repeat add is recorded once", async () => {
  const call = client();
  const a = await call("addPayment", { payment: stampOf() }, { actor: "Ajen" });
  assert.equal(a.ok, true);
  assert.equal(a.data.payment.removed, false);
  assert.equal(a.data.payment.stampedBy, "Ajen");
  assert.equal(a.data.payment.seed, 3);
  assert.equal(a.data.payment.rot, -2.5);
  const again = await call("addPayment", { payment: stampOf() }, { actor: "Ajen" });
  assert.deepEqual(again.data, a.data);
  const rm = await call("removePayment", { id: "pay0000001" });
  assert.equal(rm.data.payment.removed, true);
  const back = await call("restorePayment", { id: "pay0000001" });
  assert.equal(back.data.payment.removed, false);
  const hist = await historyAll(call);
  assert.deepEqual(hist.map((e) => e.action), ["restamp", "unstamp", "stamp"]);
  assert.equal(hist[2].summary, "stamped Ajen → Mo $25.00");
  assert.equal((await call("load")).data.payments.length, 1);
  assert.equal((await call("removePayment", { id: "nosuchpay1" })).error, "not_found");
});

test("setPerson turns Simplify off for Trenton, load shows it, rev rises and history gains nothing", async () => {
  const call = client();
  const r = await call("setPerson", { name: "Trenton", patch: { simplify: false } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.person, { name: "Trenton", initials: "TR", etransfer: "", simplify: false });
  assert.equal(r.rev, 1);
  const load = await call("load");
  assert.equal(load.data.people.find((p) => p.name === "Trenton").simplify, false);
  assert.equal(load.rev, 1);
  assert.equal((await historyAll(call)).length, 0);
});

test("history is newest first, records via claude, filters by ref, and pages with limit and before", async () => {
  const call = client();
  await call("addExpense", { expense: ramen() });
  await call("addExpense", { expense: ramen({ id: "exp0000002", title: "Coffee", amount: 600 }) }, { via: "claude" });
  await call("deleteExpense", { id: "exp0000001" });
  const all = await historyAll(call);
  assert.deepEqual(all.map((e) => e.id), [3, 2, 1]);
  assert.equal(all[1].via, "claude");
  assert.equal(all[0].via, "app");
  assert.equal(all[2].via, "app");
  const one = await historyAll(call, { ref: "exp0000001" });
  assert.deepEqual(one.map((e) => e.action), ["delete", "add"]);
  const page1 = await call("history", { limit: 2 });
  assert.equal(page1.data.entries.length, 2);
  assert.equal(page1.data.more, true);
  const older = page1.data.entries[1].id;
  const page2 = await call("history", { limit: 2, before: older });
  assert.deepEqual(page2.data.entries.map((e) => e.id), [1]);
  assert.equal(page2.data.more, false);
});

test("undo an add: the line is deleted, the undo is logged, and the original can no longer be undone", async () => {
  const call = client();
  const add = await call("addExpense", { expense: ramen() });
  const u = await call("undo", { logId: add.data.logId });
  assert.equal(u.ok, true);
  assert.equal(u.data.expense.deleted, true);
  assert.equal(u.data.entry.action, "undo");
  assert.equal(u.data.entry.undoes, add.data.logId);
  assert.ok(u.data.entry.summary.startsWith("undid: rang up"));
  assert.equal(u.data.logId, u.data.entry.id);
  assert.equal(u.rev, 2);
  const hist = await historyAll(call);
  const original = hist.find((e) => e.id === add.data.logId);
  const undoEntry = hist.find((e) => e.id === u.data.logId);
  assert.equal(original.undoneBy, u.data.logId);
  assert.equal(original.canUndo, false);
  assert.equal(undoEntry.canUndo, true);
});

test("undo the undo brings the line back", async () => {
  const call = client();
  const add = await call("addExpense", { expense: ramen() });
  const u1 = await call("undo", { logId: add.data.logId });
  const u2 = await call("undo", { logId: u1.data.logId });
  assert.equal(u2.ok, true);
  assert.equal(u2.data.expense.deleted, false);
  assert.equal((await call("load")).data.expenses[0].deleted, false);
});

test("undo an edit puts the amount back and keeps the rate, adder and time it was added", async () => {
  const added = { rate: 98, addedBy: "Trenton", addedAt: "2026-12-09T01:00:00.000Z" };
  const call = client({ expenses: [ramen(added)] }, { clock: () => "2026-12-10T05:00:00.000Z" });
  const ed = await call("updateExpense", { id: "exp0000001", patch: { amount: 4500 } }, { actor: "Ajen" });
  assert.equal(ed.data.expense.amount, 4500);
  const u = await call("undo", { logId: ed.data.logId }, { actor: "Ajen" });
  assert.equal(u.ok, true);
  for (const e of [u.data.expense, (await call("load")).data.expenses[0]]) {
    assert.equal(e.amount, 4200);
    assert.equal(e.rate, 98);
    assert.equal(e.addedBy, "Trenton");
    assert.equal(e.addedAt, "2026-12-09T01:00:00.000Z");
  }
});

test("a repeat add with the same id but different content returns the first line and records nothing", async () => {
  const call = client();
  const first = await call("addExpense", { expense: ramen() });
  const logLen = call.fake.tables.Log.length;
  const again = await call("addExpense", { expense: ramen({ title: "Different", amount: 999, paidBy: "Ajen" }) }, { actor: "Trenton" });
  assert.equal(again.ok, true);
  assert.deepEqual(again.data.expense, first.data.expense);
  assert.equal(again.data.expense.title, "Ramen");
  assert.equal(again.data.expense.addedBy, "Mo");
  assert.equal(again.data.logId, first.data.logId);
  assert.equal(again.rev, first.rev);
  assert.equal(call.fake.tables.Log.length, logLen);
  assert.equal(call.fake.tables.Expenses.length, 1);
});

test("undoing an edit to an exact split restores the equal split and payer, and undoing that brings the exact split back", async () => {
  const call = client({ expenses: [ramen()] });
  const ed = await call("updateExpense", { id: "exp0000001", patch: { splitMode: "exact", splitVals: [2000, 1200, 1000], paidBy: "Ajen" } });
  assert.equal(ed.ok, true);
  assert.equal(ed.data.expense.splitMode, "exact");
  const u1 = await call("undo", { logId: ed.data.logId });
  assert.equal(u1.ok, true);
  for (const e of [u1.data.expense, (await call("load")).data.expenses[0]]) {
    assert.equal(e.splitMode, "equal");
    assert.deepEqual(e.splitVals, []);
    assert.equal(e.paidBy, "Mo");
    assert.deepEqual(e.split, ALL);
  }
  const u2 = await call("undo", { logId: u1.data.logId });
  assert.equal(u2.ok, true);
  for (const e of [u2.data.expense, (await call("load")).data.expenses[0]]) {
    assert.equal(e.splitMode, "exact");
    assert.deepEqual(e.splitVals, [2000, 1200, 1000]);
    assert.equal(e.paidBy, "Ajen");
  }
});

test("undo a stamp removes the payment", async () => {
  const call = client();
  const a = await call("addPayment", { payment: stampOf() });
  const u = await call("undo", { logId: a.data.logId });
  assert.equal(u.ok, true);
  assert.equal(u.data.payment.removed, true);
  assert.equal("expense" in u.data, false);
});

test("stale: an older change, an already undone change, and an unknown logId are refused and change nothing", async () => {
  const call = client({ expenses: [ramen()] });
  const e1 = await call("updateExpense", { id: "exp0000001", patch: { amount: 4500 } });
  const e2 = await call("updateExpense", { id: "exp0000001", patch: { amount: 4800 } });
  const revBefore = e2.rev;
  const logBefore = JSON.stringify(call.fake.tables.Log);
  const s = await call("undo", { logId: e1.data.logId });
  assert.equal(s.ok, false);
  assert.equal(s.error, "stale");
  assert.equal(typeof s.message, "string");
  assert.equal(s.rev, revBefore);
  assert.equal(JSON.stringify(call.fake.tables.Log), logBefore);
  assert.equal((await call("load")).data.expenses[0].amount, 4800);

  const u = await call("undo", { logId: e2.data.logId });
  assert.equal(u.ok, true);
  const again = await call("undo", { logId: e2.data.logId });
  assert.equal(again.error, "stale");

  const nf = await call("undo", { logId: 999 });
  assert.equal(nf.error, "not_found");
});

test("a fake built from the seed fixture has nine expenses, one deleted, and ten history entries", async () => {
  const call = client(SEED);
  const load = await call("load");
  assert.equal(load.data.expenses.length, 9);
  assert.equal(load.data.expenses.filter((e) => e.deleted).length, 1);
  assert.equal(load.data.expenses.find((e) => e.deleted).id, "seedexp005");
  const live = load.data.expenses.filter((e) => !e.deleted);
  assert.equal(live.reduce((s, e) => s + e.amount, 0), 438340);
  const lodge = load.data.expenses.find((e) => e.id === "seedexp001");
  assert.equal(lodge.note, "ref NK-4471");
  assert.equal(lodge.kind, "stay");
  assert.equal(lodge.rate, 111);
  assert.equal(lodge.addedBy, "Mo");
  assert.deepEqual(load.data.expenses.find((e) => e.id === "seedexp008").split, ["Ajen", "Trenton"]);
  const hist = await historyAll(call);
  assert.equal(hist.length, 10);
  const five = await historyAll(call, { ref: "seedexp005" });
  assert.deepEqual(five.map((e) => e.action), ["delete", "add"]);
  assert.equal(five[0].canUndo, true);
  assert.equal(five[1].canUndo, false);
});

// ---------- rulings ----------

test("updateExpense refuses patch keys it does not allow", async () => {
  const call = client({ expenses: [ramen()] });
  for (const patch of [{ rate: 1 }, { addedBy: "Ajen" }, { deleted: true }, { id: "other00001" }, { amount: 10, color: "red" }]) {
    const r = await call("updateExpense", { id: "exp0000001", patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.error, "bad_input");
  }
  for (const patch of [null, "x", [1]]) {
    assert.equal((await call("updateExpense", { id: "exp0000001", patch })).error, "bad_input");
  }
  assert.equal((await call("load")).data.expenses[0].rate, 111);
  assert.equal((await historyAll(call)).length, 1);
});

test("a deleted line must be brought back before it can be edited", async () => {
  const call = client({ expenses: [ramen({ deleted: true })] });
  const r = await call("updateExpense", { id: "exp0000001", patch: { amount: 10 } });
  assert.equal(r.ok, false);
  assert.equal(r.error, "bad_input");
  assert.equal(r.message, "Bring it back first.");
});

test("repeat delete, restore of a live line, and the same for payments answer unchanged with no log and no rev bump", async () => {
  const call = client({
    expenses: [ramen(), ramen({ id: "exp0000002", deleted: true })],
    payments: [stampOf(), stampOf({ id: "pay0000002", removed: true })],
  });
  const logLen = call.fake.tables.Log.length;
  const cases = [
    ["restoreExpense", "exp0000001", "expense", "deleted", false],
    ["deleteExpense", "exp0000002", "expense", "deleted", true],
    ["restorePayment", "pay0000001", "payment", "removed", false],
    ["removePayment", "pay0000002", "payment", "removed", true],
  ];
  for (const [action, id, kind, flag, value] of cases) {
    const r = await call(action, { id });
    assert.equal(r.ok, true, action);
    assert.equal(r.data[kind].id, id);
    assert.equal(r.data[kind][flag], value);
    assert.equal(r.data.logId, null);
    assert.equal(r.rev, 0);
  }
  assert.equal(call.fake.tables.Log.length, logLen);
});

test("an edit that changes nothing answers unchanged with no log and no rev bump", async () => {
  const call = client({ expenses: [ramen({ note: "x" })] });
  for (const patch of [{ amount: 4200 }, { title: " Ramen " }, { note: "x", split: ALL.slice() }, {}]) {
    const r = await call("updateExpense", { id: "exp0000001", patch });
    assert.equal(r.ok, true, JSON.stringify(patch));
    assert.equal(r.data.logId, null);
    assert.equal(r.data.expense.amount, 4200);
    assert.equal(r.rev, 0);
  }
  assert.equal((await historyAll(call)).length, 1);
});

test("every write needs an actor who is on the trip", async () => {
  const call = client({ expenses: [ramen({ id: "exp0000009" })] });
  const writes = [
    ["addExpense", { expense: ramen() }],
    ["updateExpense", { id: "exp0000009", patch: { amount: 10 } }],
    ["deleteExpense", { id: "exp0000009" }],
    ["addPayment", { payment: stampOf() }],
    ["setPerson", { name: "Mo", patch: { simplify: false } }],
    ["undo", { logId: 1 }],
  ];
  for (const actor of ["Nobody", "", undefined, "mo"]) {
    for (const [action, args] of writes) {
      const r = await call(action, args, { actor });
      assert.equal(r.ok, false, action + " " + actor);
      assert.equal(r.error, "bad_input");
    }
  }
  assert.equal((await call("rev")).rev, 0);
  assert.equal((await call("load", {}, { actor: undefined })).ok, true);
});

test("via is claude only when the body says exactly that", async () => {
  const call = client();
  await call("addExpense", { expense: ramen({ id: "exp0000001" }) }, { via: "Claude" });
  await call("addExpense", { expense: ramen({ id: "exp0000002" }) }, { via: "web" });
  await call("addExpense", { expense: ramen({ id: "exp0000003" }) }, { via: "claude" });
  const vias = (await historyAll(call)).map((e) => e.via);
  assert.deepEqual(vias, ["claude", "app", "app"]);
  assert.equal(call.fake.tables.Log[0].via, "app");
});

test("history by ref covers either kind, newest first, and limit is clamped to 1..500", async () => {
  const expenses = [];
  for (let i = 0; i < 505; i++) expenses.push(ramen({ id: "bulk" + String(i).padStart(6, "0"), amount: 100 + i }));
  const call = client({ expenses, payments: [stampOf()] });
  await call("removePayment", { id: "pay0000001" });
  const pay = await historyAll(call, { ref: "pay0000001" });
  assert.deepEqual(pay.map((e) => e.action), ["unstamp", "stamp"]);
  const zero = await call("history", { limit: 0 });
  assert.equal(zero.data.entries.length, 1);
  assert.equal(zero.data.more, true);
  const big = await call("history", { limit: 1000 });
  assert.equal(big.data.entries.length, 500);
  assert.equal(big.data.more, true);
  const dflt = await call("history");
  assert.equal(dflt.data.entries.length, 200);
  const odd = await call("history", { limit: "lots" });
  assert.equal(odd.data.entries.length, 200);
  for (const e of dflt.data.entries) {
    assert.equal("before" in e, false);
    assert.equal("after" in e, false);
  }
});

test("load never returns email, the trip key or the Log", async () => {
  const call = client(SEED);
  call.fake.tables.People[0].email = "private@example.com";
  const r = await call("load");
  const text = JSON.stringify(r);
  assert.equal(text.includes("email"), false);
  assert.equal(text.includes("private@example.com"), false);
  assert.equal(text.includes(KEY), false);
  assert.equal("log" in r.data, false);
  assert.equal("history" in r.data, false);
  assert.equal(text.includes("rang up"), false);
});

test("rev is a number on reads, writes and errors", async () => {
  const call = client({ expenses: [ramen()] });
  const r0 = await call("rev");
  assert.deepEqual(r0, { ok: true, rev: 0, data: {} });
  await call("deleteExpense", { id: "exp0000001" });
  for (const [action, args] of [["load", {}], ["rev", {}], ["history", {}], ["addExpense", { expense: ramen({ amount: 0 }) }], ["deleteExpense", { id: "nosuchline1" }], ["undo", { logId: 1 }], ["nonsense", {}]]) {
    const r = await call(action, args);
    assert.equal(r.rev, 1, action);
  }
});

test("odd request bodies are refused with bad_input and a message", async () => {
  const fake = createFakeBackend();
  for (const body of [null, undefined, "load", 5, []]) {
    const r = await fake(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.error, "bad_input");
    assert.equal(typeof r.message, "string");
  }
  const call = client();
  for (const [action, args] of [["nonsense", {}], ["load", "x"], ["addExpense", { expense: null }], ["undo", { logId: "abc" }], ["undo", {}], ["setPerson", { name: "Trenton", patch: { initials: "XX" } }], ["history", { ref: 5 }], ["deleteExpense", { id: 7 }]]) {
    const r = await call(action, args);
    assert.equal(r.ok, false, action + " " + JSON.stringify(args));
    assert.equal(r.error, "bad_input", action + " " + JSON.stringify(args));
    assert.ok(r.message.length > 0);
  }
  assert.equal((await call("setPerson", { name: "Nobody", patch: { simplify: false } })).error, "not_found");
});

test("undo of a Log row with no before and no after is stale, never a crash", async () => {
  const call = client({ expenses: [ramen()] });
  call.fake.tables.Log.push({ id: 2, at: "2026-12-10T00:00:00.000Z", who: "Mo", via: "app", action: "edit", kind: "expense", ref: "exp0000001", summary: "x", before: "", after: "", undoes: "", undone_by: "" });
  const r = await call("undo", { logId: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "stale");
  assert.equal((await call("load")).data.expenses[0].deleted, false);
});

for (const keepsApostrophe of [false, true]) {
  test(`formula-looking text comes back as typed from load, history and undo (Sheets ${keepsApostrophe ? "keeps" : "drops"} the apostrophe)`, async () => {
    const call = client(undefined, { keepsApostrophe });
    const titles = ["=probe", "-5% off", "+81 3", "@home"];
    const adds = [];
    for (let i = 0; i < titles.length; i++) {
      const r = await call("addExpense", { expense: ramen({ id: "fx00000" + i, title: titles[i], note: titles[(i + 1) % titles.length] }) });
      assert.equal(r.data.expense.title, titles[i]);
      adds.push(r);
    }
    assert.equal(call.fake.tables.Expenses[0].title, "'=probe");
    assert.equal(call.fake.tables.Expenses[1].note, "'+81 3");
    const load = (await call("load")).data.expenses;
    assert.deepEqual(load.map((e) => e.title), titles);
    assert.deepEqual(load.map((e) => e.note), ["-5% off", "+81 3", "@home", "=probe"]);
    const hist = await historyAll(call);
    assert.deepEqual(hist.map((e) => e.summary).reverse(), titles.map((t) => "rang up " + t + " ¥4,200"));

    const ed = await call("updateExpense", { id: "fx000000", patch: { title: "-renamed" } });
    assert.equal(ed.data.expense.title, "-renamed");
    const u = await call("undo", { logId: ed.data.logId });
    assert.equal(u.data.expense.title, "=probe");
    assert.equal(u.data.expense.note, "-5% off");
    assert.equal(u.data.entry.summary, "undid: renamed =probe to -renamed");
    const ua = await call("undo", { logId: adds[3].data.logId });
    assert.equal(ua.data.expense.title, "@home");
    assert.equal(ua.data.expense.deleted, true);
    const after = (await call("load")).data.expenses;
    assert.deepEqual(after.map((e) => e.title), titles);
    assert.equal((await historyAll(call))[0].summary, "undid: rang up @home ¥4,200");
  });
}

test("the fake keeps every request, and requests and answers are copies", async () => {
  const fake = createFakeBackend();
  const body = { key: KEY, actor: "Mo", action: "addExpense", args: { expense: ramen() } };
  const r = await fake(body);
  body.args.expense.title = "Changed after sending";
  r.data.expense.title = "Changed after answering";
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].args.expense.title, "Ramen");
  const load = await fake({ key: KEY, action: "load", args: {} });
  assert.equal(load.data.expenses[0].title, "Ramen");
  assert.equal(fake.requests.length, 2);
});

test("seed people and days are applied as patches, and seeded log rows use the seeded who and when", async () => {
  const call = client({
    people: { Trenton: { simplify: false, etransfer: "tr@example.com" } },
    days: { "2026-12-11": { city: "Tokyo", title: "Shibuya" } },
    expenses: [ramen({ addedBy: "Ajen", addedAt: "2026-12-10T03:00:00.000Z" })],
    payments: [stampOf({ stampedAt: "2026-12-12T03:00:00.000Z" })],
  });
  const d = (await call("load")).data;
  assert.deepEqual(d.people[2], { name: "Trenton", initials: "TR", etransfer: "tr@example.com", simplify: false });
  const day = d.days.find((x) => x.date === "2026-12-11");
  assert.equal(day.city, "Tokyo");
  assert.equal(day.title, "Shibuya");
  assert.equal(d.days.find((x) => x.date === "2026-12-10").city, "");
  assert.equal(d.expenses[0].addedBy, "Ajen");
  assert.equal(d.payments[0].stampedBy, "Ajen");
  assert.equal(d.payments[0].seed, 3);
  const hist = await historyAll(call);
  assert.deepEqual(hist.map((e) => [e.action, e.who, e.at]), [
    ["stamp", "Ajen", "2026-12-12T03:00:00.000Z"],
    ["add", "Ajen", "2026-12-10T03:00:00.000Z"],
  ]);
  const next = await call("addExpense", { expense: ramen({ id: "exp0000002" }) });
  assert.equal(next.data.logId, 3);
});

test("the in-memory sheet helpers behave like the real ones", () => {
  const fake = createFakeBackend();
  const p = fake.primitives;
  fake.tables.Expenses.push(Object.fromEntries(TABS.Expenses.map((h) => [h, ""])));
  p.appendObj_("Expenses", { id: "exp0000001", title: "Ramen", amount: 4200, note: "n" });
  assert.equal(p.updateById_("Expenses", "", { title: "hit" }), null);
  assert.equal(p.updateById_("Expenses", null, { title: "hit" }), null);
  assert.equal(fake.tables.Expenses[0].title, "");
  assert.equal(p.updateById_("Expenses", "nosuchline1", { title: "x" }), null);
  assert.equal(p.updateWhere_("Expenses", "nosuchcolumn", "x", { title: "x" }), null);
  const row = p.updateById_("Expenses", "exp0000001", { title: "-dash", note: undefined, nosuchcolumn: 1 });
  assert.equal(row.title, "-dash");
  assert.equal(row.note, "n");
  assert.equal(row.amount, 4200);
  assert.equal("nosuchcolumn" in row, false);
  assert.equal(fake.tables.Expenses[1].title, "'-dash");
  assert.equal(p.readTable_("Expenses")[1].title, "-dash");
  assert.equal(p.appendObj_("Expenses", { id: "exp0000002" }), undefined);
  assert.deepEqual(Object.keys(fake.tables.Expenses[2]), TABS.Expenses);
});

test("text that looks like a date or a number comes back exactly as typed", async () => {
  const call = client();
  const a = await call("addExpense", { expense: ramen({ id: "exp0000001", title: "1/2", note: "3-4" }) });
  const b = await call("addExpense", { expense: ramen({ id: "exp0000002", title: "0012" }) });
  assert.equal(a.data.expense.title, "1/2");
  assert.equal(a.data.expense.note, "3-4");
  assert.equal(b.data.expense.title, "0012");
  const load = (await call("load")).data.expenses;
  assert.deepEqual(load.map((e) => [e.title, e.note]), [["1/2", "3-4"], ["0012", ""]]);
  assert.equal(typeof load[0].amount, "number");
  assert.equal(typeof load[0].rate, "number");
  const hist = await historyAll(call);
  assert.deepEqual(hist.map((e) => e.summary), ["rang up 0012 ¥4,200", "rang up 1/2 ¥4,200"]);
  assert.deepEqual(hist.map((e) => e.id), [2, 1]);
  const u = await call("undo", { logId: b.data.logId });
  assert.equal(u.data.expense.title, "0012");
  assert.equal(u.data.entry.undoes, 2);
});

test("the in-memory sheet hands cells back the way Sheets does under the column formats", () => {
  const fake = createFakeBackend();
  const p = fake.primitives;
  p.appendObj_("Expenses", { id: "exp0000001", title: 12, note: true, amount: "0012", rate: "111.5", split_vals: 3 });
  const row = p.readTable_("Expenses")[0];
  assert.equal(row.title, "12");
  assert.equal(row.note, "TRUE");
  assert.equal(row.amount, 12);
  assert.equal(row.rate, 111.5);
  assert.equal(row.split_vals, "3");
  p.appendObj_("Log", { id: "5", undoes: "2", summary: 7 });
  const log = p.readTable_("Log")[0];
  assert.equal(log.id, 5);
  assert.equal(log.undoes, 2);
  assert.equal(log.summary, "7");
  assert.equal(p.readTable_("People")[0].simplify, true);
  assert.equal(p.readTable_("People")[0].order, 1);
});

test("log ids and rev carry on after Script Properties are wiped", async () => {
  const call = client({ expenses: [ramen({ id: "exp0000009" })] });
  await call("addExpense", { expense: ramen() });
  await call("updateExpense", { id: "exp0000001", patch: { amount: 4500 } });
  const last = await call("deleteExpense", { id: "exp0000009" });
  assert.equal(last.data.logId, 4);
  const revBefore = last.rev;
  for (const k of Object.keys(call.fake.props)) if (k !== "TRIP_KEY") delete call.fake.props[k];
  assert.ok((await call("rev")).rev >= 4);
  const next = await call("addExpense", { expense: ramen({ id: "exp0000002" }) });
  assert.equal(next.ok, true);
  assert.equal(next.data.logId, 5);
  assert.ok(next.rev > revBefore, `rev ${next.rev} after ${revBefore}`);
  const ids = call.fake.tables.Log.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  const u = await call("undo", { logId: 5 });
  assert.equal(u.ok, true);
  assert.equal(u.data.logId, 6);
});

test("a write that cannot get the lock answers busy, writes nothing and leaves rev alone", async () => {
  let locked = false;
  const fake = createFakeBackend({ expenses: [ramen({ id: "exp0000009" })] }, { lockFails: () => locked });
  const send = (action, args) => fake({ key: KEY, actor: "Mo", action, args });
  await send("deleteExpense", { id: "exp0000009" });
  const before = JSON.stringify(fake.tables);
  locked = true;
  for (const [action, args] of [["addExpense", { expense: ramen() }], ["restoreExpense", { id: "exp0000009" }], ["setPerson", { name: "Mo", patch: { simplify: false } }], ["undo", { logId: 2 }]]) {
    const r = await send(action, args);
    assert.equal(r.ok, false, action);
    assert.equal(r.error, "busy");
    assert.equal(typeof r.message, "string");
    assert.equal(r.rev, 1);
  }
  assert.equal(JSON.stringify(fake.tables), before);
  const load = await send("load", {});
  assert.equal(load.ok, true);
  assert.equal(load.rev, 1);
  locked = false;
  assert.equal((await send("addExpense", { expense: ramen() })).rev, 2);
});
