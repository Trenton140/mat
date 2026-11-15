import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createApi } from "../js/api.js";
import { createStore } from "../js/store.js";
import { balances, direct } from "../js/money.js";

const require = createRequire(import.meta.url);
const { createFakeBackend } = require("./fake-backend.cjs");
const SEED = require("./fixtures/seed.json");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = "test-key";
const URL = "https://example.test/exec";
const NOW = Date.UTC(2026, 11, 11, 3);
const ALL = ["Mo", "Ajen", "Trenton"];
const UNDO_FAILED = "Couldn’t undo that. Try again from History.";
const STALE = "That was changed again since. Undo the newer change first.";

// ---------- helpers ----------

function memStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

// One phone: a store on its own (or a shared) storage, talking to a fake
// backend through createApi with a controllable network.
//   net.offline        every request fails like a dropped connection
//   net.failing        actions that fail like a dropped connection
//   net.override(body) return an envelope to answer instead of the backend
//   net.hold(action)   the next response for that action waits for release()
//   net.lose           actions that reach the backend but whose reply is lost
//   net.garble         actions that reach the backend but get a non-envelope reply
//   net.knownOffline   the phone itself says it has no network: nothing is sent
function phone({ seed, fake, storage, me = "Mo", nowMs = NOW } = {}) {
  fake = fake || createFakeBackend(seed);
  storage = storage || memStorage({ "mat.key": KEY, "mat.me": me });
  const net = { offline: false, knownOffline: false, failing: new Set(), lose: new Set(), garble: new Set(), override: null, holds: [], sent: [] };
  net.hold = (action) => {
    let release;
    const promise = new Promise((r) => { release = r; });
    net.holds.push({ action, promise, used: false });
    return release;
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    net.sent.push(body);
    if (net.offline || net.failing.has(body.action)) throw new TypeError("Failed to fetch");
    let env = net.override ? net.override(body) : null;
    if (!env) env = await fake(body);
    if (net.lose.has(body.action)) throw new TypeError("Load failed");
    if (net.garble.has(body.action)) return { ok: false, status: 502, text: async () => "<html>Bad gateway</html>" };
    const hold = net.holds.find((h) => h.action === body.action && !h.used);
    if (hold) {
      hold.used = true;
      await hold.promise;
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(env) };
  };
  const api = createApi({ url: URL, getKey: () => storage.getItem("mat.key"), getActor: () => storage.getItem("mat.me"), fetchImpl, isOnline: () => !net.knownOffline });
  const waits = [];
  const store = createStore({ api, storage, now: () => nowMs, wait: async (ms) => { waits.push(ms); } });
  return { fake, storage, net, api, store, waits };
}

// Straight to the backend, as another phone would.
async function backend(fake, action = "load", args = {}, actor = "Ajen") {
  const r = await fake({ key: KEY, actor, action, args });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.data;
}

const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); };
const sent = (fake, action) => fake.requests.filter((r) => r.action === action).length;
const queueOf = (storage) => JSON.parse(storage.getItem("mat.queue") || "[]");
const byId = (list, id) => list.find((x) => x.id === id);

function draft(over = {}) {
  return { day: "2026-12-11", title: "Dinner", amount: 14500, currency: "JPY", paidBy: "Mo", split: ALL.slice(), splitMode: "equal", splitVals: [], note: "", kind: "", ...over };
}

// The id of the line a write token made.
function idOf(store) {
  return store.state.lastChange.item.id;
}

// ---------- api ----------

test("api posts { key, actor, via, action, args } as text/plain and resolves { rev, data }", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, rev: 7, data: { hello: 1 } }) };
  };
  let actor = "Mo";
  const api = createApi({ url: URL, getKey: () => "sekret-key", getActor: () => actor, fetchImpl });
  actor = "Ajen"; // read at call time
  const r = await api("load", { a: 1 });
  assert.deepEqual(r, { rev: 7, data: { hello: 1 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL);
  assert.equal(calls[0].url.includes("sekret"), false);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "text/plain;charset=utf-8");
  assert.deepEqual(JSON.parse(calls[0].init.body), { key: "sekret-key", actor: "Ajen", via: "app", action: "load", args: { a: 1 } });
});

test("api rejects with the backend's error code, network when fetch fails, server on a bad reply, and never shows the key", async () => {
  const reply = (text) => async () => ({ ok: true, status: 200, text: async () => text });
  const make = (fetchImpl) => createApi({ url: URL, getKey: () => "sekret-key", getActor: () => "Mo", fetchImpl });
  const cases = [
    [reply(JSON.stringify({ ok: false, error: "stale", message: "Too late." })), "stale"],
    [async () => { throw new TypeError("Failed to fetch"); }, "network"],
    [reply("<html>oops</html>"), "server"],
    [reply(JSON.stringify({ rev: 1, data: {} })), "server"],
    [reply(JSON.stringify({ ok: "yes" })), "server"],
  ];
  for (const [fetchImpl, code] of cases) {
    const err = await make(fetchImpl)("load").then(() => null, (e) => e);
    assert.ok(err instanceof Error, code);
    assert.equal(err.code, code);
    assert.equal(String(err.message).includes("sekret"), false);
    assert.equal(String(err.stack).includes("sekret"), false);
  }
});

test("api gives up after its timeout: a request that never settles is a network failure", async () => {
  let signal = null;
  const never = (url, init) => { signal = init.signal; return new Promise(() => {}); }; // ignores the signal, never settles
  const api = createApi({ url: URL, getKey: () => "sekret-key", getActor: () => "Mo", fetchImpl: never, timeoutMs: 20 });
  const started = Date.now();
  const err = await api("rev").then(() => null, (e) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.code, "network");
  assert.ok(Date.now() - started < 1000, "gave up at the timeout");
  assert.ok(signal && signal.aborted, "the request was aborted");
  assert.equal(String(err.message).includes("sekret"), false);

  // A body that never finishes counts the same.
  const slowBody = async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) });
  const err2 = await createApi({ url: URL, getKey: () => KEY, getActor: () => "Mo", fetchImpl: slowBody, timeoutMs: 20 })("rev").then(() => null, (e) => e);
  assert.equal(err2.code, "network");
});

test("api waits 30 seconds by default before giving up", async () => {
  const { API_TIMEOUT_MS } = await import("../js/api.js");
  assert.equal(API_TIMEOUT_MS, 30000);
});

test("api uses MAT_FAKE_API in place of fetch, and a rejection from it is a network failure", async () => {
  const bodies = [];
  let fetched = 0;
  const api = createApi({ url: URL, getKey: () => KEY, getActor: () => "Mo", fetchImpl: async () => { fetched++; } });
  try {
    globalThis.MAT_FAKE_API = async (body) => { bodies.push(body); return { ok: true, rev: 3, data: { x: 1 } }; };
    assert.deepEqual(await api("rev", {}), { rev: 3, data: { x: 1 } });
    assert.deepEqual(bodies, [{ key: KEY, actor: "Mo", via: "app", action: "rev", args: {} }]);
    globalThis.MAT_FAKE_API = () => Promise.reject(new Error("bridge down"));
    const err = await api("rev", {}).then(() => null, (e) => e);
    assert.equal(err.code, "network");
    assert.equal(fetched, 0);
  } finally {
    delete globalThis.MAT_FAKE_API;
  }
});

// ---------- boot ----------

test("Boot paints from cache first", async () => {
  const p = phone({ seed: SEED });
  const empty = await backend(createFakeBackend());
  const cached = { id: "cached0001", ...draft({ title: "Cached" }), rate: 111, addedBy: "Mo", addedAt: "2026-12-11T01:00:00.000Z", deleted: false };
  p.storage.setItem("mat.cache", JSON.stringify({ data: { ...empty, expenses: [cached] }, rev: 0, loadedAt: 1000 }));
  const release = p.net.hold("load");
  const seen = [];
  p.store.subscribe((s) => seen.push({ ids: s.expenses.map((e) => e.id), loadedAt: s.loadedAt }));
  const booting = p.store.boot();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(seen.length >= 1);
  assert.deepEqual(seen[0].ids, ["cached0001"]);
  assert.equal(seen[0].loadedAt, 1000);
  assert.equal(p.store.state.status, "ready");
  release();
  await booting;
  const server = await backend(p.fake);
  assert.deepEqual(p.store.state.expenses, server.expenses);
  assert.deepEqual(p.store.state.people, server.people);
  assert.equal(p.store.state.status, "ready");
  assert.equal(p.store.state.loadedAt, NOW);
  assert.equal(p.store.state.online, true);
  assert.equal(p.store.state.me, "Mo");
  const cache = JSON.parse(p.storage.getItem("mat.cache"));
  assert.equal(cache.loadedAt, NOW);
  assert.equal(cache.data.expenses.length, 9);
});

test("No key", async () => {
  const p = phone({ storage: memStorage({ "mat.me": "Mo" }) });
  await p.store.boot();
  assert.equal(p.store.state.status, "nokey");
  assert.equal(p.net.sent.length, 0);
  assert.equal(p.fake.requests.length, 0);
});

test("Wrong key", async () => {
  const p = phone({ storage: memStorage({ "mat.key": "not-the-key", "mat.me": "Mo" }) });
  await p.store.boot();
  assert.equal(p.store.state.status, "nokey");
});

