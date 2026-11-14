// The app's state: painted from the last load at once, kept in step with the
// backend, with every change shown before the backend confirms it.
//
// How it holds together:
// - `base` is the backend's data as last known: the last load plus the saved
//   result of every write since.
// - `ops` are changes not yet confirmed (sending, queued without signal, or
//   refused). state.expenses/payments/people are `base` with `ops` laid over
//   it in order, each touched item flagged `pending` or `failed`.
// - Writes to the same item go out one at a time, in the order they were
//   made (a per-item chain), so an edit waits for its add and an undo waits
//   for the write it undoes.
// - Only adds of expenses are kept in mat.queue (from the moment they are
//   made until the backend has them) and resent later; any other write that
//   cannot reach the backend is rolled back.
//
// Everything outside comes in through createStore's arguments.

import { newId } from "./time.js";

const BUSY_RETRIES = 3;
const BUSY_DELAY_MS = 400;
const UNDO_FAILED = "Couldn't undo that. Try again from History.";
const NO_SIGNAL = "No signal. That wasn't saved.";
const STALE = "That was changed again since. Undo the newer change first.";

const DATA_KEYS = ["trip", "people", "days", "stops", "stays", "expenses", "payments", "rateToday", "sheetUrl"];
const LIST = { expense: "expenses", payment: "payments", person: "people" };
const KEY_FIELD = { expense: "id", payment: "id", person: "name" };
const FLAG = { expense: "deleted", payment: "removed" };

const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bare(item) {
  if (!item) return item;
  const out = { ...item };
  delete out.pending;
  delete out.failed;
  return out;
}

function isData(d) {
  return !!d && typeof d === "object" && Array.isArray(d.expenses) && Array.isArray(d.payments) && Array.isArray(d.people);
}

