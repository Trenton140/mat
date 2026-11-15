// Every request is handled here: handle_(body) -> response envelope.
// This file reaches the outside world only through these primitives, defined
// elsewhere (Sheets.js, Env.js, Rate.js on Apps Script; in memory in
// tests/fake-backend.cjs):
//   readTable_, appendObj_, updateById_, updateWhere_,
//   getProp_, setProp_, withLock_, getRate_, getRateInfo_, tripKey_, nowIso_, sheetUrl_
// It also uses the pure helpers from Pure.js.

var MSG_ = {
  badRequest: "That request didn’t come through properly.",
  badKey: "This link’s trip key doesn’t match. Ask for a fresh invite link.",
  badAction: "The app asked for something the trip sheet doesn’t know how to do.",
  badActor: "Pick who you are first.",
  badId: "That didn’t say which line it meant.",
  badPatch: "That change didn’t come through properly.",
  patchKey: "Only a line’s details can be changed.",
  editDeleted: "Bring it back first.",
  noExpense: "That line isn’t there any more.",
  noPayment: "That payment isn’t there any more.",
  noPerson: "That person isn’t on this trip.",
  badLogId: "That didn’t say which change to undo.",
  noLog: "That change isn’t in the history.",
  undone: "That’s already been undone.",
  newer: "That was changed again since. Undo the newer change first.",
  cantUndo: "That change can’t be undone.",
  badHistory: "That history request didn’t come through properly.",
  server: "Something went wrong on our side. Try again.",
};

var EXPENSE_PATCH_KEYS_ = ["title", "amount", "currency", "paidBy", "split", "splitMode", "splitVals", "day", "note", "kind"];

function handle_(body) {
  if (!isObj_(body)) return err_("bad_input", MSG_.badRequest);
  if (!sameKey(body.key, tripKey_())) return err_("bad_key", MSG_.badKey);
  var env;
  try {
    env = dispatch_(body);
  } catch (e) {
    env = err_("server", MSG_.server + " (" + String((e && e.message) || e) + ")");
  }
  if (typeof env.rev !== "number") env.rev = rev_();
  return env;
}

function dispatch_(body) {
  var args = body.args === undefined || body.args === null ? {} : body.args;
  if (!isObj_(args)) return err_("bad_input", MSG_.badRequest);
  var action = body.action;
  if (action === "load") return load_();
  if (action === "rev") return ok_({}, rev_());
  if (action === "history") return history_(args);

  var write;
  switch (action) {
    case "addExpense": write = addExpense_; break;
    case "updateExpense": write = updateExpense_; break;
    case "deleteExpense": write = function (a, c) { return setExpenseDeleted_(a, c, true); }; break;
    case "restoreExpense": write = function (a, c) { return setExpenseDeleted_(a, c, false); }; break;
    case "addPayment": write = addPayment_; break;
    case "removePayment": write = function (a, c) { return setPaymentRemoved_(a, c, true); }; break;
    case "restorePayment": write = function (a, c) { return setPaymentRemoved_(a, c, false); }; break;
    case "setPerson": write = setPerson_; break;
    case "undo": write = undo_; break;
    default: return err_("bad_input", MSG_.badAction);
  }
  var names = peopleNames_();
  if (typeof body.actor !== "string" || names.indexOf(body.actor) === -1) return err_("bad_input", MSG_.badActor);
  var ctx = { actor: body.actor, via: body.via === "claude" ? "claude" : "app", names: names };
  // Fetching the day's rate can take a few seconds; do it before taking the lock.
  if (action === "addExpense") ctx.rate = getRate_();
  return withLock_(function () { return write(args, ctx); });
}

// ---- envelopes, rev, log ----

function ok_(data, rev) { return { ok: true, rev: rev, data: data }; }

function err_(code, message) { return { ok: false, error: code, message: message }; }

// REV from Script Properties. If the property is missing (properties were
// reset), start from the Log's highest id so rev never goes backwards.
function rev_() {
  var raw = getProp_("REV");
  var n = Number(raw);
  if (raw !== null && raw !== "" && isFinite(n) && n >= 0) return Math.floor(n);
  return maxLogId_();
}

function maxLogId_() {
  var max = 0;
  logRows_().forEach(function (r) {
    var id = Number(r.id);
    if (isFinite(id) && id > max) max = id;
  });
  return max;
}

function bumpRev_() {
  var n = rev_() + 1;
  setProp_("REV", String(n));
  return n;
}