test("me is null when mat.me is missing or not one of the people, and setMe stores it", async () => {
  const a = phone({ storage: memStorage({ "mat.key": KEY }) });
  await a.store.boot();
  assert.equal(a.store.state.me, null);
  a.store.setMe("Ajen");
  assert.equal(a.store.state.me, "Ajen");
  assert.equal(a.storage.getItem("mat.me"), "Ajen");

  const b = phone({ storage: memStorage({ "mat.key": KEY, "mat.me": "Zed" }) });
  await b.store.boot();
  assert.equal(b.store.state.me, null);
});

test("corrupt JSON in mat.cache and mat.queue is treated as absent", async () => {
  const storage = memStorage({ "mat.key": KEY, "mat.me": "Mo", "mat.cache": "{not json", "mat.queue": "[oops" });
  const p = phone({ seed: SEED, storage });
  await p.store.boot();
  assert.equal(p.store.state.status, "ready");
  assert.equal(p.store.state.expenses.length, 9);
  assert.equal(sent(p.fake, "addExpense"), 0);
  // valid JSON of the wrong shape is ignored too
  const q = phone({ seed: SEED, storage: memStorage({ "mat.key": KEY, "mat.cache": "42", "mat.queue": "{\"a\":1}" }) });
  await q.store.boot();
  assert.equal(q.store.state.expenses.length, 9);
});

test("storage that throws never breaks the store", async () => {
  const fake = createFakeBackend(SEED);
  const writesThrow = { getItem: (k) => ({ "mat.key": KEY, "mat.me": "Mo" }[k] ?? null), setItem: () => { throw new Error("QuotaExceededError"); } };
  const p = phone({ fake, storage: writesThrow });
  await p.store.boot();
  assert.equal(p.store.state.status, "ready");
  p.store.addExpense(draft());
  p.store.markSeen();
  p.store.setMe("Ajen");
  await p.store.idle();
  assert.equal((await backend(fake)).expenses.length, 10);

  const allThrow = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } };
  const q = phone({ fake, storage: allThrow });
  await q.store.boot();
  assert.equal(q.store.state.status, "nokey");
});

test("a failed load keeps the cached loadedAt and goes offline; the next good call comes back online", async () => {
  const first = phone({ seed: SEED });
  await first.store.boot();
  const p = phone({ fake: first.fake, storage: first.storage });
  p.storage.setItem("mat.cache", JSON.stringify({ ...JSON.parse(p.storage.getItem("mat.cache")), loadedAt: 1234 }));
  p.net.offline = true;
  await p.store.boot();
  assert.equal(p.store.state.status, "ready");
  assert.equal(p.store.state.online, false);
  assert.equal(p.store.state.loadedAt, 1234);
  assert.equal(p.store.state.expenses.length, 9);
  p.net.offline = false;
  await p.store.checkRev();
  assert.equal(p.store.state.online, true);
});

test("with no cache and no signal, boot ends in error", async () => {
  const p = phone({ seed: SEED });
  p.net.offline = true;
  await p.store.boot();
  assert.equal(p.store.state.status, "error");
  assert.equal(p.store.state.online, false);
});

// ---------- writes ----------

test("Optimistic add", async () => {
  const p = phone();
  await p.store.boot();
  const t = p.store.addExpense(draft());
  assert.equal(typeof t, "string");
  const id = idOf(p.store);
  const line = byId(p.store.state.expenses, id);
  assert.equal(line.pending, true);
  assert.equal(line.title, "Dinner");
  assert.equal(line.rate, p.store.state.rateToday);
  assert.equal(line.rate, 111);
  assert.deepEqual(p.store.state.lastChange, { token: t, action: "add", kind: "expense", item: p.store.state.lastChange.item, canUndo: true });
  await p.store.idle();
  const server = byId((await backend(p.fake)).expenses, id);
  assert.deepEqual(byId(p.store.state.expenses, id), server);
  assert.equal("pending" in byId(p.store.state.expenses, id), false);
  assert.equal(server.addedBy, "Mo");
});

test("an edit made while the add is in flight reaches the backend after it", async () => {
  const p = phone();
  await p.store.boot();
  p.store.addExpense(draft());
  const id = idOf(p.store);
  p.store.updateExpense(id, { amount: 15000 });
  assert.equal(byId(p.store.state.expenses, id).amount, 15000);
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, id).amount, 15000);
  assert.equal(byId(p.store.state.expenses, id).amount, 15000);
  const h = await backend(p.fake, "history", { ref: id });
  assert.deepEqual(h.entries.map((e) => e.action), ["edit", "add"]);
});

test("lastChange carries the item as changed, the old copy for an edit, and canUndo", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  const t = p.store.updateExpense("seedexp006", { title: "Dinner" });
  const lc = p.store.state.lastChange;
  assert.equal(lc.token, t);
  assert.equal(lc.action, "edit");
  assert.equal(lc.kind, "expense");
  assert.equal(lc.item.title, "Dinner");
  assert.equal(lc.before.title, "Shibuya dinner");
  assert.equal(lc.canUndo, true);
  await p.store.idle();
  for (const [fn, arg, action] of [["deleteExpense", "seedexp006", "delete"], ["restoreExpense", "seedexp006", "restore"]]) {
    p.store[fn](arg);
    assert.equal(p.store.state.lastChange.action, action);
    assert.equal(p.store.state.lastChange.canUndo, true);
    await p.store.idle();
  }
  const pt = p.store.addPayment({ from: "Ajen", to: "Mo", cad: 25 });
  assert.equal(p.store.state.lastChange.action, "stamp");
  assert.equal(p.store.state.lastChange.kind, "payment");
  await p.store.idle();
  const pid = idOf(p.store);
  p.store.removePayment(pid);
  assert.equal(p.store.state.lastChange.action, "unstamp");
  await p.store.idle();
  p.store.restorePayment(pid);
  assert.equal(p.store.state.lastChange.action, "restamp");
  await p.store.idle();
  assert.equal(typeof pt, "string");
});

test("addPayment makes an id, a whole seed from 1 to 999999 and a rot from -13 to 7 with one decimal", async () => {
  const p = phone();
  await p.store.boot();
  for (let i = 0; i < 40; i++) {
    p.store.addPayment({ from: "Ajen", to: "Mo", cad: 1 + i });
    const pay = p.store.state.lastChange.item;
    assert.match(pay.id, /^[A-Za-z0-9]{20}$/);
    assert.ok(Number.isInteger(pay.seed) && pay.seed >= 1 && pay.seed <= 999999, String(pay.seed));
    assert.ok(pay.rot >= -13 && pay.rot <= 7, String(pay.rot));
    assert.equal(Math.round(pay.rot * 10) / 10, pay.rot);
  }
  await p.store.idle();
  assert.equal((await backend(p.fake)).payments.length, 40);
});

test("Offline queue survives a reload", async () => {
  const one = phone();
  await one.store.boot();
  one.net.offline = true;
  one.store.addExpense(draft());
  const id = idOf(one.store);
  await one.store.idle();
  assert.equal(byId(one.store.state.expenses, id).pending, true);
  assert.equal(one.store.state.online, false);
  assert.deepEqual(queueOf(one.storage).map((q) => q.expense.id), [id]);

  // reload: a new store on the same storage, still without signal
  const two = phone({ fake: one.fake, storage: one.storage });
  two.net.offline = true;
  await two.store.boot();
  assert.equal(byId(two.store.state.expenses, id).pending, true);
  assert.equal(byId(two.store.state.expenses, id).title, "Dinner");

  two.net.offline = false;
  await Promise.all([two.store.flush(), two.store.flush()]);
  await two.store.flush();
  await two.store.idle();
  assert.equal(sent(one.fake, "addExpense"), 1);
  const server = await backend(one.fake);
  assert.equal(server.expenses.filter((e) => e.id === id).length, 1);
  assert.equal("pending" in byId(two.store.state.expenses, id), false);
  assert.deepEqual(queueOf(two.storage), []);

  // a third load of the page sends nothing more
  const three = phone({ fake: one.fake, storage: one.storage });
  await three.store.boot();
  await three.store.idle();
  assert.equal(sent(one.fake, "addExpense"), 1);
});

test("Undoing a queued line means it is never sent", async () => {
  const p = phone();
  await p.store.boot();
  p.net.offline = true;
  await p.store.checkRev(); // the phone now knows it has no signal
  assert.equal(p.store.state.online, false);
  const t = p.store.addExpense(draft());
  const id = idOf(p.store);
  await p.store.idle();
  assert.equal(byId(p.store.state.expenses, id).pending, true);
  assert.deepEqual(queueOf(p.storage).map((q) => [q.expense.id, q.sent]), [[id, false]]);
  await p.store.undo(t);
  assert.equal(byId(p.store.state.expenses, id), undefined);
  assert.deepEqual(queueOf(p.storage), []);
  p.net.offline = false;
  await p.store.flush();
  await p.store.checkRev();
  await p.store.idle();
  // a reload sends nothing either
  const again = phone({ fake: p.fake, storage: p.storage });
  await again.store.boot();
  await again.store.idle();
  assert.equal(p.net.sent.filter((b) => b.action === "addExpense").length + again.net.sent.filter((b) => b.action === "addExpense").length, 0);
  assert.equal(sent(p.fake, "addExpense"), 0);
  assert.equal(sent(p.fake, "undo"), 0);
  assert.deepEqual((await backend(p.fake)).expenses, []);
  assert.deepEqual((await backend(p.fake, "history")).entries, []);
});

