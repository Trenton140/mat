// Every request is handled here: handle_(body) -> response envelope.
// This file reaches the outside world only through these primitives, defined
// elsewhere (Sheets.js, Env.js, Rate.js on Apps Script; in memory in
// tests/fake-backend.cjs):
//   readTable_, appendObj_, updateById_, updateWhere_, ensureColumns_, hasColumn_,
//   getProp_, setProp_, withLock_, getRate_, getRateInfo_, tripKey_, nowIso_, sheetUrl_,
//   claudeToken_, ensureClaudeToken_, newId_, plannerId_, setPlannerId_, plannerRows_
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
  noStop: "That stop isn’t there any more.",
  noStay: "That stay isn’t there any more.",
  noDay: "That day isn’t on this trip.",
  stopPatchKey: "Only a stop’s details can be changed.",
  badLogId: "That didn’t say which change to undo.",
  noLog: "That change isn’t in the history.",
  undone: "That’s already been undone.",
  newer: "That was changed again since. Undo the newer change first.",
  cantUndo: "That change can’t be undone.",
  badHistory: "That history request didn’t come through properly.",
  server: "Something went wrong on our side. Try again.",
  noClaude: "The Claude link isn’t set up yet. Ask Mo to run migrate.",
  noPlanner: "No planner sheet is linked yet. Ask Mo to link it.",
  plannerUnreadable: "Couldn’t read the planner sheet. Ask Mo to check its permission.",
  badPlannerId: "That isn’t a spreadsheet id.",
  plannerLinked: "A planner is already linked.",
  needsMigrate: "The trip sheet needs updating first. Ask Mo to run migrate.",
  notInPlanner: "That payment isn’t in the planner any more.",
  twoLines: "Two lines carry this payment’s id.",
  notYourPicture: "You can only change your own picture.",
};

// A Google spreadsheet id, as linkPlanner takes it.
var PLANNER_SHEET_ID_RE_ = /^[A-Za-z0-9_-]{20,80}$/;
// The most expenses one pull adds or changes (R40), so it never holds the lock long.
var PLANNER_MAX_WRITES_ = 10;

// The trip plan: stops, stays and day headers differ only in these. `key` is
// the column a row is found by (and the Log's ref); `fields` are the API
// fields a person can change; `deletable` ones have a deleted_at column.
// Built on call, not at load: Apps Script runs Actions.js before Pure.js.
// Any other kind gives null.
function planKind_(kind) {
  if (kind === "stop") {
    return {
      tab: "Stops", key: "id", deletable: true, fromRow: stopFromRow, toRow: stopToRow, missing: MSG_.noStop,
      fields: ["date", "time", "title", "detail", "gettingThere", "travelMin", "fixed", "place", "signJp", "booked", "link", "photo", "note"],
    };
  }
  if (kind === "stay") {
    return {
      tab: "Stays", key: "id", deletable: true, fromRow: stayFromRow, toRow: stayToRow, missing: MSG_.noStay,
      fields: ["name", "nameJp", "addressJp", "firstNight", "lastNight", "note", "place", "link"],
    };
  }
  if (kind === "day") return { tab: "Days", key: "date", deletable: false, fromRow: dayFromRow, toRow: dayToRow, missing: MSG_.noDay, fields: DAY_PATCH_KEYS };
  return null;
}

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
  if (action === "migrate") {
    return withLock_(function () {
      var added = ensureColumns_();
      ensureClaudeToken_();
      return ok_({ added: added }, rev_());
    });
  }
  // The Claude connector's token, for Settings to copy into a link. Never logged.
  if (action === "claudeLink") {
    var token = claudeToken_();
    return token ? ok_({ token: token }, rev_()) : err_("not_found", MSG_.noClaude);
  }
  // The planner sheet's id (R39), run once from a terminal. Not logged, never
  // given back. Only while none is linked (R40): changing it means deleting
  // PLANNER_ID in the script editor.
  if (action === "linkPlanner") {
    if (plannerId_()) return err_("bad_input", MSG_.plannerLinked);
    if (typeof args.id !== "string" || !PLANNER_SHEET_ID_RE_.test(args.id)) return err_("bad_input", MSG_.badPlannerId);
    setPlannerId_(args.id);
    return ok_({ linked: true }, rev_());
  }

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
    case "addStop": write = addStop_; break;
    case "updateStop": write = updateStop_; break;
    case "deleteStop": write = function (a, c) { return setPlanDeleted_("stop", a, c, true); }; break;
    case "restoreStop": write = function (a, c) { return setPlanDeleted_("stop", a, c, false); }; break;
    case "saveStay": write = saveStay_; break;
    case "deleteStay": write = function (a, c) { return setPlanDeleted_("stay", a, c, true); }; break;
    case "restoreStay": write = function (a, c) { return setPlanDeleted_("stay", a, c, false); }; break;
    case "setDay": write = setDay_; break;
    case "undo": write = undo_; break;
    case "syncPayments": write = null; break;
    default: return err_("bad_input", MSG_.badAction);
  }
  var names = peopleNames_();
  if (typeof body.actor !== "string" || names.indexOf(body.actor) === -1) return err_("bad_input", MSG_.badActor);
  var ctx = { actor: body.actor, via: body.via === "claude" ? "claude" : "app", names: names };
  // Reads the planner first, then takes the lock itself.
  if (action === "syncPayments") return syncPayments_(ctx);
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