export function createStore({ api, storage, now = () => Date.now(), wait = defaultWait }) {
  // ---- storage, never allowed to throw ----
  const getItem = (k) => {
    try {
      const v = storage.getItem(k);
      return v === undefined ? null : v;
    } catch {
      return null;
    }
  };
  const setItem = (k, v) => {
    try {
      storage.setItem(k, v);
    } catch {
      // private mode or full: the app keeps working without it
    }
  };
  const getJson = (k) => {
    const raw = getItem(k);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const state = {
    status: "boot", online: true, rev: null, me: null,
    trip: null, people: [], days: [], stops: [], stays: [], expenses: [], payments: [], rateToday: null, sheetUrl: "",
    loadedAt: null, seenAt: null, lastChange: null, notice: null,
    history: { entries: [], more: false, loading: false },
  };

  const subs = new Set();
  let base = null;
  let myName = null;
  let ops = []; // unconfirmed changes, in the order they were made
  const writes = new Map(); // token -> write op, for undo(token)
  const chains = new Map(); // "kind:id" -> tail promise of that item's writes (never rejects)
  let settled = []; // { seq, kind, item } confirmed by a write, newest last
  let writeSeq = 0;
  let loadCount = 0;
  let appliedLoad = 0;
  let flushing = null;

  // ---- deriving and telling ----

  function emit() {
    for (const fn of [...subs]) fn(state);
  }

  function derive() {
    if (base) for (const k of DATA_KEYS) state[k] = base[k];
    const lists = {};
    for (const kind of Object.keys(LIST)) lists[kind] = base ? base[LIST[kind]].slice() : [];
    for (const op of ops) {
      const list = lists[op.kind];
      const field = KEY_FIELD[op.kind];
      const i = list.findIndex((x) => x[field] === op.id);
      const next = op.view(i >= 0 ? bare(list[i]) : null);
      if (!next) continue;
      const shown = bare(next);
      if (op.kind !== "person") {
        if (op.status === "failed") shown.failed = true;
        else shown.pending = true;
      }
      if (i >= 0) list[i] = shown;
      else list.push(shown);
    }
    state.expenses = lists.expense;
    state.payments = lists.payment;
    state.people = lists.person;
    state.me = myName && state.people.some((p) => p.name === myName) ? myName : null;
  }

  function changed() {
    derive();
    emit();
  }

  function find(kind, id) {
    return state[LIST[kind]].find((x) => x[KEY_FIELD[kind]] === id) || null;
  }

  // ---- persistence ----

  function saveCache() {
    if (!base) return;
    setItem("mat.cache", JSON.stringify({ data: base, rev: state.rev, loadedAt: state.loadedAt }));
  }

  function isQueuedAdd(op) {
    return op.kind === "expense" && op.action === "add" && !op.undone && ops.includes(op);
  }

  function saveQueue() {
    const queue = ops.filter(isQueuedAdd).map((op) => ({ expense: op.args.expense, failed: op.status === "failed" }));
    setItem("mat.queue", JSON.stringify(queue));
  }

  // ---- talking to the backend ----

  async function call(action, args) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await api(action, args);
        state.online = true;
        return r;
      } catch (err) {
        const code = err && err.code;
        if (code === "busy" && attempt < BUSY_RETRIES) {
          await wait(BUSY_DELAY_MS);
          continue;
        }
        if (code === "network") state.online = false;
        if (code === "bad_key") state.status = "nokey";
        throw err;
      }
    }
  }

  // Our own write moved the backend on by exactly one: keep rev in step so
  // checkRev does not reload for it. Anything else leaves rev for checkRev.
  function stepRev(rev) {
    if (typeof rev === "number" && typeof state.rev === "number" && rev === state.rev + 1) state.rev = rev;
  }

  function enqueue(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    const run = prev.then(fn);
    chains.set(key, run.catch(() => {}));
    return run;
  }

  const chainKey = (kind, id) => kind + ":" + id;

  function removeOp(op) {
    ops = ops.filter((o) => o !== op);
  }

  function putBase(kind, item) {
    if (!base) return;
    const list = base[LIST[kind]].slice();
    const field = KEY_FIELD[kind];
    const i = list.findIndex((x) => x[field] === item[field]);
    if (i >= 0) list[i] = item;
    else list.push(item);
    base = { ...base, [LIST[kind]]: list };
  }

  // A write's confirmed result: into base now, and kept so that a load sent
  // before it settled cannot wipe it.
  function confirm(kind, item) {
    writeSeq += 1;
    settled.push({ seq: writeSeq, kind, item: copy(item) });
    putBase(kind, copy(item));
  }

  // ---- reading ----

  async function refresh() {
    const startSeq = writeSeq;
    const mine = ++loadCount;
    let r;
    try {
      r = await call("load", {});
    } catch (err) {
      if (state.status !== "nokey") state.status = base ? "ready" : "error";
      changed();
      return false;
    }
    if (mine < appliedLoad) return true; // a newer load already landed
    appliedLoad = mine;
    const data = copy(r.data);
    base = data;
    for (const s of settled) if (s.seq > startSeq) putBase(s.kind, copy(s.item));
    settled = settled.filter((s) => s.seq > startSeq);
    state.rev = r.rev;
    state.loadedAt = now();
    state.status = "ready";
    saveCache();
    changed();
    return true;
  }

  async function checkRev() {
    let r;
    try {
      r = await call("rev", {});
    } catch {
      changed();
      return;
    }
    if (r.rev !== state.rev) await refresh();
    else changed();
  }

  async function boot() {
    const key = getItem("mat.key");
    myName = getItem("mat.me");
    const seen = Number(getItem("mat.seen"));
    state.seenAt = getItem("mat.seen") !== null && isFinite(seen) ? seen : null;
    if (!key) {
      state.status = "nokey";
      changed();
      return;
    }
    const cache = getJson("mat.cache");
    if (cache && typeof cache === "object" && isData(cache.data)) {
      base = cache.data;
      state.rev = typeof cache.rev === "number" ? cache.rev : null;
      state.loadedAt = typeof cache.loadedAt === "number" ? cache.loadedAt : null;
      state.status = "ready";
    }
    const queue = getJson("mat.queue");
    if (Array.isArray(queue)) {
      for (const q of queue) {
        if (!q || typeof q !== "object" || !q.expense || typeof q.expense.id !== "string") continue;
        if (ops.some((o) => o.kind === "expense" && o.id === q.expense.id)) continue;
        const op = addOp(q.expense, q.expense.addedBy || myName);
        op.status = q.failed ? "failed" : "queued";
        ops.push(op);
      }
    }
    changed();
    if (await refresh()) await flush();
  }

  // ---- writes ----

  // op: { token, kind, id, action, api, args, before, after, view, status, undone, logId }
  function addOp(expense, addedBy) {
    const after = {
      ...copy(expense),
      rate: base ? base.rateToday : state.rateToday,
      addedBy: addedBy || null,
      addedAt: new Date(now()).toISOString(),
      deleted: false,
    };
    return {
      token: newId(), kind: "expense", id: expense.id, action: "add", api: "addExpense",
      args: { expense: copy(expense) }, before: null, after,
      view: (cur) => ({ ...(cur || {}), ...after }),
      status: "sending", undone: false, logId: null,
    };
  }

  function begin(op) {
    writes.set(op.token, op);
    ops.push(op);
    state.lastChange = { token: op.token, action: op.action, kind: op.kind, item: bare(op.after), canUndo: true };
    if (op.action === "edit") state.lastChange.before = bare(op.before);
    if (isQueuedAdd(op)) saveQueue();
    changed();
    send(op);
    return op.token;
  }

  function send(op) {
    return enqueue(chainKey(op.kind, op.id), () => runWrite(op));
  }

  async function runWrite(op) {
    if (op.undone && op.status === "queued") return; // undone before it was sent: never send it
    op.status = "sending";
    try {
      const r = await call(op.api, op.args);
      const item = r.data[op.kind];
      op.logId = r.data.logId === undefined ? null : r.data.logId;
      removeOp(op);
      confirm(op.kind, item);
      if (op.logId !== null) stepRev(r.rev);
      const lc = state.lastChange;
      if (lc && lc.token === op.token) state.lastChange = { ...lc, item: copy(item) };
    } catch (err) {
      op.logId = null;
      const code = err && err.code;
      if (op.action === "add" && op.kind === "expense" && !op.undone) {
        op.status = code === "network" ? "queued" : "failed";
      } else {
        removeOp(op);
        if (!op.undone) state.notice = code === "network" ? NO_SIGNAL : (err && err.message) || NO_SIGNAL;
      }
    }
    if (op.kind === "expense" && op.action === "add") saveQueue();
    saveCache();
    changed();
  }

  function change(kind, id, action, apiAction, patch) {
    const before = find(kind, id);
    if (!before) return null;
    const after = { ...bare(before), ...patch };
    const args = action === "edit" ? { id, patch: copy(patch) } : { id };
    return begin({
      token: newId(), kind, id, action, api: apiAction, args,
      before: bare(before), after,
      view: (cur) => (cur ? { ...cur, ...patch } : null),
      status: "sending", undone: false, logId: null,
    });
  }

  function addExpense(draft) {
    const expense = { id: newId(), ...copy(draft) };
    return begin(addOp(expense, myName));
  }

  function addPayment({ from, to, cad }) {
    const rnd = new Uint32Array(2);
    globalThis.crypto.getRandomValues(rnd);
    const payment = {
      id: newId(), from, to, cad,
      seed: 1 + (rnd[0] % 999999),
      rot: (rnd[1] % 201) / 10 - 13, // -13.0 to 7.0
    };
    payment.rot = Math.round(payment.rot * 10) / 10;
    const after = { ...payment, stampedBy: myName, stampedAt: new Date(now()).toISOString(), removed: false };
    return begin({
      token: newId(), kind: "payment", id: payment.id, action: "stamp", api: "addPayment",
      args: { payment }, before: null, after,
      view: (cur) => ({ ...(cur || {}), ...after }),
      status: "sending", undone: false, logId: null,
    });
  }

  // What an item looks like once `op` is undone.
  function undoneView(op, cur) {
    if (!op.before) return { ...(cur || op.after), [FLAG[op.kind]]: true };
    return { ...(cur || {}), ...op.before };
  }

  function undo(token) {
    const op = writes.get(token);
    if (!op || op.undone) return Promise.resolve();
    op.undone = true;
    state.lastChange = { token: newId(), action: "undo", kind: op.kind, item: bare(undoneView(op, bare(find(op.kind, op.id)))), canUndo: false };
    if (op.status === "queued" || op.status === "failed") {
      // never reached the backend: forget it
      removeOp(op);
      saveQueue();
      changed();
      return Promise.resolve();
    }
    if (op.kind === "expense" && op.action === "add") saveQueue();
    const uop = { kind: op.kind, id: op.id, status: "sending", view: (cur) => undoneView(op, cur) };
    ops.push(uop);
    changed();
    return enqueue(chainKey(op.kind, op.id), async () => {
      if (op.logId === null) {
        // the write never landed, or changed nothing: nothing to undo
        removeOp(uop);
        changed();
        return;
      }
      try {
        const r = await call("undo", { logId: op.logId });
        removeOp(uop);
        confirm(op.kind, r.data[op.kind]);
        stepRev(r.rev);
        saveCache();
      } catch (err) {
        removeOp(uop);
        op.undone = false;
        const code = err && err.code;
        state.notice = code === "stale" || code === "not_found" ? err.message || STALE : UNDO_FAILED;
      }
      changed();
    });
  }

  function retry(id) {
    const op = ops.find((o) => o.kind === "expense" && o.action === "add" && o.id === id && o.status === "failed");
    if (!op) return Promise.resolve();
    op.status = "sending";
    saveQueue();
    changed();
    return send(op);
  }

  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      for (const op of ops.slice()) {
        if (!(op.kind === "expense" && op.action === "add" && op.status === "queued" && !op.undone)) continue;
        await send(op);
        if (op.status === "queued") break; // still no signal
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  async function setPerson(name, patch) {
    const before = find("person", name);
    if (!before) return false;
    const op = { kind: "person", id: name, status: "sending", view: (cur) => (cur ? { ...cur, ...patch } : null) };
    ops.push(op);
    changed();
    return enqueue(chainKey("person", name), async () => {
      let ok = false;
      try {
        const r = await call("setPerson", { name, patch: copy(patch) });
        confirm("person", r.data.person);
        if (Object.keys(patch).some((k) => before[k] !== patch[k])) stepRev(r.rev);
        saveCache();
        ok = true;
      } catch (err) {
        state.notice = err && err.code === "network" ? NO_SIGNAL : (err && err.message) || NO_SIGNAL;
      }
      removeOp(op);
      changed();
      return ok;
    });
  }

  // ---- history ----

  async function loadHistory({ older = false } = {}) {
    const h = state.history;
    if (older && (!h.more || !h.entries.length)) return;
    state.history = { ...h, loading: true };
    emit();
    const args = older ? { before: h.entries[h.entries.length - 1].id } : {};
    try {
      const r = await call("history", args);
      state.history = { entries: older ? h.entries.concat(r.data.entries) : r.data.entries, more: !!r.data.more, loading: false };
    } catch {
      state.history = { ...state.history, loading: false };
    }
    changed();
  }

  async function historyFor(ref) {
    try {
      const r = await call("history", { ref });
      return r.data.entries;
    } finally {
      changed();
    }
  }

  function undoEntry(logId) {
    const entry = state.history.entries.find((e) => e.id === logId);
    const key = entry ? chainKey(entry.kind, entry.ref) : "log:" + logId;
    return enqueue(key, async () => {
      let r;
      try {
        r = await call("undo", { logId });
      } catch (err) {
        const code = err && err.code;
        state.notice = code === "stale" || code === "not_found" ? err.message || STALE : UNDO_FAILED;
        changed();
        return false;
      }
      const kind = r.data.expense ? "expense" : "payment";
      const item = r.data[kind];
      confirm(kind, item);
      stepRev(r.rev);
      saveCache();
      state.lastChange = { token: newId(), action: "undo", kind, item: copy(item), canUndo: false };
      const top = r.data.entry;
      const rest = state.history.entries.map((e) => {
        if (e.id === logId) return { ...e, undoneBy: r.data.logId, canUndo: false };
        if (e.kind === kind && e.ref === item.id) return { ...e, canUndo: false };
        return e;
      });
      state.history = { ...state.history, entries: top ? [top, ...rest] : rest };
      changed();
      return true;
    });
  }

  // ---- small settings ----

  function setMe(name) {
    myName = name;
    setItem("mat.me", name);
    changed();
  }

  function markSeen() {
    state.seenAt = now();
    setItem("mat.seen", String(state.seenAt));
    emit();
  }

  function notify(text) {
    state.notice = text;
    emit();
  }

  function clearNotice() {
    state.notice = null;
    emit();
  }

  // Resolves once every write and undo started so far has settled.
  async function idle() {
    for (;;) {
      const pending = [...chains.values(), flushing].filter(Boolean);
      await Promise.all(pending);
      const after = [...chains.values(), flushing].filter(Boolean);
      if (after.length === pending.length && after.every((p, i) => p === pending[i])) return;
    }
  }

  return {
    state,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    boot, refresh, checkRev, flush, idle,
    setMe, setPerson, markSeen, notify, clearNotice,
    addExpense,
    updateExpense: (id, patch) => change("expense", id, "edit", "updateExpense", patch),
    deleteExpense: (id) => change("expense", id, "delete", "deleteExpense", { deleted: true }),
    restoreExpense: (id) => change("expense", id, "restore", "restoreExpense", { deleted: false }),
    addPayment,
    removePayment: (id) => change("payment", id, "unstamp", "removePayment", { removed: true }),
    restorePayment: (id) => change("payment", id, "restamp", "restorePayment", { removed: false }),
    retry, undo, undoEntry, loadHistory, historyFor,
  };
}