test("a line undone after flush() has picked it is skipped and the lines after it still go", async () => {
  const p = phone();
  await p.store.boot();
  p.net.offline = true;
  await p.store.checkRev();
  p.store.addExpense(draft({ title: "First" }));
  const first = idOf(p.store);
  const t2 = p.store.addExpense(draft({ title: "Second" }));
  const second = idOf(p.store);
  p.store.addExpense(draft({ title: "Third" }));
  const third = idOf(p.store);
  await p.store.idle();
  p.net.offline = false;
  const flushing = p.store.flush(); // First is on its way; Second and Third are picked
  p.store.undo(t2);
  await flushing;
  await p.store.idle();
  const server = (await backend(p.fake)).expenses;
  assert.deepEqual(server.map((e) => e.id).sort(), [first, third].sort());
  assert.equal(p.fake.requests.filter((r) => r.action === "addExpense" && r.args.expense.id === second).length, 0);
  assert.equal(sent(p.fake, "undo"), 0);
  assert.deepEqual(queueOf(p.storage), []);
  assert.equal(byId(p.store.state.expenses, second), undefined);
  assert.equal("pending" in byId(p.store.state.expenses, third), false);
});

test("a queued line looks the same after a reload: its time and rate are kept", async () => {
  const one = phone();
  await one.store.boot();
  one.net.offline = true;
  one.store.addExpense(draft());
  const id = idOf(one.store);
  await one.store.idle();
  const shown = byId(one.store.state.expenses, id);
  assert.equal(shown.addedAt, new Date(NOW).toISOString());
  assert.equal(shown.rate, 111);
  // the next day the cached rate has moved on
  const cache = JSON.parse(one.storage.getItem("mat.cache"));
  cache.data.rateToday = 120;
  one.storage.setItem("mat.cache", JSON.stringify(cache));
  const two = phone({ fake: one.fake, storage: one.storage, nowMs: NOW + 86400000 });
  two.net.offline = true;
  await two.store.boot();
  assert.equal(two.store.state.rateToday, 120);
  const again = byId(two.store.state.expenses, id);
  assert.equal(again.addedAt, new Date(NOW).toISOString());
  assert.equal(again.rate, 111);
  assert.equal(again.addedBy, "Mo");
  assert.equal(again.pending, true);
});

test("the queue goes out on any contact: a later checkRev sends it exactly once", async () => {
  const one = phone();
  await one.store.boot();
  one.net.offline = true;
  one.store.addExpense(draft());
  const id = idOf(one.store);
  await one.store.idle();
  const two = phone({ fake: one.fake, storage: one.storage });
  two.net.offline = true;
  await two.store.boot();
  assert.equal(byId(two.store.state.expenses, id).pending, true);
  two.net.offline = false;
  await two.store.checkRev(); // rev unchanged, still proof of contact
  await two.store.idle();
  await two.store.checkRev();
  await two.store.refresh();
  await two.store.idle();
  assert.equal(sent(one.fake, "addExpense"), 1);
  assert.equal("pending" in byId(two.store.state.expenses, id), false);
  assert.deepEqual(queueOf(two.storage), []);
});

test("an undone add whose reply was lost is finished on the next contact: add then undo", async () => {
  const p = phone();
  await p.store.boot();
  p.net.lose.add("addExpense"); // reaches the backend, the reply never comes back
  const t = p.store.addExpense(draft());
  const id = idOf(p.store);
  p.store.undo(t);
  await p.store.idle();
  assert.equal(p.store.state.expenses.find((e) => e.id === id && !e.deleted), undefined);
  assert.equal(byId((await backend(p.fake)).expenses, id).deleted, false); // live on the backend for now
  assert.deepEqual(queueOf(p.storage).map((q) => [q.undo, q.args.expense.id]), [[true, id]]);
  assert.equal(p.store.state.online, false);
  p.net.lose.clear();
  await p.store.checkRev();
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, id).deleted, true);
  assert.deepEqual((await backend(p.fake, "history")).entries.map((e) => e.action), ["undo", "add"]);
  assert.deepEqual(byId(p.store.state.expenses, id), byId((await backend(p.fake)).expenses, id));
  assert.deepEqual(queueOf(p.storage), []);
  assert.equal(p.store.state.notice, null);
  await p.store.refresh();
  assert.equal(byId(p.store.state.expenses, id).deleted, true);
});

test("an undone add whose request never arrived ends the same way: add then undo", async () => {
  const p = phone();
  await p.store.boot();
  p.net.failing.add("addExpense");
  const t = p.store.addExpense(draft());
  const id = idOf(p.store);
  p.store.undo(t);
  await p.store.idle();
  assert.equal(byId(p.store.state.expenses, id), undefined);
  assert.equal(queueOf(p.storage)[0].undo, true);
  p.net.failing.clear();
  await p.store.flush();
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, id).deleted, true);
  assert.deepEqual((await backend(p.fake, "history")).entries.map((e) => e.action), ["undo", "add"]);
  assert.deepEqual(queueOf(p.storage), []);
});

test("an undo whose own reply was lost is finished without a second undo", async () => {
  const p = phone();
  await p.store.boot();
  const t = p.store.addExpense(draft());
  const id = idOf(p.store);
  await p.store.idle();
  p.net.lose.add("undo");
  p.store.undo(t);
  await p.store.idle();
  assert.equal(p.store.state.expenses.find((e) => e.id === id && !e.deleted), undefined);
  assert.equal(queueOf(p.storage)[0].undo, true);
  p.net.lose.clear();
  await p.store.checkRev();
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, id).deleted, true);
  assert.deepEqual((await backend(p.fake, "history")).entries.map((e) => e.action), ["undo", "add"]);
  assert.equal(byId(p.store.state.expenses, id).deleted, true);
  assert.equal(p.store.state.notice, null);
  assert.deepEqual(queueOf(p.storage), []);
});

test("a reload between an undo and its add's reply still ends with the line undone", async () => {
  const one = phone();
  await one.store.boot();
  one.net.hold("addExpense"); // the backend has it, the reply never arrives before the reload
  const t = one.store.addExpense(draft());
  const id = idOf(one.store);
  one.store.undo(t);
  assert.deepEqual(queueOf(one.storage).map((q) => [q.undo, q.args.expense.id]), [[true, id]]);

  const two = phone({ fake: one.fake, storage: one.storage });
  await two.store.boot();
  await two.store.idle();
  assert.equal(byId((await backend(two.fake)).expenses, id).deleted, true);
  assert.deepEqual((await backend(two.fake, "history")).entries.map((e) => e.action), ["undo", "add"]);
  assert.equal(byId(two.store.state.expenses, id).deleted, true);
  assert.equal("pending" in byId(two.store.state.expenses, id), false);
  assert.deepEqual(queueOf(two.storage), []);
});

test("a reload while an undone add waits offline finishes it on the next contact", async () => {
  const one = phone();
  await one.store.boot();
  one.net.lose.add("addExpense");
  const t = one.store.addExpense(draft());
  const id = idOf(one.store);
  one.store.undo(t);
  await one.store.idle();
  const two = phone({ fake: one.fake, storage: one.storage });
  two.net.offline = true;
  await two.store.boot();
  assert.equal(two.store.state.expenses.find((e) => e.id === id && !e.deleted), undefined);
  two.net.offline = false;
  await two.store.checkRev();
  await two.store.idle();
  assert.equal(byId((await backend(two.fake)).expenses, id).deleted, true);
  assert.deepEqual((await backend(two.fake, "history")).entries.map((e) => e.action), ["undo", "add"]);
  assert.deepEqual(queueOf(two.storage), []);
});

test("an undone add whose reply came back garbled is finished on the next contact: add then undo", async () => {
  const p = phone();
  await p.store.boot();
  p.net.garble.add("addExpense"); // the backend saved it, the reply is an error page
  const t = p.store.addExpense(draft());
  const id = idOf(p.store);
  p.store.undo(t);
  await p.store.idle();
  assert.equal(p.store.state.expenses.find((e) => e.id === id && !e.deleted), undefined);
  assert.deepEqual(queueOf(p.storage).map((q) => [q.undo, q.args.expense.id]), [[true, id]]);
  p.net.garble.clear();
  await p.store.checkRev();
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, id).deleted, true);
  assert.deepEqual((await backend(p.fake, "history")).entries.map((e) => e.action), ["undo", "add"]);
  await p.store.refresh();
  assert.equal(byId(p.store.state.expenses, id).deleted, true);
  assert.equal(p.store.state.notice, null);
  assert.deepEqual(queueOf(p.storage), []);
});

test("an add whose reply came back garbled stays queued and is resent once, not marked failed", async () => {
  const p = phone();
  await p.store.boot();
  p.net.garble.add("addExpense");
  p.store.addExpense(draft());
  const id = idOf(p.store);
  await p.store.idle();
  const line = byId(p.store.state.expenses, id);
  assert.equal(line.pending, true);
  assert.equal("failed" in line, false);
  assert.deepEqual(queueOf(p.storage).map((q) => [q.expense.id, q.failed, q.sent]), [[id, false, true]]);
  p.net.garble.clear();
  await p.store.checkRev();
  await p.store.idle();
  await p.store.checkRev();
  await p.store.idle();
  assert.equal(sent(p.fake, "addExpense"), 2); // the garbled one and one resend
  const server = (await backend(p.fake)).expenses;
  assert.equal(server.filter((e) => e.id === id).length, 1);
  assert.deepEqual((await backend(p.fake, "history")).entries.map((e) => e.action), ["add"]);
  assert.deepEqual(byId(p.store.state.expenses, id), byId(server, id));
  assert.deepEqual(queueOf(p.storage), []);
});