// The Trip tab as { key: value }.
function tripInfo_() {
  var trip = {};
  readTable_("Trip").forEach(function (r) {
    var k = cellText_(r.key).trim();
    if (k) trip[k] = cellDate_(r.value);
  });
  return trip;
}

function load_() {
  var rev = rev_();
  var rate = getRateInfo_();
  return ok_({
    trip: tripInfo_(),
    people: peopleRows_().map(personFromRow),
    days: readTable_("Days").filter(function (r) { return cellDate_(r.date) !== ""; }).map(dayFromRow),
    stops: readTable_("Stops").filter(function (r) { return cellText_(r.id) !== ""; }).map(stopFromRow),
    stays: readTable_("Stays").filter(function (r) { return cellText_(r.id) !== ""; }).map(stayFromRow),
    expenses: readTable_("Expenses").filter(function (r) { return cellText_(r.id) !== ""; }).map(expenseFromRow),
    payments: readTable_("Settlements").filter(function (r) { return cellText_(r.id) !== ""; }).map(paymentFromRow),
    rateToday: rate.rate,
    rateSource: rate.source,
    sheetUrl: sheetUrl_(),
    plannerLinked: plannerId_() !== null,
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
  // A line a planner pull adds is tied to its payment (R40). Only the pull's
  // own ctx carries it; nothing a phone sends can.
  if (ctx.plannerId) row.planner_id = ctx.plannerId;
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
  return editExpense_(id, patch, ctx, false);
}

// The edit itself, for updateExpense and the planner pull. The app's own
// edits write every editable column; onlyChanged (the pull) writes only the
// columns that change, so a hand-typed cell the change leaves alone stays.
function editExpense_(id, patch, ctx, onlyChanged) {
  var row = findRow_("Expenses", id);
  if (!row) return err_("not_found", MSG_.noExpense);
  var cur = expenseFromRow(row);
  if (cur.deleted) return err_("bad_input", MSG_.editDeleted);

  // Validate the whole line as it would be, not the patch alone.
  var merged = editableOf_(cur);
  Object.keys(patch).forEach(function (k) { merged[k] = patch[k]; });
  merged.id = id;
  var v = validateExpense(merged, ctx.names);
  if (!v.ok) return err_("bad_input", v.message);

  var cols = expenseToRow(editableOf_(v.value));
  var was = expenseToRow(editableOf_(cur));
  if (same_(cols, was)) return ok_({ expense: cur, logId: null }, rev_());
  if (onlyChanged) Object.keys(was).forEach(function (k) { if (same_(cols[k], was[k])) delete cols[k]; });
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

// ---- payments from the planner sheet (R39, R40) ----
// A pull reads the planner (never writes it), then, under the lock and
// against the Sheet as it is then, brings the planner's fields of each line
// tied to an included payment up to date and adds the payments with no line,
// through editExpense_ and addExpense_: validated, logged (via "planner") and
// undoable like any other change. At most PLANNER_MAX_WRITES_ of those per
// pull, changes first. A line is tied to its payment by its planner_id cell,
// which only a pull writes; a line rung up by hand whose note starts with a
// payment id in the planner is tied the first time (no Log row, no rev). A
// line deleted in the app stays deleted; nothing is deleted by a pull. The
// planner's id is never in a reply, and neither is a planner cell that is not
// part of a payment the app can use.

function syncPayments_(ctx) {
  if (!plannerId_()) return err_("no_planner", MSG_.noPlanner);
  if (!hasColumn_("Expenses", "planner_id")) return err_("needs_migrate", MSG_.needsMigrate);
  var rows;
  try {
    rows = plannerRows_();
  } catch (e) {
    return err_("planner_unreadable", MSG_.plannerUnreadable);
  }
  var read = paymentsFromRows(rows);
  if (read.missing) return err_("planner_columns", read.missing);
  var pull = { actor: ctx.actor, via: "planner", names: ctx.names };
  // As for addExpense: fetching the day's rate can take a few seconds.
  if (read.payments.some(function (p) { return p.include; })) pull.rate = getRate_();
  return withLock_(function () { return pullPayments_(read, pull); });
}

function pullPayments_(read, ctx) {
  var dayDates = tripDates_();
  var inPlanner = {};
  read.payments.forEach(function (p) { inPlanner[p.id] = true; });
  // The Expenses tab, read once: each line with the payment it is tied to.
  var lines = readTable_("Expenses")
    .filter(function (r) { return cellText_(r.id) !== ""; })
    .map(function (r) { return { e: expenseFromRow(r), pid: cellText_(r.planner_id) }; });
  lines.forEach(function (l) {
    if (l.pid !== "") return;
    var pid = paymentIdOf(l.e.note);
    if (pid === null || !inPlanner[pid]) return;
    updateById_("Expenses", l.e.id, { planner_id: pid });
    l.pid = pid;
  });

  var out = { added: 0, changed: 0, same: 0, removed: 0, notCounted: [], problems: read.problems.slice(), more: false, capped: read.capped };
  // A tie to a payment the planner no longer lists (renamed or removed there).
  // Not said when the planner was cut at 300: the rest were not read.
  if (!read.capped) {
    lines.forEach(function (l) {
      if (l.pid !== "" && !l.e.deleted && !inPlanner[l.pid]) out.problems.push({ id: l.pid, message: MSG_.notInPlanner });
    });
  }
  var edits = [];
  var adds = [];
  read.payments.forEach(function (p) {
    var tied = lines.filter(function (l) { return l.pid === p.id; });
    var live = tied.filter(function (l) { return !l.e.deleted; });
    if (!p.include) {
      if (live.length) out.notCounted.push(p.id);
      return;
    }
    var x = expenseFromPayment(p, ctx.names, dayDates);
    if (!x.ok) {
      out.problems.push({ id: p.id, message: x.message });
      return;
    }
    if (live.length > 1) {
      out.problems.push({ id: p.id, message: MSG_.twoLines });
      return;
    }
    if (live.length === 1) {
      var patch = plannerPatch_(live[0].e, x.value);
      if (Object.keys(patch).length === 0) out.same++;
      else edits.push({ id: p.id, line: live[0].e.id, patch: patch });
      return;
    }
    if (tied.length) {
      out.removed++;
      return;
    }
    var e = x.value;
    e.id = newId_();
    adds.push({ id: p.id, expense: e });
  });

  var writes = 0;
  var tried = function (job, r, counted) {
    if (!r.ok) out.problems.push({ id: job.id, message: r.message });
    else if (r.data.logId === null) out.same++;
    else {
      out[counted]++;
      writes++;
    }
  };
  edits.forEach(function (job) {
    if (writes === PLANNER_MAX_WRITES_) {
      out.more = true;
      return;
    }
    tried(job, editExpense_(job.line, job.patch, ctx, true), "changed");
  });
  adds.forEach(function (job) {
    if (writes === PLANNER_MAX_WRITES_) {
      out.more = true;
      return;
    }
    var withTie = { actor: ctx.actor, via: ctx.via, names: ctx.names, rate: ctx.rate, plannerId: job.id };
    tried(job, addExpense_({ expense: job.expense }, withTie), "added");
  });
  return ok_(out, rev_());
}

// The fields the planner owns that differ: title, amount, currency, payer,
// note, and the split (the same people in any order is the same split). The
// planner's payments are equal splits: a line set to shares or exact amounts
// in the app is put back to equal.
function plannerPatch_(cur, v) {
  var patch = {};
  ["title", "amount", "currency", "paidBy", "note"].forEach(function (k) { if (cur[k] !== v[k]) patch[k] = v[k]; });
  if (!same_(cur.split.slice().sort(), v.split.slice().sort()) || cur.splitMode !== "equal") {
    patch.split = v.split;
    patch.splitMode = "equal";
  }
  return patch;
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
  // A picture is only ever set by its owner (Task 16), and needs its column.
  if ("photo" in v.value) {
    if (args.name !== ctx.actor) return err_("bad_input", MSG_.notYourPicture);
    if (!hasColumn_("People", "photo")) return err_("needs_migrate", MSG_.needsMigrate);
  }
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
  // A picture change is its own entry, kind "picture", so it can be undone
  // without making an e-Transfer change undoable. Its snapshots hold the
  // picture so undo can put it back; History never sends them to the phones.
  if (saved.photo !== cur.photo) {
    var hadPic = { name: cur.name, photo: cur.photo };
    var hasPic = { name: saved.name, photo: saved.photo };
    appendLog_(ctx, "edit", "picture", saved.name, summarize("edit", "picture", hadPic, hasPic), hadPic, hasPic);
  }
  return ok_({ person: saved }, bumpRev_());
}

// Undoing a picture change puts back the picture that was there (or none).
// Only its owner may: nobody changes another person's picture (Task 16).
// Answers like any undo, with the person as the item.
function undoPicture_(entry, rows, ctx) {
  if (entry.ref !== ctx.actor) return err_("bad_input", MSG_.notYourPicture);
  if (entry.undoneBy !== null) return err_("stale", MSG_.undone);
  if (!canUndo(entry, rows.map(logShape_))) return err_("stale", MSG_.newer);
  if (!entry.before || !entry.after) return err_("stale", MSG_.cantUndo);
  var row = null;
  peopleRows_().forEach(function (r) { if (!row && cellText_(r.name) === entry.ref) row = r; });
  if (!row) return err_("not_found", MSG_.noPerson);
  if (!hasColumn_("People", "photo")) return err_("needs_migrate", MSG_.needsMigrate);
  var cur = personFromRow(row);
  var target = undoTarget(entry);
  var photo = typeof target.photo === "string" ? target.photo : "";
  var saved = personFromRow(updateWhere_("People", "name", entry.ref, { photo: photo }));
  var log = appendLog_(ctx, "undo", "picture", entry.ref, "undid: " + entry.summary, { name: cur.name, photo: cur.photo }, { name: saved.name, photo: saved.photo }, entry.id);
  updateById_("Log", entry.id, { undone_by: log.id });
  var rev = bumpRev_();
  var shown = logShape_(log);
  shown.canUndo = true;
  return ok_({ entry: shown, logId: log.id, person: saved }, rev);
}

// ---- the trip plan: stops, stays, day headers ----

// The row whose key cell (an id, or a day's date) is ref. Dates go through
// cellDate_ in case Sheets hands a date cell back as a Date.
function findPlanRow_(plan, ref) {
  var rows = readTable_(plan.tab);
  for (var i = 0; i < rows.length; i++) if (cellDate_(rows[i][plan.key]) === ref) return rows[i];
  return null;
}

// The fields of an item a person can change, as a fresh object.
function planFields_(plan, item) {
  var out = {};
  plan.fields.forEach(function (f) { out[f] = item[f]; });
  return out;
}

// The columns of next that differ from cur, both cleaned items. Only these
// are written: a column the change leaves alone keeps whatever the Sheet
// holds, even a hand-typed value the reader cleans away (9:30, a bare link).
function changedCols_(plan, cur, next) {
  var was = plan.toRow(planFields_(plan, cur));
  var now = plan.toRow(planFields_(plan, next));
  var out = {};
  Object.keys(now).forEach(function (k) { if (!same_(now[k], was[k])) out[k] = now[k]; });
  return out;
}

function writePlan_(plan, ref, patch) {
  return plan.fromRow(updateWhere_(plan.tab, plan.key, ref, patch));
}

function tripDates_() {
  return readTable_("Days").map(function (r) { return cellDate_(r.date); }).filter(function (d) { return d !== ""; });
}

// Appends a new stop or stay, or returns the one already there with the id
// of the Log row that added it (a repeated add).
function addPlanItem_(kind, value, ctx) {
  var plan = planKind_(kind);
  var id = value.id;
  var existing = findPlanRow_(plan, id);
  if (existing) return ok_(planReply_(kind, plan.fromRow(existing), firstLogId_(kind, id, "add")), rev_());
  var row = plan.toRow(value);
  row.deleted_at = "";
  appendObj_(plan.tab, row);
  var saved = plan.fromRow(findPlanRow_(plan, id));
  var log = appendLog_(ctx, "add", kind, id, summarize("add", kind, null, saved), null, saved);
  return ok_(planReply_(kind, saved, log.id), bumpRev_());
}

// Writes an edit of an existing item (cur) to the values in next, unless
// nothing changes. ref is the item's key (its id, or a day's date).
function editPlanItem_(kind, ref, cur, next, ctx) {
  var plan = planKind_(kind);
  var cols = changedCols_(plan, cur, next);
  if (Object.keys(cols).length === 0) return ok_(planReply_(kind, cur, null), rev_());
  var saved = writePlan_(plan, ref, cols);
  var log = appendLog_(ctx, "edit", kind, ref, summarize("edit", kind, cur, saved), cur, saved);
  return ok_(planReply_(kind, saved, log.id), bumpRev_());
}

function planReply_(kind, item, logId) {
  var data = { logId: logId };
  data[kind] = item;
  return data;
}

function addStop_(args, ctx) {
  var v = validateStop(args.stop, tripDates_());
  if (!v.ok) return err_("bad_input", v.message);
  return addPlanItem_("stop", v.value, ctx);
}

function updateStop_(args, ctx) {
  var plan = planKind_("stop");
  var id = idArg_(args);
  if (!id) return err_("bad_input", MSG_.badId);
  var patch = args.patch;
  if (!isObj_(patch)) return err_("bad_input", MSG_.badPatch);
  var keys = Object.keys(patch);
  for (var i = 0; i < keys.length; i++) {
    if (plan.fields.indexOf(keys[i]) === -1) return err_("bad_input", MSG_.stopPatchKey);
  }
  var row = findPlanRow_(plan, id);
  if (!row) return err_("not_found", plan.missing);
  var cur = plan.fromRow(row);
  if (cur.deleted) return err_("bad_input", MSG_.editDeleted);

  // Validate the whole stop as it would be, not the patch alone.
  var merged = planFields_(plan, cur);
  keys.forEach(function (k) { merged[k] = patch[k]; });
  merged.id = id;
  var v = validateStop(merged, tripDates_());
  if (!v.ok) return err_("bad_input", v.message);
  return editPlanItem_("stop", id, cur, v.value, ctx);
}

// A new id adds the stay; a known one edits it. With merge: true (the Claude
// connector) the stay must already be there, and the fields given are laid
// over the row as it is now, under the lock, so a field left out keeps
// whatever another phone just saved. The merged stay is validated whole.
function saveStay_(args, ctx) {
  var plan = planKind_("stay");
  if (args.merge !== undefined && typeof args.merge !== "boolean") return err_("bad_input", MSG_.badRequest);
  var input = args.stay;
  if (args.merge === true && isObj_(input) && typeof input.id === "string") {
    var found = input.id === "" ? null : findPlanRow_(plan, input.id);
    if (!found) return err_("not_found", plan.missing);
    var was = plan.fromRow(found);
    if (was.deleted) return err_("bad_input", MSG_.editDeleted);
    var merged = planFields_(plan, was);
    plan.fields.forEach(function (k) { if (input[k] !== undefined) merged[k] = input[k]; });
    merged.id = was.id;
    input = merged;
  }
  var v = validateStay(input);
  if (!v.ok) return err_("bad_input", v.message);
  var row = findPlanRow_(plan, v.value.id);
  if (!row) return addPlanItem_("stay", v.value, ctx);
  var cur = plan.fromRow(row);
  if (cur.deleted) return err_("bad_input", MSG_.editDeleted);
  return editPlanItem_("stay", cur.id, cur, v.value, ctx);
}

function setPlanDeleted_(kind, args, ctx, deleted) {
  var plan = planKind_(kind);
  var id = idArg_(args);
  if (!id) return err_("bad_input", MSG_.badId);
  var row = findPlanRow_(plan, id);
  if (!row) return err_("not_found", plan.missing);
  var cur = plan.fromRow(row);
  if (cur.deleted === deleted) return ok_(planReply_(kind, cur, null), rev_());
  var saved = writePlan_(plan, id, { deleted_at: deleted ? nowIso_() : "" });
  var action = deleted ? "delete" : "restore";
  var log = appendLog_(ctx, action, kind, id, summarize(action, kind, cur, saved), cur, saved);
  return ok_(planReply_(kind, saved, log.id), bumpRev_());
}

function setDay_(args, ctx) {
  var plan = planKind_("day");
  if (typeof args.date !== "string") return err_("bad_input", MSG_.badRequest);
  var v = validateDayPatch(args.patch);
  if (!v.ok) return err_("bad_input", v.message);
  var row = args.date === "" ? null : findPlanRow_(plan, args.date);
  if (!row) return err_("not_found", plan.missing);
  var cur = plan.fromRow(row);
  var next = planFields_(plan, cur);
  Object.keys(v.value).forEach(function (k) { next[k] = v.value[k]; });
  return editPlanItem_("day", cur.date, cur, next, ctx);
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
  if (entry.kind === "picture") return undoPicture_(entry, rows, ctx);
  var plan = planKind_(entry.kind);
  if (entry.kind !== "expense" && entry.kind !== "payment" && !plan) return err_("stale", MSG_.cantUndo);
  if (entry.undoneBy !== null) return err_("stale", MSG_.undone);
  if (!canUndo(entry, rows.map(logShape_))) return err_("stale", MSG_.newer);
  if (!entry.before && !entry.after) return err_("stale", MSG_.cantUndo);

  var isExpense = entry.kind === "expense";
  var tab = isExpense ? "Expenses" : "Settlements";
  var curRow = plan ? findPlanRow_(plan, entry.ref) : findRow_(tab, entry.ref);
  if (!curRow) return err_("not_found", plan ? plan.missing : isExpense ? MSG_.noExpense : MSG_.noPayment);
  var target = undoTarget(entry);
  var cur, patch, saved;
  // Every editable column plus deleted_at / removed_at; never rate, added_by/at or stamped_by/at.
  // An item that is already marked keeps its original timestamp (undefined is not written).
  // A plan item writes back every field that differs from now, blanks included.
  if (plan) {
    cur = plan.fromRow(curRow);
    patch = changedCols_(plan, cur, target);
    if (plan.deletable) patch.deleted_at = target.deleted ? (cur.deleted ? undefined : nowIso_()) : "";
    saved = writePlan_(plan, entry.ref, patch);
  } else if (isExpense) {
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
