// The app's state: painted from the last load at once, kept in step with the
// backend, with every change shown before the backend confirms it.
//
// How it holds together:
// - `base` is the backend's data as last known: the last load plus the saved
//   result of every write since.
// - `ops` are changes not yet confirmed (sending, queued without signal,
//   refused, or an undo on its way). state.expenses/payments/people are
//   `base` with `ops` laid over it in order, each touched item flagged
//   `pending` or `failed`.
// - Writes to the same item go out one at a time, in the order they were
//   made (a per-item chain), so an edit waits for its add and an undo waits
//   for the write it undoes. A write whose item has nothing in flight starts
//   at once.
// - Adds of expenses are kept in mat.queue from the moment they are made
//   until the backend has them, and resent on the next contact. A stamp whose
//   reply never came is kept too (in memory only: a reload fetches the truth)
//   and resent with the same id on the next contact. (A stop add is not
//   queued: stop writes need a connection.) Any other write that
//   gets no reply is rolled back, said to be unconfirmed, and the next contact
//   reloads, so the screen shows whatever the backend holds. Only a write the
//   phone knows never left (it said it had no network) is said not saved.
// - An Undo of a write whose fate was unknown (or whose reply said it changed
//   nothing, because an earlier unconfirmed one had landed) waits for a load,
//   then undoes the backend's own record of it from the item's history.
// - An add (or stamp) that is undone after its request left the phone may
//   or may not be on the backend. It is kept in mat.queue as an undo to
//   finish, until the backend confirms it: resend the add (the backend
//   returns the first one, with its log id) and then undo that. A line that
//   provably never left the phone is simply forgotten.
//
// Everything outside comes in through createStore's arguments.

import { newId } from "./time.js";

const BUSY_RETRIES = 3;
const BUSY_DELAY_MS = 400;
const UNDO_FAILED = "Couldn’t undo that. Try again from History.";
// The request provably never left the phone.
const NOT_SAVED = "No signal. That wasn’t saved.";
// No reply: it may or may not be on the backend; the next contact shows which.
const UNCONFIRMED = "Couldn’t confirm that. Checking…";
const STALE = "That was changed again since. Undo the newer change first.";
const NO_SIGNAL = "No signal. Try again.";

const DATA_KEYS = ["trip", "people", "days", "stops", "stays", "expenses", "payments", "rateToday", "rateSource", "sheetUrl", "plannerLinked"];
// Every kind of item the store keeps, the field it is found by and the flag
// that marks it gone. Stays and day headers only ever change here through an
// undo from History (their writes come in later tasks).
const LIST = { expense: "expenses", payment: "payments", person: "people", stop: "stops", stay: "stays", day: "days" };
const KEY_FIELD = { expense: "id", payment: "id", person: "name", stop: "id", stay: "id", day: "date" };
const FLAG = { expense: "deleted", payment: "removed", stop: "deleted", stay: "deleted" };
// Adds kept in mat.queue and resent with the same id until the backend has
// them. A stop add is not one of them: stop writes need a connection, so
// with no reply it is rolled back like any other write (and never resent).
const ADD_API = { expense: "addExpense", payment: "addPayment" };

// A stop as the backend gives it back, before the fields are filled in.
const STOP_BLANK = { date: "", time: "", title: "", detail: "", gettingThere: "", travelMin: 0, fixed: false, place: "", signJp: "", booked: false, link: "", photo: "", note: "" };

const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const codeOf = (err) => (err && err.code) || "server";
// No usable reply: no signal, or a reply that was not an envelope (or the
// backend's own "server" error).
const noReply = (err) => codeOf(err) === "network" || codeOf(err) === "server";
// The request provably never left the phone.
const neverSent = (err) => !!(err && err.notSent);
// The backend may have saved it: no reply to a request that did leave. Only an
// explicit refusal (bad_input, not_found, stale, bad_key), busy (the lock was
// never taken) or a request that never left proves nothing was saved.
const fateUnknown = (err) => noReply(err) && !neverSent(err);
// Worth trying again on the next contact.
const transient = (err) => noReply(err) || codeOf(err) === "busy";
const refusedAsStale = (err) => codeOf(err) === "stale" || codeOf(err) === "not_found";

function bare(item) {
  if (!item) return item;
  const out = { ...item };
  delete out.pending;
  delete out.failed;
  return out;
}

const isName = (names, n) => typeof n === "string" && names.includes(n);
const positive = (n) => typeof n === "number" && isFinite(n) && n > 0;