test("an undo whose reply came back garbled is finished without a second undo", async () => {
  const p = phone();
  await p.store.boot();
  const t = p.store.addExpense(draft());
  const id = idOf(p.store);
  await p.store.idle();
  p.net.garble.add("undo");
  p.store.undo(t);
  await p.store.idle();
  assert.equal(p.store.state.expenses.find((e) => e.id === id && !e.deleted), undefined);
  p.net.garble.clear();
  await p.store.checkRev();
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, id).deleted, true);
  assert.deepEqual((await backend(p.fake, "history")).entries.map((e) => e.action), ["undo", "add"]);
  assert.equal(p.store.state.notice, null);
  assert.deepEqual(queueOf(p.storage), []);
});

test("an undone add that the backend refuses is dropped with nothing more sent", async () => {
  const p = phone();
  await p.store.boot();
  p.net.override = (body) => (body.action === "addExpense" ? { ok: false, error: "bad_input", message: "Pick a day." } : null);
  const t = p.store.addExpense(draft());
  const id = idOf(p.store);
  p.store.undo(t);
  await p.store.idle();
  p.net.override = null;
  await p.store.checkRev();
  await p.store.flush();
  await p.store.idle();
  assert.equal(p.net.sent.filter((b) => b.action === "addExpense").length, 1);
  assert.equal(p.net.sent.filter((b) => b.action === "undo").length, 0);
  assert.equal(byId(p.store.state.expenses, id), undefined);
  assert.deepEqual(queueOf(p.storage), []);
});

test("an undone stamp whose reply was lost is finished the same way", async () => {
  const p = phone();
  await p.store.boot();
  p.net.lose.add("addPayment");
  const t = p.store.addPayment({ from: "Ajen", to: "Mo", cad: 25 });
  const id = idOf(p.store);
  p.store.undo(t);
  await p.store.idle();
  p.net.lose.clear();
  await p.store.checkRev();
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).payments, id).removed, true);
  assert.deepEqual((await backend(p.fake, "history")).entries.map((e) => e.action), ["undo", "stamp"]);
});

test("Undo right after a write", async () => {
  const p = phone();
  await p.store.boot();
  const t = p.store.addExpense(draft());
  const id = idOf(p.store);
  assert.deepEqual(queueOf(p.storage).map((q) => q.expense.id), [id]); // kept until the backend has it
  p.store.undo(t);
  // its request is out, so the undo is kept until the backend confirms it
  assert.deepEqual(queueOf(p.storage).map((q) => [q.undo, q.args.expense.id]), [[true, id]]);
  assert.equal(p.store.state.expenses.find((e) => e.id === id && !e.deleted), undefined);
  assert.equal(p.store.state.lastChange.action, "undo");
  assert.equal(p.store.state.lastChange.canUndo, false);
  await p.store.idle();
  const server = byId((await backend(p.fake)).expenses, id);
  assert.equal(server.deleted, true);
  const h = await backend(p.fake, "history");
  assert.deepEqual(h.entries.map((e) => e.action), ["undo", "add"]);
  assert.deepEqual(byId(p.store.state.expenses, id), server);
  assert.deepEqual(queueOf(p.storage), []);
});

test("Undo of an edit and of a delete", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  const t1 = p.store.updateExpense("seedexp004", { amount: 4500 });
  await p.store.idle();
  assert.equal(byId(p.store.state.expenses, "seedexp004").amount, 4500);
  p.store.undo(t1);
  assert.equal(byId(p.store.state.expenses, "seedexp004").amount, 4200);
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, "seedexp004").amount, 4200);
  assert.equal(byId(p.store.state.expenses, "seedexp004").amount, 4200);

  const t2 = p.store.deleteExpense("seedexp006");
  await p.store.idle();
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, true);
  p.store.undo(t2);
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, false);
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, "seedexp006").deleted, false);
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, false);
});

test("Undo of a stamp", async () => {
  const p = phone();
  await p.store.boot();
  const t = p.store.addPayment({ from: "Ajen", to: "Mo", cad: 25 });
  const id = idOf(p.store);
  await p.store.idle();
  p.store.undo(t);
  assert.equal(byId(p.store.state.payments, id).removed, true);
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).payments, id).removed, true);
  assert.equal(byId(p.store.state.payments, id).removed, true);
});

test("undo of an unknown or already undone token does nothing", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  const t = p.store.deleteExpense("seedexp006");
  await p.store.idle();
  await p.store.undo("no-such-token");
  await p.store.undo(t);
  await p.store.undo(t);
  await p.store.idle();
  assert.equal(sent(p.fake, "undo"), 1);
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, false);
});

test("A failed undo puts things back", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  const t = p.store.updateExpense("seedexp004", { amount: 4500 });
  await p.store.idle();
  p.net.failing.add("undo");
  p.store.undo(t);
  assert.equal(byId(p.store.state.expenses, "seedexp004").amount, 4200);
  await p.store.idle();
  assert.equal(byId(p.store.state.expenses, "seedexp004").amount, 4500);
  assert.equal(p.store.state.notice, UNDO_FAILED);
  assert.equal(p.store.state.online, false);
  assert.equal(byId((await backend(p.fake)).expenses, "seedexp004").amount, 4500);
});

test("Stale undo from history", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.store.updateExpense("seedexp004", { amount: 4500 });
  p.store.updateExpense("seedexp004", { amount: 4600 });
  await p.store.idle();
  await p.store.loadHistory();
  const edits = p.store.state.history.entries.filter((e) => e.ref === "seedexp004" && e.action === "edit");
  assert.equal(edits.length, 2);
  const older = edits[edits.length - 1];
  const before = JSON.parse(JSON.stringify(p.store.state.expenses));
  await p.store.undoEntry(older.id);
  assert.equal(p.store.state.notice, STALE);
  assert.deepEqual(p.store.state.expenses, before);
  assert.equal(byId((await backend(p.fake)).expenses, "seedexp004").amount, 4600);
});

test("a stale undo bar shows the notice and then what the backend has", async () => {
  const a = phone({ seed: SEED });
  const b = phone({ seed: SEED, fake: a.fake, storage: memStorage({ "mat.key": KEY, "mat.me": "Ajen" }) });
  await a.store.boot();
  await b.store.boot();
  await a.store.loadHistory();
  const t = a.store.updateExpense("seedexp004", { amount: 4500 });
  await a.store.idle();
  await b.store.refresh();
  b.store.updateExpense("seedexp004", { amount: 4600 });
  await b.store.idle();
  await a.store.undo(t);
  await a.store.idle();
  assert.equal(a.store.state.notice, STALE);
  const server = await backend(a.fake);
  assert.deepEqual(a.store.state.expenses, server.expenses);
  assert.equal(byId(a.store.state.expenses, "seedexp004").amount, 4600);
  const top = a.store.state.history.entries[0];
  assert.equal(top.ref, "seedexp004");
  assert.equal(top.who, "Ajen");
  assert.equal(top.action, "edit");
});

test("a stale undo from history shows the notice, then the backend's data and a fresh tape", async () => {
  const a = phone({ seed: SEED });
  const b = phone({ seed: SEED, fake: a.fake, storage: memStorage({ "mat.key": KEY, "mat.me": "Ajen" }) });
  await a.store.boot();
  await b.store.boot();
  a.store.updateExpense("seedexp004", { amount: 4500 });
  await a.store.idle();
  await a.store.loadHistory();
  const mine = a.store.state.history.entries[0];
  assert.equal(mine.canUndo, true);
  await b.store.refresh();
  b.store.updateExpense("seedexp004", { amount: 4600 });
  await b.store.idle();
  const ok = await a.store.undoEntry(mine.id);
  assert.equal(ok, false);
  assert.equal(a.store.state.notice, STALE);
  assert.deepEqual(a.store.state.expenses, (await backend(a.fake)).expenses);
  assert.equal(a.store.state.history.entries[0].who, "Ajen");
  assert.equal(a.store.state.history.entries.find((e) => e.id === mine.id).canUndo, false);
});

test("undoEntry undoes a history entry and updates the tape", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  await p.store.loadHistory();
  const del = p.store.state.history.entries.find((e) => e.ref === "seedexp005" && e.action === "delete");
  assert.equal(del.canUndo, true);
  await p.store.undoEntry(del.id);
  assert.equal(byId(p.store.state.expenses, "seedexp005").deleted, false);
  assert.equal(p.store.state.lastChange.action, "undo");
  assert.equal(p.store.state.lastChange.canUndo, false);
  const top = p.store.state.history.entries[0];
  assert.equal(top.action, "undo");
  assert.equal(top.undoes, del.id);
  assert.equal(top.canUndo, true);
  const was = p.store.state.history.entries.find((e) => e.id === del.id);
  assert.equal(was.undoneBy, top.id);
  assert.equal(was.canUndo, false);
});

test("after an undo from History the tape is loaded again from the first page", async () => {
  const a = phone({ seed: SEED });
  const b = phone({ seed: SEED, fake: a.fake, storage: memStorage({ "mat.key": KEY, "mat.me": "Ajen" }) });
  await a.store.boot();
  await b.store.boot();
  await a.store.loadHistory();
  const del = a.store.state.history.entries.find((e) => e.ref === "seedexp005" && e.action === "delete");
  b.store.updateExpense("seedexp004", { amount: 4500 }); // another phone, after the tape was loaded
  await b.store.idle();
  const before = sent(a.fake, "history");
  await a.store.undoEntry(del.id);
  assert.equal(sent(a.fake, "history"), before + 1);
  const top = a.store.state.history.entries.slice(0, 2).map((e) => e.action + ":" + e.ref);
  assert.deepEqual(top, ["undo:seedexp005", "edit:seedexp004"]);
  assert.equal(a.store.state.history.entries.find((e) => e.id === del.id).undoneBy, a.store.state.history.entries.find((e) => e.action === "undo").id);
});