// Appends one Log row and returns it as written. Called inside the write lock.
// The id is one above both LOGSEQ and the Log's highest id, so ids stay unique
// even if Script Properties were reset.
function appendLog_(ctx, action, kind, ref, summary, before, after, undoes) {
  var seq = Number(getProp_("LOGSEQ"));
  var id = Math.max(isFinite(seq) ? Math.floor(seq) : 0, maxLogId_()) + 1;
  setProp_("LOGSEQ", String(id));
  var row = {
    id: id, at: nowIso_(), who: ctx.actor, via: ctx.via, action: action, kind: kind, ref: ref, summary: summary,
    before: before ? JSON.stringify(before) : "", after: after ? JSON.stringify(after) : "",
    undoes: undoes === null || undoes === undefined ? "" : undoes, undone_by: "",
  };
  appendObj_("Log", row);
  return row;
}

function logRows_() {
  return readTable_("Log").filter(function (r) { return cellText_(r.id) !== ""; });
}

// The id of the Log row that first added this item (for a repeated add).
function firstLogId_(kind, ref, action) {
  var best = null;
  logRows_().forEach(function (r) {
    var id = Number(r.id);
    if (cellText_(r.kind) === kind && cellText_(r.ref) === ref && cellText_(r.action) === action && (best === null || id < best)) best = id;
  });
  return best;
}

// ---- table helpers ----

function peopleRows_() {
  return readTable_("People")
    .filter(function (r) { return cellText_(r.name) !== ""; })
    .sort(function (a, b) { return Number(a.order) - Number(b.order); });
}

function peopleNames_() {
  return peopleRows_().map(function (r) { return cellText_(r.name); });
}

function findRow_(tab, id) {
  var rows = readTable_(tab);
  for (var i = 0; i < rows.length; i++) if (cellText_(rows[i].id) === id) return rows[i];
  return null;
}

function idArg_(args) {
  return typeof args.id === "string" && args.id !== "" ? args.id : null;
}

function camel_(s) {
  return s.replace(/_([a-z])/g, function (m, c) { return c.toUpperCase(); });
}

// A sheet row with camelCase keys, dates as yyyy-MM-dd, blanks as "".
function plainRow_(o) {
  var out = {};
  Object.keys(o).forEach(function (k) {
    var v = o[k];
    out[camel_(k)] = v instanceof Date ? cellDate_(v) : v === null || v === undefined ? "" : v;
  });
  return out;
}

// The fields of an expense a person can change, as a fresh object.
function editableOf_(e) {
  return {
    day: e.day, title: e.title, amount: e.amount, currency: e.currency, paidBy: e.paidBy,
    split: Array.isArray(e.split) ? e.split.slice() : undefined,
    splitMode: e.splitMode,
    splitVals: Array.isArray(e.splitVals) ? e.splitVals.slice() : undefined,
    note: e.note, kind: e.kind,
  };
}

function paymentEditableOf_(p) {
  return { from: p.from, to: p.to, cad: p.cad, seed: p.seed, rot: p.rot };
}

// ---- reads ----

function load_() {
  var rev = rev_();
  var rate = getRateInfo_();
  var trip = {};
  readTable_("Trip").forEach(function (r) {
    var k = cellText_(r.key).trim();
    if (k) trip[k] = cellDate_(r.value);
  });
  return ok_({
    trip: trip,
    people: peopleRows_().map(personFromRow),
    days: readTable_("Days").filter(function (r) { return cellDate_(r.date) !== ""; }).map(plainRow_),
    stops: readTable_("Stops").filter(function (r) { return cellText_(r.id) !== ""; }).map(plainRow_),
    stays: readTable_("Stays").filter(function (r) { return cellText_(r.id) !== ""; }).map(plainRow_),
    expenses: readTable_("Expenses").filter(function (r) { return cellText_(r.id) !== ""; }).map(expenseFromRow),
    payments: readTable_("Settlements").filter(function (r) { return cellText_(r.id) !== ""; }).map(paymentFromRow),
    rateToday: rate.rate,
    rateSource: rate.source,
    sheetUrl: sheetUrl_(),
  }, rev);
}