// Why money.js cannot use a row from the Sheet, or null when it can: a name
// that is not one of the people, or an amount it cannot read.
function unreadable(kind, x, names) {
  if (kind === "expense") {
    if (!isName(names, x.paidBy)) return "name";
    if (!Array.isArray(x.split) || !x.split.length || !x.split.every((n) => isName(names, n))) return "name";
    if (!positive(x.amount) || (x.currency !== "JPY" && x.currency !== "CAD")) return "amount";
    if (x.currency === "JPY" && !positive(x.rate)) return "amount";
    if (x.splitMode === "parts" || x.splitMode === "exact") {
      if (!Array.isArray(x.splitVals) || x.splitVals.length !== x.split.length || !x.splitVals.every(positive)) return "amount";
    }
    return null;
  }
  if (!isName(names, x.from) || !isName(names, x.to)) return "name";
  if (!positive(x.cad)) return "amount";
  return null;
}

// What a pull from the planner says it did.
function plannerNotice(d) {
  const plural = (n, one, many) => (n === 1 ? one : many);
  let said;
  if (d.added && d.changed) said = "Added " + d.added + " and changed " + d.changed + " to match the planner.";
  else if (d.added) said = "Added " + d.added + plural(d.added, " payment", " payments") + " from the planner.";
  else if (d.changed) said = "Changed " + d.changed + plural(d.changed, " payment", " payments") + " to match the planner.";
  else said = "Nothing new in the planner.";
  const bad = Array.isArray(d.problems) ? d.problems.length : 0;
  if (bad) said += " " + bad + plural(bad, " row couldn’t be read.", " rows couldn’t be read.");
  if (d.capped) said += " Only the first 300 payments were read.";
  if (d.more) said += " More to bring in: tap Fetch again.";
  return said;
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
    trip: null, people: [], days: [], stops: [], stays: [], expenses: [], payments: [], rateToday: null, rateSource: null, sheetUrl: "", plannerLinked: false,
    loadedAt: null, seenAt: null, lastChange: null, notice: null, setAside: [], keyRefused: false,
    history: { entries: [], more: false, loading: false, error: null },
  };

  const subs = new Set();
  let base = null;
  let myName = null;
  let ops = []; // unconfirmed changes, in the order they were made
  let resolving = []; // undone adds/stamps whose backend side is not settled yet
  const writes = new Map(); // token -> write op, for undo(token)
  const chains = new Map(); // "kind:id" -> tail promise of that item's writes (never rejects)
  const background = new Set(); // flushes and probes started on their own
  let settled = []; // { seq, kind, item } confirmed by a write, newest last
  let writeSeq = 0;
  let loadCount = 0;
  let appliedLoad = 0;
  let flushing = null;
  let historyLoaded = false;
  // A write got no reply: the first load started after this many loads shows
  // the truth (null when none is owed).
  let reloadAfter = null;
  let contactReload = null;
  let unsureUndos = []; // undos of unconfirmed writes, waiting for a contact
  let loadWaiters = []; // { after, resolve }: waiting for a load started after `after` loads

  // ---- deriving and telling ----

  // One view that throws must not stop the others, or the store.
  function emit() {
    for (const fn of [...subs]) {
      try {
        fn(state);
      } catch (err) {
        if (typeof globalThis.reportError === "function") globalThis.reportError(err);
      }
    }
  }

  function derive() {
    if (base) for (const k of DATA_KEYS) state[k] = base[k];
    const lists = {};
    // A cache kept before the plan existed has no stops, stays or days.
    for (const kind of Object.keys(LIST)) lists[kind] = base && Array.isArray(base[LIST[kind]]) ? base[LIST[kind]].slice() : [];
    // Rows from the Sheet the money maths cannot read (a hand edit with a
    // name the app does not know, say) are kept out of it and listed.
    const names = lists.person.map((x) => x.name);
    const aside = [];
    for (const kind of ["expense", "payment"]) {
      lists[kind] = lists[kind].filter((x) => {
        const reason = unreadable(kind, x, names);
        if (!reason) return true;
        aside.push({ kind, id: x.id, title: kind === "expense" ? x.title : x.from + " \u2192 " + x.to, reason });
        return false;
      });
    }
    state.setAside = aside;
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
    for (const kind of Object.keys(LIST)) state[LIST[kind]] = lists[kind];
    state.me = myName && state.people.some((p) => p.name === myName) ? myName : null;
  }

  function changed() {
    derive();
    emit();
  }

  function find(kind, id) {
    return state[LIST[kind]].find((x) => x[KEY_FIELD[kind]] === id) || null;
  }

  function track(promise) {
    background.add(promise);
    promise.finally(() => background.delete(promise));
    return promise;
  }

  // ---- persistence ----

  function saveCache() {
    if (!base) return;
    setItem("mat.cache", JSON.stringify({ data: base, rev: state.rev, loadedAt: state.loadedAt }));
  }

  const isAdd = (op) => op.api === ADD_API[op.kind];
  const isLiveAdd = (op) => isAdd(op) && !op.undone && ops.includes(op);
  const isLiveQueuedAdd = (op) => op.api === "addExpense" && isLiveAdd(op);
  // The request may have reached the backend.
  const mayHaveLanded = (op) => op.inFlight || op.lost || op.logId !== null;

  function saveQueue() {
    const live = ops.filter(isLiveAdd).map((op) =>
      op.kind === "payment"
        ? { payment: op.args.payment, stampedAt: op.after.stampedAt, stampedBy: op.after.stampedBy, sent: op.inFlight || op.lost }
        : {
            expense: op.args.expense,
            addedAt: op.after.addedAt,
            rate: op.after.rate,
            addedBy: op.after.addedBy,
            failed: op.status === "failed",
            sent: op.inFlight || op.lost,
          },
    );
    const undos = resolving.map((op) => ({ undo: true, kind: op.kind, args: op.args, logId: op.logId, actor: op.actor || null }));
    setItem("mat.queue", JSON.stringify(live.concat(undos)));
  }

  // ---- talking to the backend ----

  async function call(action, args, opts) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = opts ? await api(action, args, opts) : await api(action, args);
        state.online = true;
        // Contact after a write that got no reply: show what the backend has.
        // (refresh and checkRev see to it themselves.)
        if (reloadAfter !== null && action !== "load" && action !== "rev") reloadOnContact();
        return r;
      } catch (err) {
        const code = err && err.code;
        if (code === "busy" && attempt < BUSY_RETRIES) {
          await wait(BUSY_DELAY_MS);
          continue;
        }
        if (code === "network") state.online = false;
        if (code === "bad_key") {
          state.status = "nokey";
          state.keyRefused = true; // a key was tried and the trip said no
        }
        throw err;
      }
    }
  }

  // Our own write moved the backend on by exactly one: keep rev in step so
  // checkRev does not reload for it. Anything else leaves rev for checkRev.
  function stepRev(rev) {
    if (typeof rev === "number" && typeof state.rev === "number" && rev === state.rev + 1) state.rev = rev;
  }

  // Runs fn after everything already queued for this item; at once (in the
  // same tick) when nothing is.
  function enqueue(key, fn) {
    const prev = chains.get(key);
    const run = prev ? prev.then(fn) : (async () => fn())();
    const tail = run.catch(() => {});
    chains.set(key, tail);
    tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  }

  const chainKey = (kind, id) => kind + ":" + id;

  function removeOp(op) {
    ops = ops.filter((o) => o !== op);
  }

  function putBase(kind, item) {
    if (!base) return;
    const list = Array.isArray(base[LIST[kind]]) ? base[LIST[kind]].slice() : [];
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

  // Proof of contact: send anything that is waiting, and finish undos of
  // unconfirmed writes against what was just loaded.
  function afterContact() {
    const waiting = resolving.length > 0 || ops.some((op) => isLiveAdd(op) && op.status === "queued");
    if (waiting) track(flush());
    for (const op of unsureUndos.splice(0)) track(enqueue(chainKey(op.kind, op.id), () => undoUnsure(op, false)));
  }

  function reloadOnContact() {
    if (contactReload) return;
    contactReload = track(refresh().finally(() => {
      contactReload = null;
    }));
  }

  // A write got no reply: the next contact reloads.
  function wantReload() {
    reloadAfter = loadCount;
  }

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
    if (reloadAfter !== null && mine > reloadAfter) reloadAfter = null;
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
    afterContact();
    wakeLoadWaiters(mine);
    return true;
  }

  // Resolves once a load started after `after` loads has been applied.
  function nextLoad(after) {
    return new Promise((resolve) => loadWaiters.push({ after, resolve }));
  }

  function wakeLoadWaiters(upTo) {
    const due = loadWaiters.filter((w) => w.after < upTo);
    loadWaiters = loadWaiters.filter((w) => w.after >= upTo);
    for (const w of due) w.resolve();
  }

  async function checkRev() {
    let r;
    try {
      r = await call("rev", {});
    } catch {
      changed();
      return;
    }
    if (r.rev !== state.rev || reloadAfter !== null) {
      await refresh();
      return;
    }
    changed();
    afterContact();
  }

  // After the backend refused an undo as stale or gone: say so and show what
  // the backend has now.
  async function showBackendAfterRefusedUndo(err) {
    state.notice = (err && err.message) || STALE;
    changed();
    await refresh();
    if (historyLoaded) await loadHistory();
  }

  function restoreQueue() {
    const queue = getJson("mat.queue");
    if (!Array.isArray(queue)) return;
    for (const q of queue) {
      if (!q || typeof q !== "object") continue;
      if (q.undo === true) {
        const kind = q.kind;
        const item = q.args && typeof q.args === "object" ? q.args[kind] : null;
        if (!ADD_API[kind] || !item || typeof item.id !== "string") continue;
        if (resolving.some((o) => o.kind === kind && o.id === item.id)) continue;
        const op = {
          token: newId(), kind, id: item.id, action: kind === "expense" ? "add" : "stamp", api: ADD_API[kind],
          args: copy(q.args), before: null, after: copy(item), view: () => null,
          status: "queued", undone: true, inFlight: false, lost: true,
          logId: typeof q.logId === "number" ? q.logId : null,
          actor: typeof q.actor === "string" ? q.actor : null,
        };
        startResolving(op);
        continue;
      }
      if (q.payment && typeof q.payment === "object" && typeof q.payment.id === "string") {
        if (ops.some((o) => o.kind === "payment" && o.id === q.payment.id)) continue;
        const op = stampOp(q.payment, {
          stampedBy: typeof q.stampedBy === "string" ? q.stampedBy : myName,
          stampedAt: typeof q.stampedAt === "string" ? q.stampedAt : undefined,
        });
        op.status = "queued";
        op.lost = q.sent !== false;
        writes.set(op.token, op);
        ops.push(op);
        continue;
      }
      if (!q.expense || typeof q.expense.id !== "string") continue;
      if (ops.some((o) => o.kind === "expense" && o.id === q.expense.id)) continue;
      const op = addOp(q.expense, {
        addedBy: typeof q.addedBy === "string" ? q.addedBy : myName,
        addedAt: typeof q.addedAt === "string" ? q.addedAt : undefined,
        rate: typeof q.rate === "number" ? q.rate : undefined,
      });
      op.status = q.failed ? "failed" : "queued";
      op.lost = q.sent !== false;
      writes.set(op.token, op);
      ops.push(op);
    }
  }

  async function boot() {
    state.keyRefused = false;
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
    // Whatever painting the cache does, the load still goes out.
    try {
      restoreQueue();
      changed();
    } catch {
      // a broken cache or queue: the load below replaces it
    }
    if (await refresh()) await flush();
  }

  // ---- writes ----

  // op: { token, kind, id, action, api, args, before, after, view, status,
  //       undone, logId, inFlight, lost, resolving, uop }
  function addOp(expense, { addedBy, addedAt, rate } = {}) {
    const after = {
      ...copy(expense),
      rate: rate !== undefined ? rate : base ? base.rateToday : state.rateToday,
      addedBy: addedBy || null,
      addedAt: addedAt || new Date(now()).toISOString(),
      deleted: false,
    };
    return {
      token: newId(), kind: "expense", id: expense.id, action: "add", api: "addExpense",
      args: { expense: copy(expense) }, before: null, after,
      view: (cur) => ({ ...(cur || {}), ...after }),
      status: "sending", undone: false, logId: null, inFlight: false, lost: false,
      actor: after.addedBy,
    };
  }

  function begin(op) {
    writes.set(op.token, op);
    ops.push(op);
    // A write its caller waits on (op.quiet) is shown on the bar once saved.
    if (op.quiet) op.outcome = new Promise((resolve) => { op.finish = resolve; });
    else showChange(op, op.after);
    if (op.api === "addExpense" && !state.online) {
      // Known to be without signal: keep it on the phone (so it provably never
      // left) and check for signal; the next contact sends it.
      op.status = "queued";
      saveQueue();
      changed();
      track(checkRev());
      return op.token;
    }
    if (isAdd(op)) saveQueue();
    changed();
    send(op);
    return op.token;
  }

  function send(op) {
    return enqueue(chainKey(op.kind, op.id), () => runWrite(op));
  }

  async function runWrite(op) {
    // An undone add is only ever sent by finishUndo.
    if (op.undone && isAdd(op)) return;
    op.status = "sending";
    op.inFlight = true;
    if (isAdd(op)) saveQueue();
    try {
      const r = await call(op.api, op.args, isAdd(op) && op.actor ? { actor: op.actor } : undefined);
      op.inFlight = false;
      const item = r.data[op.kind];
      op.logId = r.data.logId === undefined ? null : r.data.logId;
      op.status = "done";
      removeOp(op);
      confirm(op.kind, item);
      // A resent add is answered with the backend's current rev, which may
      // hold other phones' changes: never take it as this write's own step.
      if (op.lost) track(checkRev());
      else if (op.logId !== null) stepRev(r.rev);
      if (op.logId === null && !isAdd(op)) op.noop = true; // the backend already had it so
      const lc = state.lastChange;
      if (op.quiet) {
        showChange(op, item);
        op.finish({ saved: true, item: copy(item) });
      } else if (lc && lc.token === op.token) state.lastChange = { ...lc, item: copy(item) };
    } catch (err) {
      op.inFlight = false;
      if (fateUnknown(err)) op.lost = true;
      if (op.undone && isAdd(op)) {
        // finishUndo decides what still has to happen
      } else if (isAdd(op) && noReply(err)) {
        op.status = "queued"; // the same id resent later is safe
      } else if (op.api === "addExpense") {
        op.status = "failed";
      } else if (op.quiet) {
        removeOp(op);
        settleQuiet(op, err);
      } else {
        removeOp(op);
        state.notice = failNotice(err);
        // A stop with no reply is asked about at once, not at the next
        // 20-second check, so a stop that did land is back on screen before
        // anyone types it again. (A reload only: the write is never resent.)
        if (op.kind === "stop" && fateUnknown(err)) track(checkRev());
      }
    }
    saveQueue();
    saveCache();
    changed();
  }

  // The undo bar's line for a write (`item` as it is now).
  function showChange(op, item) {
    state.lastChange = { token: op.token, action: op.action, kind: op.kind, item: bare(copy(item)), canUndo: true };
    if (op.action === "edit") state.lastChange.before = bare(op.before);
  }

  // A write its caller waits on did not go through: the caller is told how
  // (op.finish) and says it itself, so no notice. With no reply, the caller
  // hears at once that it is unsure (op.onUnsure), and the outcome follows
  // the first load after it: saved when the backend has it, else not landed.
  function settleQuiet(op, err) {
    if (neverSent(err)) {
      op.finish({ saved: false, reason: "notSent" });
      return;
    }
    if (!noReply(err)) {
      op.finish({ saved: false, reason: "refused", message: (err && err.message) || UNCONFIRMED });
      return;
    }
    if (typeof op.onUnsure === "function") {
      try {
        op.onUnsure();
      } catch {
        // the caller's own trouble
      }
    }
    wantReload();
    nextLoad(loadCount).then(() => {
      const item = (base && Array.isArray(base[LIST[op.kind]]) ? base[LIST[op.kind]] : []).find((x) => x[KEY_FIELD[op.kind]] === op.id) || null;
      const landed = !!item && (!op.before || sameAs(item, op.patch));
      if (!landed) {
        op.finish({ saved: false, reason: "notLanded" });
        return;
      }
      showChange(op, item);
      changed();
      op.finish({ saved: true, item: copy(item) });
    });
    track(checkRev());
  }

  // What a write that did not go through says. A write with no reply is
  // rolled back for now, and the next contact reloads to show the truth.
  function failNotice(err) {
    if (neverSent(err)) return NOT_SAVED;
    if (noReply(err)) {
      wantReload();
      return UNCONFIRMED;
    }
    return (err && err.message) || UNCONFIRMED;
  }

  // opts.quiet: the caller waits on store.outcome(token) and tells the
  // person itself (a stop sheet); opts.onUnsure: called when no reply came.
  function change(kind, id, action, apiAction, patch, { quiet = false, onUnsure = null } = {}) {
    const before = find(kind, id);
    if (!before) return null;
    const after = { ...bare(before), ...patch };
    const args = action === "edit" ? { id, patch: copy(patch) } : { id };
    return begin({
      token: newId(), kind, id, action, api: apiAction, args, patch: copy(patch),
      before: bare(before), after,
      view: (cur) => (cur ? { ...cur, ...patch } : null),
      status: "sending", undone: false, logId: null, inFlight: false, lost: false, actor: myName,
      quiet, onUnsure,
    });
  }

  function addExpense(draft) {
    const expense = { id: newId(), ...copy(draft) };
    return begin(addOp(expense, { addedBy: myName }));
  }

  // A new stop, shown at once and sent as addStop. Not queued: with no
  // signal, or no reply, it is rolled back like an edit (see runWrite).
  // opts.id: the id to use (a retry passes the first try's, so the backend
  // keeps one stop); opts.quiet and opts.onUnsure as for change().
  function addStop(draft, { id, quiet = false, onUnsure = null } = {}) {
    const stop = { ...copy(draft), id: typeof id === "string" && id ? id : newId() };
    const after = { ...STOP_BLANK, ...copy(stop), deleted: false };
    return begin({
      token: newId(), kind: "stop", id: stop.id, action: "add", api: "addStop",
      args: { stop: copy(stop) }, before: null, after,
      view: (cur) => ({ ...(cur || {}), ...after }),
      status: "sending", undone: false, logId: null, inFlight: false, lost: false, actor: myName,
      quiet, onUnsure,
    });
  }

  // How a write made with opts.quiet ended: { saved: true, item } (item as
  // the backend has it), or { saved: false, reason } with reason "refused"
  // (and the backend's message), "notSent" (it provably never left the
  // phone) or "notLanded" (no reply, and the backend does not have it).
  // With no reply it resolves only after a load, however long that takes.
  function outcome(token) {
    const op = writes.get(token);
    return op && op.outcome ? op.outcome : Promise.resolve(null);
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
    return begin(stampOp(payment, { stampedBy: myName }));
  }

  function stampOp(payment, { stampedBy, stampedAt } = {}) {
    const after = { ...copy(payment), stampedBy: stampedBy || null, stampedAt: stampedAt || new Date(now()).toISOString(), removed: false };
    return {
      token: newId(), kind: "payment", id: payment.id, action: "stamp", api: "addPayment",
      args: { payment: copy(payment) }, before: null, after,
      view: (cur) => ({ ...(cur || {}), ...after }),
      status: "sending", undone: false, logId: null, inFlight: false, lost: false, actor: after.stampedBy,
    };
  }

  // Removing (or deleting) an item whose add the backend has not confirmed:
  // never a request about an item it may not have. The add is taken back,
  // as Undo does: forgotten if it provably never left, otherwise resent and
  // undone on the next contact. null when there is no such add.
  function takeBackLive(kind, id) {
    const op = ops.find((o) => o.kind === kind && o.id === id && isLiveAdd(o));
    if (!op) return null;
    op.undone = true;
    state.lastChange = { token: newId(), action: "undo", kind, item: bare(undoneView(op, bare(find(kind, id)))), canUndo: false };
    takeBack(op);
    return state.lastChange.token;
  }

  // What an item looks like once `op` is undone.
  function undoneView(op, cur) {
    if (!op.before) return { ...(cur || op.after), [FLAG[op.kind]]: true };
    return { ...(cur || {}), ...op.before };
  }

  // ---- undoing an add or a stamp ----

  // Remember (in mat.queue too) that this add must end up undone on the
  // backend, and show it gone meanwhile.
  function startResolving(op) {
    op.resolving = true;
    op.uop = { kind: op.kind, id: op.id, status: "sending", view: (cur) => (cur ? { ...cur, [FLAG[op.kind]]: true } : null) };
    ops.push(op.uop);
    resolving.push(op);
    saveQueue();
  }

  function stopResolving(op) {
    op.resolving = false;
    resolving = resolving.filter((o) => o !== op);
    removeOp(op.uop);
    saveQueue();
  }

  // Makes the backend agree that `op` is undone. Returns "done", "wait" (the
  // add's fate is unknown and there is no proof of signal yet) or "offline".
  async function finishUndo(op, contact) {
    if (!op.resolving) return "done";
    try {
      if (op.logId === null) {
        if (!op.lost) {
          // refused outright, never on the backend
          stopResolving(op);
          return "done";
        }
        if (!contact) return "wait";
        let r;
        try {
          r = await call(op.api, op.args, op.actor ? { actor: op.actor } : undefined); // same id: the backend returns the first one
        } catch (err) {
          if (transient(err)) return "offline";
          stopResolving(op); // refused: it is not on the backend
          return "done";
        }
        op.logId = r.data.logId === undefined ? null : r.data.logId;
        confirm(op.kind, r.data[op.kind]);
        saveQueue();
        if (op.logId === null) {
          stopResolving(op);
          return "done";
        }
      }
      let r;
      try {
        r = await call("undo", { logId: op.logId });
      } catch (err) {
        if (transient(err)) return "offline";
        stopResolving(op);
        if (refusedAsStale(err)) {
          // Already undone (an earlier undo whose reply was lost) is fine;
          // anything else is told.
          changed();
          await refresh();
          const item = find(op.kind, op.id);
          if (!(item && item[FLAG[op.kind]])) state.notice = (err && err.message) || STALE;
          if (historyLoaded) await loadHistory();
        } else {
          state.notice = UNDO_FAILED;
          await refresh();
        }
        return "done";
      }
      confirm(op.kind, r.data[op.kind]);
      stepRev(r.rev);
      stopResolving(op);
      return "done";
    } finally {
      saveCache();
      changed();
    }
  }

  // Takes an add back: forgotten when it provably never left the phone,
  // otherwise resolved as add-then-undo on the next contact.
  function takeBack(op) {
    removeOp(op);
    if (!mayHaveLanded(op)) {
      saveQueue();
      changed();
      return Promise.resolve();
    }
    startResolving(op);
    changed();
    return enqueue(chainKey(op.kind, op.id), () => finishUndo(op, false));
  }

  // A settled write whose effect on the backend this phone cannot tell from
  // its reply: no reply at all, or "nothing changed" (an earlier unconfirmed
  // write, or another phone, had already done it).
  const unsure = (op) => !isAdd(op) && op.logId === null && (op.lost || op.noop);

  function undo(token) {
    const op = writes.get(token);
    if (!op || op.undone) return Promise.resolve();
    op.undone = true;
    if (isAdd(op)) {
      state.lastChange = { token: newId(), action: "undo", kind: op.kind, item: bare(undoneView(op, bare(find(op.kind, op.id)))), canUndo: false };
      return takeBack(op);
    }
    if (!ops.includes(op) && unsure(op)) {
      // Nothing is shown as undone until the backend says what there is to undo.
      return enqueue(chainKey(op.kind, op.id), () => undoUnsure(op, true));
    }
    state.lastChange = { token: newId(), action: "undo", kind: op.kind, item: bare(undoneView(op, bare(find(op.kind, op.id)))), canUndo: false };
    const uop = { kind: op.kind, id: op.id, status: "sending", view: (cur) => undoneView(op, cur) };
    ops.push(uop);
    changed();
    return enqueue(chainKey(op.kind, op.id), async () => {
      if (op.logId === null) {
        removeOp(uop);
        changed();
        // The write turned out unsure: settle it against the backend.
        if (unsure(op)) return undoUnsure(op, true);
        // the write never landed: nothing to undo
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
        if (refusedAsStale(err)) {
          await showBackendAfterRefusedUndo(err);
          return;
        }
        if (fateUnknown(err)) wantReload();
        state.notice = fateUnknown(err) ? UNCONFIRMED : UNDO_FAILED;
      }
      changed();
    });
  }

  const plainVal = (v) => JSON.stringify(typeof v === "string" ? v.trim() : v);
  const sameAs = (item, fields) => Object.keys(fields).every((k) => plainVal(item[k]) === plainVal(fields[k]));

  // Undo of an unsure write (runs on the item's chain). With `load`, first
  // loads so the screen and the decision use what the backend holds; without
  // a contact it waits for the next one (afterContact calls back with
  // load = false, just after a load).
  async function undoUnsure(op, load) {
    if (load && !(await refresh())) {
      unsureUndos.push(op);
      return;
    }
    const item = base ? (base[LIST[op.kind]] || []).find((x) => x[KEY_FIELD[op.kind]] === op.id) || null : null;
    // A stop add (the only add that comes here: it is not resent like a
    // queued one) has no patch: it landed when the backend has its id, which
    // only this phone could have made.
    const isNew = !op.before;
    const landed = !!item && (isNew || sameAs(item, op.patch));
    if (isNew ? !item : item && !landed && sameAs(item, pick(op.before, op.patch))) {
      // The change is not on the backend: there is nothing to undo.
      done(item || { ...op.after, [FLAG[op.kind]]: true });
      return;
    }
    let entries;
    try {
      entries = (await call("history", { ref: op.id })).data.entries;
    } catch (err) {
      if (transient(err)) unsureUndos.push(op);
      else failed();
      return;
    }
    const top = entries.filter((e) => e.kind === op.kind).sort((a, b) => b.id - a.id)[0];
    const ours = landed && top && top.action === op.action && top.who === op.actor && top.undoneBy === null && top.canUndo;
    if (!ours) {
      failed();
      return;
    }
    let r;
    try {
      r = await call("undo", { logId: top.id });
    } catch (err) {
      op.undone = false;
      if (refusedAsStale(err)) {
        await showBackendAfterRefusedUndo(err);
        return;
      }
      if (fateUnknown(err)) wantReload();
      failed();
      return;
    }
    confirm(op.kind, r.data[op.kind]);
    stepRev(r.rev);
    saveCache();
    done(r.data[op.kind]);
    if (historyLoaded) await loadHistory();

    function done(shown) {
      state.lastChange = { token: newId(), action: "undo", kind: op.kind, item: copy(shown), canUndo: false };
      changed();
    }
    function failed() {
      op.undone = false;
      state.notice = UNDO_FAILED;
      changed();
    }
  }

  function pick(from, keysOf) {
    const out = {};
    for (const k of Object.keys(keysOf)) out[k] = from ? from[k] : undefined;
    return out;
  }

  function retry(id) {
    const op = ops.find((o) => o.api === "addExpense" && o.id === id && o.status === "failed" && !o.undone);
    if (!op) return Promise.resolve();
    op.status = "sending";
    saveQueue();
    changed();
    return send(op);
  }

  const unsavedAdd = (id) => ops.find((o) => isLiveQueuedAdd(o) && o.id === id);

  // Lines and stamps the backend does not have yet: `unsent` counts every
  // one still to go (sending or waiting, not refused); `waiting` those held
  // on the phone for the next contact.
  function outbox() {
    const live = ops.filter((o) => isLiveAdd(o) && o.status !== "failed");
    return { unsent: live.length, waiting: live.filter((o) => o.status === "queued").length };
  }

  // A line that is still pending or failed, with no way forward: take it back
  // and say "Undone." on the undo bar, as undo does. A confirmed line is left
  // alone (false).
  function discard(id) {
    const op = unsavedAdd(id);
    if (!op) return false;
    op.undone = true;
    const lc = state.lastChange;
    if (lc && lc.token === op.token) {
      state.lastChange = { token: newId(), action: "undo", kind: op.kind, item: bare(op.after), canUndo: false };
    }
    takeBack(op);
    return true;
  }

  // Sends queued lines, then finishes undos left open. One pass at a time.
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      for (const op of ops.slice()) {
        if (!isAdd(op) || op.status !== "queued") continue;
        if (op.undone || !ops.includes(op)) continue; // undone since the pass began
        await send(op);
        if (op.status === "queued" && !op.undone) return; // still no signal
      }
      for (const op of resolving.slice()) {
        if (!op.resolving) continue;
        const result = await enqueue(chainKey(op.kind, op.id), () => finishUndo(op, true));
        if (result === "offline") return;
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
        state.notice = failNotice(err);
      }
      removeOp(op);
      changed();
      return ok;
    });
  }

  // The Claude connector's token, for Settings to put into a link. Resolves
  // with it, or rejects with the call's error (.code "network" for no
  // signal). Kept nowhere: not in state, storage or the cache.
  async function claudeToken() {
    const r = await call("claudeLink", {});
    const token = r && r.data ? r.data.token : null;
    if (typeof token === "string" && token) return token;
    const err = new Error("The trip sheet sent back something unexpected.");
    err.code = "server";
    throw err;
  }

  // ---- payments from the planner sheet ----

  // Asks the backend to bring in the planner's payments (R39): a plain call,
  // never queued. On success it reloads, so the lines are on the receipt, and
  // says what came in; resolves with the counts, or null when it did not
  // go through (the notice says why).
  async function syncPayments() {
    let r;
    try {
      r = await call("syncPayments", {});
    } catch (err) {
      state.notice = neverSent(err) ? NO_SIGNAL : failNotice(err);
      changed();
      return null;
    }
    const d = r.data;
    await refresh();
    state.notice = plannerNotice(d);
    changed();
    return { added: d.added, changed: d.changed, same: d.same, removed: d.removed, notCounted: d.notCounted, problems: d.problems, more: !!d.more, capped: !!d.capped };
  }

  // ---- history ----

  let historySeq = 0; // numbers each first-page load
  // Resolves with what this load itself fetched, { entries, more, error },
  // even when a newer load has since replaced state.history (null when an
  // older page was asked for and there is none).
  async function loadHistory({ older = false } = {}) {
    const h = state.history;
    if (older && (!h.more || !h.entries.length)) return null;
    const seq = older ? historySeq : ++historySeq;
    state.history = { ...h, loading: true };
    emit();
    const args = older ? { before: h.entries[h.entries.length - 1].id } : {};
    let got;
    try {
      const r = await call("history", args);
      got = { entries: r.data.entries, more: !!r.data.more, error: null };
      // A first-page load started after this one has the newer say.
      if (seq !== historySeq) {
        changed();
        return got;
      }
      state.history = { entries: older ? h.entries.concat(r.data.entries) : r.data.entries, more: !!r.data.more, loading: false, error: null };
      historyLoaded = true;
    } catch (err) {
      got = { entries: [], more: false, error: codeOf(err) };
      if (seq !== historySeq) {
        changed();
        return got;
      }
      state.history = { ...state.history, loading: false, error: codeOf(err) };
    }
    changed();
    return got;
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
        if (refusedAsStale(err)) {
          await showBackendAfterRefusedUndo(err);
          return false;
        }
        // No reply: it may have been undone; the next contact shows which.
        state.notice = noReply(err) ? failNotice(err) : UNDO_FAILED;
        changed();
        return false;
      }
      // The kind the reply names: an expense, a payment, a stop, a stay or a day.
      const kind = r.data.entry && LIST[r.data.entry.kind] ? r.data.entry.kind : Object.keys(LIST).find((k) => r.data[k]);
      const item = r.data[kind];
      confirm(kind, item);
      stepRev(r.rev);
      saveCache();
      state.lastChange = { token: newId(), action: "undo", kind, item: copy(item), canUndo: false };
      const top = r.data.entry;
      const rest = state.history.entries.map((e) => {
        if (e.id === logId) return { ...e, undoneBy: r.data.logId, canUndo: false };
        if (e.kind === kind && e.ref === item[KEY_FIELD[kind]]) return { ...e, canUndo: false };
        return e;
      });
      state.history = { ...state.history, entries: top ? [top, ...rest] : rest };
      changed();
      await loadHistory(); // the tape starts again from its first page, with whatever others did meanwhile
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

  // Resolves once every write, undo, flush and probe started so far has settled.
  async function idle() {
    const live = () => [...chains.values(), flushing, ...background].filter(Boolean);
    for (;;) {
      const pending = live();
      if (!pending.length) return;
      await Promise.all(pending);
      const after = live();
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
    setMe, setPerson, markSeen, notify, clearNotice, claudeToken, syncPayments,
    addExpense,
    updateExpense: (id, patch) => change("expense", id, "edit", "updateExpense", patch),
    deleteExpense: (id) => takeBackLive("expense", id) || change("expense", id, "delete", "deleteExpense", { deleted: true }),
    restoreExpense: (id) => change("expense", id, "restore", "restoreExpense", { deleted: false }),
    addPayment,
    removePayment: (id) => takeBackLive("payment", id) || change("payment", id, "unstamp", "removePayment", { removed: true }),
    restorePayment: (id) => change("payment", id, "restamp", "restorePayment", { removed: false }),
    addStop,
    updateStop: (id, patch, opts) => change("stop", id, "edit", "updateStop", patch, opts),
    outcome,
    deleteStop: (id) => change("stop", id, "delete", "deleteStop", { deleted: true }),
    restoreStop: (id) => change("stop", id, "restore", "restoreStop", { deleted: false }),
    retry, discard, unsaved: (id) => !!unsavedAdd(id), outbox, undo, undoEntry, loadHistory, historyFor,
  };
}