test("two overlapping first-page loads: the older request answering last never replaces the newer", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  const releaseA = p.net.hold("history");
  const a = p.store.loadHistory(); // reaches the backend now: sees ten entries
  await until(() => sent(p.fake, "history") === 1);
  await backend(p.fake, "updateExpense", { id: "seedexp004", patch: { amount: 4500 } });
  const releaseB = p.net.hold("history");
  const b = p.store.loadHistory(); // sees eleven
  await until(() => sent(p.fake, "history") === 2);
  releaseB();
  assert.equal((await b).entries.length, 11, "each load resolves with what it fetched");
  assert.equal(p.store.state.history.entries.length, 11);
  releaseA();
  const gotA = await a;
  assert.equal(gotA.entries.length, 10, "the older load still resolves with its own answer");
  assert.equal(gotA.error, null);
  assert.equal(p.store.state.history.entries.length, 11, "the older answer is dropped");
  assert.equal(p.store.state.history.entries[0].action, "edit");
  assert.equal(p.store.state.history.loading, false);
});

test("an older-page append is ignored when a first-page load started after it", async () => {
  const expenses = [];
  for (let i = 0; i < 205; i++) expenses.push({ id: "bulk" + String(i).padStart(6, "0"), day: "pre", title: "Line " + i, amount: 100, currency: "JPY", paidBy: "Mo", split: ALL.slice(), addedAt: new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString() });
  const p = phone({ seed: { expenses, payments: [] } });
  await p.store.boot();
  await p.store.loadHistory();
  assert.equal(p.store.state.history.entries.length, 200);
  const release = p.net.hold("history");
  const older = p.store.loadHistory({ older: true });
  await until(() => sent(p.fake, "history") === 2);
  await p.store.loadHistory(); // first page again, started after
  assert.equal(p.store.state.history.entries.length, 200);
  release();
  await older;
  assert.equal(p.store.state.history.entries.length, 200, "the append is not added to the new first page");
  assert.equal(p.store.state.history.more, true);
});

test("a failed History load says why: no connection, or any other trouble", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.failing.add("history");
  assert.deepEqual(await p.store.loadHistory(), { entries: [], more: false, error: "network" });
  assert.equal(p.store.state.history.error, "network");
  p.net.failing.clear();
  p.net.override = (body) => (body.action === "history" ? { ok: false, error: "server", message: "Boom" } : null);
  await p.store.loadHistory();
  assert.equal(p.store.state.history.error, "server");
  p.net.override = null;
  await p.store.loadHistory();
  assert.equal(p.store.state.history.error, null);
  assert.equal(p.store.state.history.entries.length, 10);
});

test("Busy is retried", async () => {
  const p = phone();
  await p.store.boot();
  let busy = 1;
  p.net.override = (body) => (body.action === "addExpense" && busy-- > 0 ? { ok: false, error: "busy", message: "Someone else is saving right now." } : null);
  p.store.addExpense(draft());
  const id = idOf(p.store);
  await p.store.idle();
  assert.equal((await backend(p.fake)).expenses.length, 1);
  const line = byId(p.store.state.expenses, id);
  assert.equal("failed" in line, false);
  assert.equal("pending" in line, false);
  assert.deepEqual(p.waits, [400]);
});

test("busy that never clears is tried four times and the line is marked failed", async () => {
  const p = phone();
  await p.store.boot();
  p.net.override = (body) => (body.action === "addExpense" ? { ok: false, error: "busy", message: "Someone else is saving right now." } : null);
  p.store.addExpense(draft());
  const id = idOf(p.store);
  await p.store.idle();
  assert.equal(p.net.sent.filter((b) => b.action === "addExpense").length, 4);
  assert.deepEqual(p.waits, [400, 400, 400]);
  assert.equal(byId(p.store.state.expenses, id).failed, true);
});

test("A refused write is marked, not dropped", async () => {
  const p = phone();
  await p.store.boot();
  p.net.override = (body) => (body.action === "addExpense" ? { ok: false, error: "bad_input", message: "Pick a day." } : null);
  p.store.addExpense(draft());
  const id = idOf(p.store);
  await p.store.idle();
  const line = byId(p.store.state.expenses, id);
  assert.equal(line.failed, true);
  assert.equal("pending" in line, false);
  assert.equal(line.title, "Dinner");
  assert.deepEqual(queueOf(p.storage).map((q) => [q.expense.id, q.failed]), [[id, true]]);
  // a failed line is not resent by flush
  p.net.override = null;
  await p.store.flush();
  assert.equal((await backend(p.fake)).expenses.length, 0);
});

test("retry resends a failed line with the same id", async () => {
  const p = phone();
  await p.store.boot();
  p.net.override = (body) => (body.action === "addExpense" ? { ok: false, error: "bad_input", message: "Pick a day." } : null);
  p.store.addExpense(draft());
  const id = idOf(p.store);
  await p.store.idle();
  assert.equal(byId(p.store.state.expenses, id).failed, true);
  p.net.override = null;
  p.store.retry(id);
  const line = byId(p.store.state.expenses, id);
  assert.equal(line.pending, true);
  assert.equal("failed" in line, false);
  await p.store.idle();
  const server = (await backend(p.fake)).expenses;
  assert.deepEqual(server.map((e) => e.id), [id]);
  assert.deepEqual(byId(p.store.state.expenses, id), server[0]);
  assert.deepEqual(queueOf(p.storage), []);
});

test("a refused edit is rolled back and its message shown", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.store.updateExpense("seedexp004", { splitMode: "exact", splitVals: [1, 2, 3] });
  await p.store.idle();
  const line = byId(p.store.state.expenses, "seedexp004");
  assert.equal(line.splitMode, "equal");
  assert.equal("pending" in line, false);
  assert.equal(typeof p.store.state.notice, "string");
});

test("Delete and restore roll back offline", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.offline = true;
  p.store.deleteExpense("seedexp006");
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, true);
  await p.store.idle();
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, false);
  assert.equal(p.store.state.online, false);
  p.store.restoreExpense("seedexp005");
  assert.equal(byId(p.store.state.expenses, "seedexp005").deleted, false);
  await p.store.idle();
  assert.equal(byId(p.store.state.expenses, "seedexp005").deleted, true);
  assert.deepEqual(queueOf(p.storage), []);
});

// ---------- reading ----------

test("checkRev only reloads on change", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  assert.equal(sent(p.fake, "load"), 1);
  await p.store.checkRev();
  await p.store.checkRev();
  assert.equal(sent(p.fake, "load"), 1);
  await backend(p.fake, "addExpense", { expense: { id: "other00001", ...draft({ title: "Their lunch", paidBy: "Ajen" }) } });
  await p.store.checkRev();
  assert.equal(sent(p.fake, "load"), 2);
  assert.equal(byId(p.store.state.expenses, "other00001").title, "Their lunch");
});

test("checkRev reloads when the rev goes down too", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  await backend(p.fake, "addExpense", { expense: { id: "other00001", ...draft() } });
  await p.store.checkRev();
  assert.equal(p.store.state.rev, 1);
  p.fake.props.REV = "0"; // settings reset on the backend
  await p.store.checkRev();
  assert.equal(sent(p.fake, "load"), 3);
  assert.equal(p.store.state.rev, 0);
});

test("own writes do not make checkRev reload, another phone's do", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.store.deleteExpense("seedexp006");
  await p.store.idle();
  await p.store.checkRev();
  assert.equal(sent(p.fake, "load"), 1);
  await backend(p.fake, "deleteExpense", { id: "seedexp004" });
  p.store.deleteExpense("seedexp003");
  await p.store.idle();
  await p.store.checkRev();
  assert.equal(sent(p.fake, "load"), 2);
  assert.equal(byId(p.store.state.expenses, "seedexp004").deleted, true);
});

test("a load sent before a write settled does not wipe the write", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  const release = p.net.hold("load");
  const refreshing = p.store.refresh(); // backend answers now, reply held
  await new Promise((r) => setTimeout(r, 0));
  p.store.addExpense(draft());
  const id = idOf(p.store);
  p.store.deleteExpense("seedexp006");
  await p.store.idle();
  assert.equal(byId(p.store.state.expenses, id).title, "Dinner");
  release();
  await refreshing;
  const line = byId(p.store.state.expenses, id);
  assert.ok(line, "the new line survives the older load");
  assert.equal("pending" in line, false);
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, true);
  // and the next load agrees with it
  await p.store.refresh();
  assert.equal(byId(p.store.state.expenses, id).title, "Dinner");
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, true);
});

test("an older load landing after a newer one is ignored", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  const release = p.net.hold("load");
  const first = p.store.refresh();
  await new Promise((r) => setTimeout(r, 0));
  await backend(p.fake, "addExpense", { expense: { id: "other00001", ...draft({ title: "Their lunch" }) } });
  await p.store.refresh();
  assert.equal(byId(p.store.state.expenses, "other00001").title, "Their lunch");
  release();
  await first;
  assert.equal(byId(p.store.state.expenses, "other00001").title, "Their lunch");
  assert.equal(p.store.state.rev, 1);
});