function history_(args) {
  var ref = args.ref;
  if (ref !== undefined && ref !== null && typeof ref !== "string") return err_("bad_input", MSG_.badHistory);
  var before = args.before === undefined || args.before === null ? null : Number(args.before);
  if (before !== null && !isFinite(before)) return err_("bad_input", MSG_.badHistory);
  var limit = Number(args.limit);
  if (args.limit === undefined || args.limit === null || args.limit === "" || !isFinite(limit)) limit = 200;
  limit = Math.max(1, Math.min(500, Math.floor(limit)));

  var rev = rev_();
  var all = logRows_().map(logShape_);
  var picked = all
    .filter(function (e) { return (ref === undefined || ref === null || e.ref === ref) && (before === null || e.id < before); })
    .sort(function (a, b) { return b.id - a.id; });
  var entries = picked.slice(0, limit).map(function (e) {
    e.canUndo = canUndo(e, all);
    return e;
  });
  return ok_({ entries: entries, more: picked.length > limit }, rev);
}

// ---- expenses ----

function addExpense_(args, ctx) {
  var v = validateExpense(args.expense, ctx.names);
  if (!v.ok) return err_("bad_input", v.message);
  var id = v.value.id;
  var existing = findRow_("Expenses", id);
  if (existing) return ok_({ expense: expenseFromRow(existing), logId: firstLogId_("expense", id, "add") }, rev_());

  var e = v.value;
  e.rate = ctx.rate;
  e.addedBy = ctx.actor;
  var row = expenseToRow(e);
  row.added_at = nowIso_();
  appendObj_("Expenses", row);
  var saved = expenseFromRow(findRow_("Expenses", id));
  var log = appendLog_(ctx, "add", "expense", id, summarize("add", "expense", null, saved), null, saved);
  return ok_({ expense: saved, logId: log.id }, bumpRev_());
}

function updateExpense_(args, ctx) {
  var id = idArg_(args);
  if (!id) return err_("bad_input", MSG_.badId);
  var patch = args.patch;
  if (!isObj_(patch)) return err_("bad_input", MSG_.badPatch);
  var keys = Object.keys(patch);
  for (var i = 0; i < keys.length; i++) {
    if (EXPENSE_PATCH_KEYS_.indexOf(keys[i]) === -1) return err_("bad_input", MSG_.patchKey);
  }
  var row = findRow_("Expenses", id);
  if (!row) return err_("not_found", MSG_.noExpense);
  var cur = expenseFromRow(row);
  if (cur.deleted) return err_("bad_input", MSG_.editDeleted);

  // Validate the whole line as it would be, not the patch alone.
  var merged = editableOf_(cur);
  keys.forEach(function (k) { merged[k] = patch[k]; });
  merged.id = id;
  var v = validateExpense(merged, ctx.names);
  if (!v.ok) return err_("bad_input", v.message);

  var cols = expenseToRow(editableOf_(v.value));
  if (same_(cols, expenseToRow(editableOf_(cur)))) return ok_({ expense: cur, logId: null }, rev_());
  var saved = expenseFromRow(updateById_("Expenses", id, cols));
  var log = appendLog_(ctx, "edit", "expense", id, summarize("edit", "expense", cur, saved), cur, saved);
  return ok_({ expense: saved, logId: log.id }, bumpRev_());
}

function setExpenseDeleted_(args, ctx, deleted) {
  var id = idArg_(args);
  if (!id) return err_("bad_input", MSG_.badId);
  var row = findRow_("Expenses", id);
  if (!row) return err_("not_found", MSG_.noExpense);
  var cur = expenseFromRow(row);
  if (cur.deleted === deleted) return ok_({ expense: cur, logId: null }, rev_());
  var saved = expenseFromRow(updateById_("Expenses", id, { deleted_at: deleted ? nowIso_() : "" }));
  var action = deleted ? "delete" : "restore";
  var log = appendLog_(ctx, action, "expense", id, summarize(action, "expense", cur, saved), cur, saved);
  return ok_({ expense: saved, logId: log.id }, bumpRev_());
}

// ---- payments ----

function addPayment_(args, ctx) {
  var v = validatePayment(args.payment, ctx.names);
  if (!v.ok) return err_("bad_input", v.message);
  var id = v.value.id;
  var existing = findRow_("Settlements", id);
  if (existing) return ok_({ payment: paymentFromRow(existing), logId: firstLogId_("payment", id, "stamp") }, rev_());

  var p = v.value;
  p.stampedBy = ctx.actor;
  var row = paymentToRow(p);
  row.stamped_at = nowIso_();
  appendObj_("Settlements", row);
  var saved = paymentFromRow(findRow_("Settlements", id));
  var log = appendLog_(ctx, "stamp", "payment", id, summarize("stamp", "payment", null, saved), null, saved);
  return ok_({ payment: saved, logId: log.id }, bumpRev_());
}