test("refresh keeps lines that are still pending", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.failing.add("addExpense");
  p.store.addExpense(draft());
  const id = idOf(p.store);
  await p.store.idle();
  await p.store.refresh();
  assert.equal(byId(p.store.state.expenses, id).pending, true);
  assert.equal(p.store.state.expenses.length, 10);
});

test("Person settings", async () => {
  const one = phone();
  const two = phone({ fake: one.fake, storage: memStorage({ "mat.key": KEY, "mat.me": "Ajen" }) });
  await one.store.boot();
  await two.store.boot();
  const saving = one.store.setPerson("Mo", { simplify: false });
  assert.equal(one.store.state.people.find((x) => x.name === "Mo").simplify, false);
  await saving;
  assert.equal((await backend(one.fake)).people.find((x) => x.name === "Mo").simplify, false);
  assert.equal(one.store.state.people.find((x) => x.name === "Mo").simplify, false);
  assert.equal(two.store.state.people.find((x) => x.name === "Mo").simplify, true);
  await two.store.refresh();
  assert.equal(two.store.state.people.find((x) => x.name === "Mo").simplify, false);
});

test("a person setting with no signal is rolled back", async () => {
  const p = phone();
  await p.store.boot();
  p.net.offline = true;
  const saving = p.store.setPerson("Mo", { simplify: false });
  assert.equal(p.store.state.people.find((x) => x.name === "Mo").simplify, false);
  await saving;
  assert.equal(p.store.state.people.find((x) => x.name === "Mo").simplify, true);
  assert.equal(p.store.state.online, false);
});

test("History", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  const states = [];
  p.store.subscribe((s) => states.push(s.history.loading));
  await p.store.loadHistory();
  assert.equal(states[0], true);
  const h = p.store.state.history;
  assert.equal(h.loading, false);
  assert.equal(h.entries.length, 10);
  assert.equal(h.more, false);
  const ids = h.entries.map((e) => e.id);
  assert.deepEqual(ids, ids.slice().sort((a, b) => b - a));
  const five = await p.store.historyFor("seedexp005");
  assert.equal(five.length, 2);
  assert.deepEqual(five.map((e) => e.action), ["delete", "add"]);
  assert.ok(five.every((e) => e.ref === "seedexp005"));
});

test("loadHistory({ older: true }) appends the next page", async () => {
  const expenses = [];
  for (let i = 0; i < 205; i++) expenses.push({ id: "bulk" + String(i).padStart(6, "0"), day: "pre", title: "Line " + i, amount: 100, currency: "JPY", paidBy: "Mo", split: ALL.slice(), addedAt: new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString() });
  const p = phone({ seed: { expenses } });
  await p.store.boot();
  await p.store.loadHistory();
  assert.equal(p.store.state.history.entries.length, 200);
  assert.equal(p.store.state.history.more, true);
  await p.store.loadHistory({ older: true });
  assert.equal(p.store.state.history.entries.length, 205);
  assert.equal(p.store.state.history.more, false);
  assert.equal(new Set(p.store.state.history.entries.map((e) => e.id)).size, 205);
});

test("historyFor rejects with network when there is no signal", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.offline = true;
  const err = await p.store.historyFor("seedexp005").then(() => null, (e) => e);
  assert.equal(err.code, "network");
  assert.equal(p.store.state.online, false);
});

test("Seen", async () => {
  const p = phone();
  await p.store.boot();
  assert.equal(p.store.state.seenAt, null);
  p.store.markSeen();
  assert.equal(p.store.state.seenAt, NOW);
  assert.equal(p.storage.getItem("mat.seen"), String(NOW));
  const again = phone({ fake: p.fake, storage: p.storage });
  await again.store.boot();
  assert.equal(again.store.state.seenAt, NOW);
});

test("notify sets a notice and tells subscribers; clearNotice clears it", async () => {
  const p = phone();
  await p.store.boot();
  const notices = [];
  const off = p.store.subscribe((s) => notices.push(s.notice));
  p.store.notify("Link copied.");
  assert.equal(p.store.state.notice, "Link copied.");
  p.store.clearNotice();
  assert.equal(p.store.state.notice, null);
  assert.deepEqual(notices, ["Link copied.", null]);
  off();
  p.store.notify("again");
  assert.equal(notices.length, 2);
});

// ---------- discard ----------

test("discard of a queued line that never left the phone sends nothing, ever", async () => {
  const p = phone();
  await p.store.boot();
  p.net.offline = true;
  await p.store.refresh(); // the failed load is what tells the store there is no signal
  p.store.addExpense(draft());
  const id = idOf(p.store);
  await p.store.idle();
  assert.equal(byId(p.store.state.expenses, id).pending, true);
  assert.equal(p.net.sent.filter((b) => b.action === "addExpense").length, 0, "it never left the phone");
  const before = p.net.sent.filter((b) => b.action === "addExpense").length;
  assert.equal(p.store.discard(id), true);
  assert.equal(byId(p.store.state.expenses, id), undefined);
  assert.deepEqual(queueOf(p.storage), []);
  p.net.offline = false;
  await p.store.refresh();
  await p.store.idle();
  assert.equal(sent(p.fake, "addExpense"), 0, "no add reached the backend");
  assert.equal(p.net.sent.filter((b) => b.action === "addExpense").length, before, "none sent after it either");
  assert.equal(byId(p.store.state.expenses, id), undefined);
});

test("discard of a line the backend refused removes it and leaves nothing on the backend", async () => {
  const p = phone();
  await p.store.boot();
  p.net.override = (body) => (body.action === "addExpense" ? { ok: false, error: "bad_input", message: "Pick a day." } : null);
  p.store.addExpense(draft());
  const id = idOf(p.store);
  await p.store.idle();
  assert.equal(byId(p.store.state.expenses, id).failed, true);
  assert.equal(p.store.discard(id), true);
  await p.store.idle();
  assert.equal(byId(p.store.state.expenses, id), undefined);
  assert.deepEqual(queueOf(p.storage), []);
  p.net.override = null;
  await p.store.refresh();
  assert.equal(byId(p.store.state.expenses, id), undefined);
  assert.equal(byId((await backend(p.fake)).expenses, id), undefined);
});

test("discard of a line whose reply was lost is resolved as add then undo on the next contact", async () => {
  const p = phone();
  await p.store.boot();
  p.net.lose.add("addExpense");
  p.store.addExpense(draft());
  const id = idOf(p.store);
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, id).deleted, false, "it did reach the backend");
  p.net.lose.clear();
  assert.equal(p.store.discard(id), true);
  const goneFromReceipt = () => { const l = byId(p.store.state.expenses, id); return !l || l.deleted === true; };
  assert.equal(goneFromReceipt(), true, "gone from the receipt at once");
  await p.store.idle();
  await p.store.refresh();
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, id).deleted, true);
  assert.equal(goneFromReceipt(), true, "gone from the receipt");
});

test("discard does nothing for a confirmed line", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  const line = p.store.state.expenses[0];
  assert.equal(p.store.discard(line.id), false);
  assert.equal(p.store.discard("nosuchid1"), false);
  p.store.addExpense(draft());
  const id = idOf(p.store);
  assert.equal(p.store.unsaved(id), true, "still on its way");
  await p.store.idle();
  assert.equal(p.store.unsaved(id), false);
  p.store.updateExpense(id, { note: "x" });
  assert.equal(p.store.unsaved(id), false, "an edit of a confirmed line is not an unsaved line");
  assert.equal(p.store.discard(id), false, "a line the backend has confirmed");
  assert.equal(byId(p.store.state.expenses, id).deleted, false);
});

test("discard says Undone. on the undo bar instead of leaving a dead Undo", async () => {
  const p = phone();
  await p.store.boot();
  p.net.override = (body) => (body.action === "addExpense" ? { ok: false, error: "bad_input", message: "Pick a day." } : null);
  p.store.addExpense(draft());
  const id = idOf(p.store);
  await p.store.idle();
  assert.equal(p.store.state.lastChange.action, "add");
  assert.equal(p.store.discard(id), true);
  const lc = p.store.state.lastChange;
  assert.equal(lc.action, "undo");
  assert.equal(lc.canUndo, false);
  assert.equal(lc.item.id, id);
});

test("discard while the add is in flight: the backend ends with it deleted, add and undo in its history, and none on the phone", async () => {
  const p = phone();
  await p.store.boot();
  const release = p.net.hold("addExpense"); // the backend takes the add; the reply waits
  p.store.addExpense(draft());
  const id = idOf(p.store);
  await until(() => p.net.sent.some((b) => b.action === "addExpense"));
  assert.equal(p.store.discard(id), true);
  release();
  await p.store.idle();
  const data = await backend(p.fake);
  assert.equal(byId(data.expenses, id).deleted, true);
  const h = await backend(p.fake, "history", { ref: id });
  const actions = h.entries.map((e) => e.action);
  assert.ok(actions.includes("add") && actions.includes("undo"), "history: " + actions);
  const l = byId(p.store.state.expenses, id);
  assert.equal(!l || l.deleted === true, true);
  assert.deepEqual(queueOf(p.storage), []);
});

// ---------- boundaries ----------

test("js modules reach the outside world only through their arguments", () => {
  const src = fs.readFileSync(path.join(HERE, "..", "js", "store.js"), "utf8");
  for (const word of ["window", "document", "localStorage", "navigator"]) {
    assert.equal(new RegExp("\\b" + word + "\\b").test(src), false, "store.js mentions " + word);
  }
  for (const f of ["store.js", "api.js", "time.js"]) {
    const s = fs.readFileSync(path.join(HERE, "..", "js", f), "utf8");
    assert.equal(/from\s+["'][^"']*(backend|tests)\//.test(s), false, f + " imports backend/ or tests/");
  }
});

test("outbox counts lines not yet on the backend: sending or waiting, never refused ones", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  assert.deepEqual(p.store.outbox(), { unsent: 0, waiting: 0 });
  const draft = (title) => ({ day: "2026-12-11", title, amount: 500, currency: "JPY", paidBy: "Mo", split: ALL.slice() });

  const release = p.net.hold("addExpense");
  p.store.addExpense(draft("Sending"));
  assert.deepEqual(p.store.outbox(), { unsent: 1, waiting: 0 }, "in flight: to send, not waiting");
  release();
  await p.store.idle();
  assert.deepEqual(p.store.outbox(), { unsent: 0, waiting: 0 });

  p.net.offline = true;
  await p.store.checkRev();
  p.store.addExpense(draft("One"));
  p.store.addExpense(draft("Two"));
  await p.store.idle();
  assert.deepEqual(p.store.outbox(), { unsent: 2, waiting: 2 });

  p.net.offline = false;
  p.net.override = (body) => (body.action === "addExpense" ? { ok: false, error: "bad_input", message: "No" } : null);
  await p.store.flush();
  await p.store.idle();
  assert.deepEqual(p.store.outbox(), { unsent: 0, waiting: 0 }, "refused lines are not counted");
});

// ---------- fix wave: a write whose reply is lost (F1, F2, F11) ----------

const UNCONFIRMED = "Couldn’t confirm that. Checking…";
const NOT_SAVED = "No signal. That wasn’t saved.";
const LODGE = { expenses: [{ id: "exp00001", day: "pre", title: "Lodge", amount: 300, currency: "CAD", paidBy: "Mo", split: ["Mo", "Ajen"] }] };

test("a stamp whose reply is lost stays on the slip and is resent with the same id: one payment, and a later stamp makes a second", async () => {
  const p = phone({ seed: LODGE, me: "Ajen" });
  await p.store.boot();
  p.net.lose.add("addPayment");
  p.store.addPayment({ from: "Ajen", to: "Mo", cad: 150 });
  const id = idOf(p.store);
  await p.store.idle();
  assert.equal(p.fake.tables.Settlements.length, 1, "it reached the backend");
  assert.notEqual(p.store.state.notice, NOT_SAVED, "never told it was not saved");
  const shown = p.store.state.payments;
  assert.deepEqual(shown.map((x) => [x.id, x.pending]), [[id, true]], "still on the slip, drawn as pending");

  p.net.lose.clear();
  await p.store.checkRev();
  await p.store.idle();
  assert.equal(p.fake.tables.Settlements.length, 1, "the resend is answered with the first one");
  assert.deepEqual(p.net.sent.filter((b) => b.action === "addPayment").map((b) => b.args.payment.id), [id, id]);
  assert.deepEqual(p.store.state.payments.map((x) => [x.id, "pending" in x]), [[id, false]]);

  p.store.addPayment({ from: "Ajen", to: "Mo", cad: 10 });
  await p.store.idle();
  assert.equal(p.fake.tables.Settlements.length, 2, "a second, not a third");
  assert.equal(p.store.state.payments.length, 2);
});

test("a second stamp while one is of unknown fate: each tap is one payment with its own id", async () => {
  const p = phone({ seed: LODGE, me: "Ajen" });
  await p.store.boot();
  p.net.lose.add("addPayment");
  p.store.addPayment({ from: "Ajen", to: "Mo", cad: 100 });
  await p.store.idle();
  p.net.lose.clear();
  p.net.offline = true;
  p.store.addPayment({ from: "Ajen", to: "Mo", cad: 50 });
  await p.store.idle();
  assert.equal(p.store.state.payments.length, 2);
  p.net.offline = false;
  await p.store.checkRev();
  await p.store.idle();
  assert.deepEqual(p.fake.tables.Settlements.map((r) => Number(r.cad)).sort((a, b) => a - b), [50, 100]);
  assert.equal(new Set(p.fake.tables.Settlements.map((r) => r.id)).size, 2);
  assert.equal(p.store.state.payments.filter((x) => !x.pending).length, 2);
});

test("a delete whose reply is lost: not called unsaved, shown deleted after contact, and Undo really restores it", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.lose.add("deleteExpense");
  const t = p.store.deleteExpense("seedexp006");
  await p.store.idle();
  assert.equal(p.store.state.notice, UNCONFIRMED);
  p.net.lose.clear();
  await p.store.checkRev();
  await p.store.idle();
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, true, "the backend has it deleted, so the phone shows that");
  await p.store.undo(t);
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, "seedexp006").deleted, false, "really restored");
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, false);
  assert.equal(p.store.state.lastChange.action, "undo");
  assert.deepEqual((await backend(p.fake, "history", { ref: "seedexp006" })).entries.map((e) => e.action).slice(0, 2), ["undo", "delete"]);
});

test("the next contact of any kind brings the backend's view after an unconfirmed write", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.lose.add("deleteExpense");
  p.store.deleteExpense("seedexp006");
  await p.store.idle();
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, false, "rolled back meanwhile");
  p.net.lose.clear();
  const loads = sent(p.fake, "load");
  p.store.updateExpense("seedexp004", { note: "x" }); // a write is contact too
  await p.store.idle();
  assert.equal(sent(p.fake, "load"), loads + 1);
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, true);
});

test("a delete repeated after a lost reply, then Undo: never Undone. while nothing happens", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.lose.add("deleteExpense");
  p.store.deleteExpense("seedexp006");
  await p.store.idle();
  p.net.lose.clear();
  const t = p.store.deleteExpense("seedexp006"); // the backend already has it: no log id
  await p.store.idle();
  await p.store.undo(t);
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, "seedexp006").deleted, false);
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, false);
  assert.equal(p.store.state.lastChange.action, "undo");
});

test("Undo of an unconfirmed change that another phone has changed since says it could not", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.lose.add("updateExpense");
  const t = p.store.updateExpense("seedexp004", { title: "Ramen bar" });
  await p.store.idle();
  assert.equal(p.store.state.notice, UNCONFIRMED);
  assert.equal(byId(p.store.state.expenses, "seedexp004").title, "Ramen", "rolled back meanwhile");
  p.net.lose.clear();
  await backend(p.fake, "updateExpense", { id: "seedexp004", patch: { amount: 5000 } });
  p.store.clearNotice();
  await p.store.undo(t);
  await p.store.idle();
  assert.equal(p.store.state.notice, UNDO_FAILED);
  const server = byId((await backend(p.fake)).expenses, "seedexp004");
  assert.deepEqual([server.title, server.amount], ["Ramen bar", 5000], "nothing overwritten");
  assert.deepEqual([byId(p.store.state.expenses, "seedexp004").title, byId(p.store.state.expenses, "seedexp004").amount], ["Ramen bar", 5000]);
  assert.equal(sent(p.fake, "undo"), 0);
});

test("an edit whose reply is lost: shown after contact, and Undo takes it back", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.lose.add("updateExpense");
  const t = p.store.updateExpense("seedexp004", { amount: 4500 });
  await p.store.idle();
  assert.equal(p.store.state.notice, UNCONFIRMED);
  assert.equal(byId(p.store.state.expenses, "seedexp004").amount, 4200);
  p.net.lose.clear();
  p.store.clearNotice();
  // Undo before any contact: it waits for the backend's answer, then undoes.
  await p.store.undo(t);
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, "seedexp004").amount, 4200);
  assert.equal(byId(p.store.state.expenses, "seedexp004").amount, 4200);
  assert.equal(p.store.state.lastChange.action, "undo");
  assert.equal(p.store.state.notice, null);
});

test("Undo of an unconfirmed change with still no signal waits, and finishes on the next contact", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.lose.add("deleteExpense");
  const t = p.store.deleteExpense("seedexp006");
  await p.store.idle();
  p.net.lose.clear();
  p.net.offline = true;
  const before = p.store.state.lastChange.token;
  await p.store.undo(t);
  await p.store.idle();
  assert.equal(p.store.state.lastChange.token, before, "no Undone. while nothing has happened");
  p.net.offline = false;
  await p.store.checkRev();
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, "seedexp006").deleted, false);
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, false);
  assert.equal(p.store.state.lastChange.action, "undo");
});

test("an unconfirmed change that never landed: Undo leaves it as it was and sends no undo", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.failing.add("deleteExpense"); // fails before reaching the backend, but the phone cannot know that
  const t = p.store.deleteExpense("seedexp006");
  await p.store.idle();
  assert.equal(p.store.state.notice, UNCONFIRMED);
  p.net.failing.clear();
  await p.store.undo(t);
  await p.store.idle();
  assert.equal(sent(p.fake, "undo"), 0);
  assert.equal(byId((await backend(p.fake)).expenses, "seedexp006").deleted, false);
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, false);
});

test("a person setting whose reply is lost says it is checking and shows the backend after contact", async () => {
  const p = phone();
  await p.store.boot();
  p.net.lose.add("setPerson");
  await p.store.setPerson("Mo", { simplify: false });
  assert.equal(p.store.state.notice, UNCONFIRMED);
  assert.equal(p.store.state.people.find((x) => x.name === "Mo").simplify, true, "rolled back meanwhile");
  p.net.lose.clear();
  await p.store.checkRev();
  await p.store.idle();
  assert.equal(p.store.state.people.find((x) => x.name === "Mo").simplify, false);
});