function setPaymentRemoved_(args, ctx, removed) {
  var id = idArg_(args);
  if (!id) return err_("bad_input", MSG_.badId);
  var row = findRow_("Settlements", id);
  if (!row) return err_("not_found", MSG_.noPayment);
  var cur = paymentFromRow(row);
  if (cur.removed === removed) return ok_({ payment: cur, logId: null }, rev_());
  var saved = paymentFromRow(updateById_("Settlements", id, { removed_at: removed ? nowIso_() : "" }));
  var action = removed ? "unstamp" : "restamp";
  var log = appendLog_(ctx, action, "payment", id, summarize(action, "payment", cur, saved), cur, saved);
  return ok_({ payment: saved, logId: log.id }, bumpRev_());
}

// ---- people ----

function setPerson_(args, ctx) {
  if (typeof args.name !== "string") return err_("bad_input", MSG_.badRequest);
  var v = validatePersonPatch(args.patch);
  if (!v.ok) return err_("bad_input", v.message);
  var row = null;
  peopleRows_().forEach(function (r) { if (!row && cellText_(r.name) === args.name) row = r; });
  if (!row) return err_("not_found", MSG_.noPerson);
  var cur = personFromRow(row);
  var changed = Object.keys(v.value).some(function (k) { return cur[k] !== v.value[k]; });
  if (!changed) return ok_({ person: cur }, rev_());
  var saved = personFromRow(updateWhere_("People", "name", args.name, v.value));
  // A new e-Transfer address is where money gets sent: it goes in the Log.
  // The address itself is only in the snapshots (the Sheet), never the sentence.
  // A Simplify flip alone is a reading preference and is not logged.
  if (saved.etransfer !== cur.etransfer) {
    var was = { name: cur.name, etransfer: cur.etransfer };
    var now = { name: saved.name, etransfer: saved.etransfer };
    appendLog_(ctx, "edit", "person", saved.name, summarize("edit", "person", was, now), was, now);
  }
  return ok_({ person: saved }, bumpRev_());
}

// ---- undo ----

function undo_(args, ctx) {
  var raw = args.logId;
  var logId = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!isFinite(logId)) return err_("bad_input", MSG_.badLogId);
  var rows = logRows_();
  var row = null;
  for (var i = 0; i < rows.length; i++) if (Number(rows[i].id) === logId) { row = rows[i]; break; }
  if (!row) return err_("not_found", MSG_.noLog);

  var entry = parseLogRow(row);
  if (entry.kind !== "expense" && entry.kind !== "payment") return err_("stale", MSG_.cantUndo);
  if (entry.undoneBy !== null) return err_("stale", MSG_.undone);
  if (!canUndo(entry, rows.map(logShape_))) return err_("stale", MSG_.newer);
  if (!entry.before && !entry.after) return err_("stale", MSG_.cantUndo);

  var isExpense = entry.kind === "expense";
  var tab = isExpense ? "Expenses" : "Settlements";
  var curRow = findRow_(tab, entry.ref);
  if (!curRow) return err_("not_found", isExpense ? MSG_.noExpense : MSG_.noPayment);
  var target = undoTarget(entry);
  var cur, patch, saved;
  // Every editable column plus deleted_at / removed_at; never rate, added_by/at or stamped_by/at.
  // An item that is already marked keeps its original timestamp (undefined is not written).
  if (isExpense) {
    cur = expenseFromRow(curRow);
    patch = expenseToRow(editableOf_(target));
    patch.deleted_at = target.deleted ? (cur.deleted ? undefined : nowIso_()) : "";
    saved = expenseFromRow(updateById_(tab, entry.ref, patch));
  } else {
    cur = paymentFromRow(curRow);
    patch = paymentToRow(paymentEditableOf_(target));
    patch.removed_at = target.removed ? (cur.removed ? undefined : nowIso_()) : "";
    saved = paymentFromRow(updateById_(tab, entry.ref, patch));
  }

  var log = appendLog_(ctx, "undo", entry.kind, entry.ref, "undid: " + entry.summary, entry.after || cur, saved, entry.id);
  updateById_("Log", entry.id, { undone_by: log.id });
  var rev = bumpRev_();
  var shown = logShape_(log);
  shown.canUndo = true;
  var data = { entry: shown, logId: log.id };
  data[entry.kind] = saved;
  return ok_(data, rev);
}