test("when the phone itself knows it has no network, a change is not sent and is said not saved", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.knownOffline = true;
  const before = p.net.sent.length;
  p.store.deleteExpense("seedexp006");
  await p.store.idle();
  assert.equal(p.store.state.notice, NOT_SAVED);
  assert.equal(p.net.sent.length, before, "nothing left the phone");
  assert.equal(byId(p.store.state.expenses, "seedexp006").deleted, false);
  await p.store.setPerson("Mo", { simplify: false });
  assert.equal(p.store.state.notice, NOT_SAVED);
});

test("a line rung up while the phone knows it is offline is kept and provably never left: undo forgets it", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.knownOffline = true;
  const t = p.store.addExpense(draft());
  await p.store.idle();
  assert.equal(p.store.outbox().waiting, 1);
  p.store.undo(t);
  p.net.knownOffline = false;
  await p.store.checkRev();
  await p.store.idle();
  assert.equal(sent(p.fake, "addExpense"), 0);
  assert.deepEqual(queueOf(p.storage), []);
});

test("rev is not stepped for a resent add: another phone's line written in between is shown (E3)", async () => {
  const fake = createFakeBackend({});
  let adds = 0;
  const wrapped = async (body) => {
    if (body.action === "addExpense" && ++adds === 2) {
      await fake({ key: KEY, actor: "Ajen", via: "app", action: "addExpense", args: { expense: { id: "bbbbbbbb1", day: "pre", title: "B line", amount: 5, currency: "CAD", paidBy: "Ajen", split: ALL } } });
    }
    return fake(body);
  };
  wrapped.tables = fake.tables;
  wrapped.requests = fake.requests;
  wrapped.props = fake.props;
  const a = phone({ fake: wrapped });
  await a.store.boot();
  a.net.lose.add("addExpense");
  a.store.addExpense({ day: "pre", title: "A1", amount: 10, currency: "CAD", paidBy: "Mo", split: ALL, note: "", kind: "" });
  await a.store.idle();
  a.net.lose.clear();
  await a.store.checkRev();
  await a.store.idle();
  await a.store.checkRev();
  await a.store.idle();
  assert.deepEqual(fake.tables.Expenses.map((r) => r.title).sort(), ["A1", "B line"]);
  assert.deepEqual(a.store.state.expenses.map((e) => e.title).sort(), ["A1", "B line"]);
  assert.equal(a.store.state.rev, Number(fake.props.REV));
});

test("a queued line is credited to whoever rang it up, even after the phone switches person", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.offline = true;
  p.store.addExpense(draft({ title: "Mo's taxi" }));
  const id = idOf(p.store);
  await p.store.idle();
  p.store.setMe("Ajen");
  p.net.offline = false;
  await p.store.checkRev();
  await p.store.idle();
  const row = p.fake.tables.Expenses.find((r) => r.id === id);
  assert.equal(row.added_by, "Mo");
  const log = p.fake.tables.Log.find((r) => r.ref === id && r.action === "add");
  assert.equal(log.who, "Mo");
});

test("a queued line restored from mat.queue after a reload is still credited to whoever rang it up", async () => {
  const first = phone({ seed: SEED });
  await first.store.boot();
  first.net.offline = true;
  first.store.addExpense(draft({ title: "Mo's taxi" }));
  const id = idOf(first.store);
  await first.store.idle();
  first.storage.setItem("mat.me", "Ajen");
  const p = phone({ fake: first.fake, storage: first.storage });
  await p.store.boot();
  await p.store.idle();
  assert.equal(p.fake.tables.Expenses.find((r) => r.id === id).added_by, "Mo");
});

test("api sends a per-request actor when given one, and the phone's own otherwise", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, rev: 1, data: {} }) };
  };
  const api = createApi({ url: URL, getKey: () => "k", getActor: () => "Ajen", fetchImpl });
  await api("addExpense", {}, { actor: "Mo" });
  await api("load", {});
  assert.deepEqual(bodies.map((b) => b.actor), ["Mo", "Ajen"]);
});

test("api refuses to send when the phone says it is offline, marked as never sent", async () => {
  let calls = 0;
  const api = createApi({ url: URL, getKey: () => "k", getActor: () => "Mo", fetchImpl: async () => { calls++; }, isOnline: () => false });
  const err = await api("load").then(() => null, (e) => e);
  assert.equal(err.code, "network");
  assert.equal(err.notSent, true);
  assert.equal(calls, 0);
});

// ---------- fix wave: a bad row in the Sheet (F3) ----------

const draw = (s) => {
  // what the slip does with the state: money.js is strict and throws on an unknown name
  if (!s.trip) return;
  const names = s.people.map((x) => x.name);
  direct(names, s.expenses.filter((e) => !e.deleted), s.payments);
  const bal = balances(names, s.expenses, s.payments);
  for (const n of names) if (!Number.isFinite(bal[n])) throw new Error("NaN balance for " + n);
};

test("emit: a subscriber that throws does not stop the others or the store", async () => {
  const p = phone({ seed: SEED });
  let others = 0;
  p.store.subscribe(() => { throw new Error("a broken view"); });
  p.store.subscribe(() => { others++; });
  await p.store.boot();
  assert.ok(others >= 2);
  assert.equal(p.store.state.status, "ready");
  assert.equal(sent(p.fake, "load"), 1);
});

test("a mistyped name in a split is set aside, and a phone reopened after the Sheet is fixed loads (H1, H2)", async () => {
  const fake = createFakeBackend(LODGE);
  fake.tables.Expenses[0].split = "Mo,Ajen,Trent";
  const a = phone({ fake });
  a.store.subscribe(draw);
  await a.store.boot();
  assert.deepEqual(a.store.state.expenses, []);
  assert.deepEqual(a.store.state.setAside, [{ kind: "expense", id: "exp00001", title: "Lodge", reason: "name" }]);

  fake.tables.Expenses[0].split = "Mo,Ajen,Trenton";
  const b = phone({ fake, storage: a.storage });
  b.store.subscribe(draw);
  const loads = sent(fake, "load");
  await b.store.boot();
  assert.equal(sent(fake, "load"), loads + 1, "the reopened phone loads");
  assert.deepEqual(b.store.state.expenses.map((e) => e.id), ["exp00001"]);
  assert.deepEqual(b.store.state.setAside, []);
});

test("even if painting the cache throws, boot still loads", async () => {
  const first = phone({ seed: SEED });
  await first.store.boot();
  const p = phone({ fake: first.fake, storage: first.storage });
  let calls = 0;
  p.store.subscribe(() => { if (++calls === 1) throw new Error("first paint"); });
  const loads = sent(p.fake, "load");
  await p.store.boot();
  assert.equal(sent(p.fake, "load"), loads + 1);
});

test("a mistyped payer is set aside, not counted as owing nobody (H3)", async () => {
  const fake = createFakeBackend(LODGE);
  fake.tables.Expenses[0].paid_by = "mo";
  const p = phone({ fake });
  p.store.subscribe(draw);
  await p.store.boot();
  assert.deepEqual(p.store.state.expenses, []);
  assert.deepEqual(p.store.state.setAside.map((x) => [x.id, x.reason]), [["exp00001", "name"]]);
});

test("a yen line with a blank rate is set aside (H4); a bad payment is set aside too", async () => {
  const fake = createFakeBackend({
    expenses: [{ id: "exp00002", day: "pre", title: "Taxi", amount: 3000, currency: "JPY", paidBy: "Mo", split: ALL }, { id: "exp00003", day: "pre", title: "Fine", amount: 30, currency: "CAD", paidBy: "Mo", split: ALL }],
    payments: [{ id: "pay000001", from: "Ajen", to: "Mo", cad: 5, seed: 1, rot: 0 }, { id: "pay000002", from: "Ajen", to: "Mo", cad: 5, seed: 1, rot: 0 }],
  });
  fake.tables.Expenses[0].rate = "";
  fake.tables.Settlements[1].to = "Moe";
  const p = phone({ fake });
  p.store.subscribe(draw);
  await p.store.boot();
  assert.deepEqual(p.store.state.expenses.map((e) => e.id), ["exp00003"]);
  assert.deepEqual(p.store.state.payments.map((x) => x.id), ["pay000001"]);
  assert.deepEqual(p.store.state.setAside, [
    { kind: "expense", id: "exp00002", title: "Taxi", reason: "amount" },
    { kind: "payment", id: "pay000002", title: "Ajen → Moe", reason: "name" },
  ]);
  for (const v of Object.values(balances(ALL, p.store.state.expenses, p.store.state.payments))) assert.ok(Number.isFinite(v));
});

test("an edit undone while its request is out, whose reply is then lost, is settled against the backend", async () => {
  const p = phone({ seed: SEED });
  await p.store.boot();
  p.net.lose.add("updateExpense");
  const t = p.store.updateExpense("seedexp004", { amount: 4500 });
  p.store.undo(t);
  await p.store.idle();
  p.net.lose.clear();
  await p.store.checkRev();
  await p.store.idle();
  assert.equal(byId((await backend(p.fake)).expenses, "seedexp004").amount, 4200, "the backend ends undone");
  const line = byId(p.store.state.expenses, "seedexp004");
  assert.equal(line.amount, 4200);
  assert.equal("pending" in line, false, "nothing left pending on the phone");
});
