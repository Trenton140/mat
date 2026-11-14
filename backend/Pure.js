// Pure logic. Plain global functions so Apps Script can run it as-is;
// the footer lets Node tests load the same file.

var TABS = {
  Trip: ["key", "value"],
  People: ["name", "initials", "order", "etransfer", "simplify", "email"],
  Days: ["date", "city", "title", "line_jp", "line_en", "line_colour", "from_jp", "from_en", "to_jp", "to_en"],
  Stops: ["id", "date", "time", "title", "detail", "getting_there", "travel_min", "fixed", "place", "sign_jp", "booked", "link", "photo", "note", "deleted_at"],
  Stays: ["id", "name", "name_jp", "address_jp", "first_night", "last_night", "note", "place", "link"],
  Expenses: ["id", "day", "title", "amount", "currency", "rate", "paid_by", "split", "split_mode", "split_vals", "note", "kind", "receipt", "added_by", "added_at", "deleted_at"],
  Settlements: ["id", "from", "to", "cad", "stamped_by", "stamped_at", "seed", "rot", "removed_at"],
  Log: ["id", "at", "who", "via", "action", "kind", "ref", "summary", "before", "after", "undoes", "undone_by"],
};

var KINDS = ["food", "transport", "stay", "activity", "shopping"];

// Every column is plain text (so Sheets never turns "1/2" into a date or
// "0012" into 12) except these numbers and booleans.
var NUMBER_COLUMNS_ = ["amount", "rate", "cad", "seed", "rot", "order", "travel_min"];
var LOG_NUMBER_COLUMNS_ = ["id", "undoes", "undone_by"];
var BOOLEAN_COLUMNS_ = ["simplify", "fixed", "booked"];

function isTextColumn(tab, header) {
  if (NUMBER_COLUMNS_.indexOf(header) !== -1 || BOOLEAN_COLUMNS_.indexOf(header) !== -1) return false;
  if (tab === "Log" && LOG_NUMBER_COLUMNS_.indexOf(header) !== -1) return false;
  return true;
}

var ID_RE_ = /^[A-Za-z0-9][A-Za-z0-9_-]{7,39}$/;
var DAY_RE_ = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeCell(v) {
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(v)) return "'" + v;
  return v;
}

function rowToObj(headers, row) {
  var o = {};
  for (var i = 0; i < headers.length; i++) o[headers[i]] = i < row.length ? row[i] : "";
  return o;
}

function objToRow(headers, obj) {
  return headers.map(function (h) {
    var v = obj[h];
    return v === undefined || v === null ? "" : sanitizeCell(v);
  });
}

// ---- input checking ----

function fail_(message) { return { ok: false, message: message }; }

function isObj_(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

function round2_(n) {
  var s = String(n);
  if (s.indexOf("e") !== -1) return Math.round(n * 100) / 100;
  return Number(Math.round(Number(s + "e2")) + "e-2");
}

function cents_(n) { return Math.round(Number(String(round2_(n)) + "e2")); }

function realDay_(s) {
  var y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  var dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= dim[m - 1];
}

function validateExpense(input, peopleNames) {
  if (!isObj_(input)) return fail_("That didn't come through properly.");
  var id = input.id, day = input.day, title = input.title, amount = input.amount;
  if (typeof id !== "string" || !ID_RE_.test(id)) return fail_("That line has a bad id.");
  if (typeof day !== "string" || (day !== "pre" && (!DAY_RE_.test(day) || !realDay_(day)))) return fail_("Pick a day.");
  if (typeof title !== "string") return fail_("Say what it was for.");
  title = title.trim();
  if (!title) return fail_("Say what it was for.");
  if (title.length > 80) return fail_("Keep the name under 80 letters.");
  if (typeof amount !== "number" || !isFinite(amount)) return fail_("Put in an amount.");
  if (input.currency !== "JPY" && input.currency !== "CAD") return fail_("Use yen or Canadian dollars.");
  var currency = input.currency;
  amount = currency === "JPY" ? Math.round(amount) : round2_(amount);
  if (!(amount > 0)) return fail_("The amount has to be more than zero.");
  if (amount > 10000000) return fail_("That amount is too big.");
  if (typeof input.paidBy !== "string" || peopleNames.indexOf(input.paidBy) === -1) return fail_("Pick who paid.");
  var split = input.split;
  if (!Array.isArray(split) || split.length === 0) return fail_("Pick who shares it.");
  for (var i = 0; i < split.length; i++) {
    if (typeof split[i] !== "string" || peopleNames.indexOf(split[i]) === -1) return fail_("Someone in the split isn't on this trip.");
    if (split.indexOf(split[i]) !== i) return fail_("Someone is in the split twice.");
  }
  var note = input.note === undefined || input.note === null ? "" : input.note;
  if (typeof note !== "string") return fail_("The note didn't come through properly.");
  note = note.trim();
  if (note.length > 200) return fail_("Keep the note under 200 letters.");
  var kind = input.kind === undefined || input.kind === null ? "" : input.kind;
  if (kind !== "" && KINDS.indexOf(kind) === -1) return fail_("That kind isn't one we know.");
  var mode = input.splitMode === undefined || input.splitMode === null || input.splitMode === "" ? "equal" : input.splitMode;
  var vals = input.splitVals === undefined || input.splitVals === null ? [] : input.splitVals;
  if (!Array.isArray(vals)) return fail_("The split didn't come through properly.");
  if (mode === "equal") {
    vals = [];
  } else if (mode === "parts") {
    if (vals.length !== split.length) return fail_("Give every person a share.");
    for (var p = 0; p < vals.length; p++) {
      if (typeof vals[p] !== "number" || vals[p] % 1 !== 0 || vals[p] < 1 || vals[p] > 99) return fail_("Shares must be whole numbers from 1 to 99.");
    }
  } else if (mode === "exact") {
    if (vals.length !== split.length) return fail_("Give every person an amount.");
    var sum = 0;
    var rounded = [];
    for (var x = 0; x < vals.length; x++) {
      var v = vals[x];
      if (typeof v !== "number" || !isFinite(v) || !(v > 0)) return fail_("Every amount has to be more than zero.");
      var units = currency === "JPY" ? Math.round(v) : cents_(v);
      if (units < 1) return fail_("Every amount has to be at least " + (currency === "JPY" ? "one yen." : "one cent."));
      sum += units;
      rounded.push(currency === "JPY" ? units : units / 100);
    }
    var total = currency === "JPY" ? amount : cents_(amount);
    if (sum !== total) return fail_("The amounts don't add up to the total.");
    vals = rounded;
  } else {
    return fail_("That way of splitting isn't one we know.");
  }
  return {
    ok: true,
    value: { id: id, day: day, title: title, amount: amount, currency: currency, paidBy: input.paidBy, split: split.slice(), splitMode: mode, splitVals: vals.slice(), note: note, kind: kind },
  };
}

function validatePayment(input, peopleNames) {
  if (!isObj_(input)) return fail_("That didn't come through properly.");
  if (typeof input.id !== "string" || !ID_RE_.test(input.id)) return fail_("That payment has a bad id.");
  if (typeof input.from !== "string" || peopleNames.indexOf(input.from) === -1) return fail_("Pick who paid.");
  if (typeof input.to !== "string" || peopleNames.indexOf(input.to) === -1) return fail_("Pick who got paid.");
  if (input.from === input.to) return fail_("Nobody can pay themselves.");
  if (typeof input.cad !== "number" || !isFinite(input.cad)) return fail_("Put in an amount.");
  var cad = round2_(input.cad);
  if (!(cad > 0)) return fail_("The amount has to be more than zero.");
  if (cad > 100000) return fail_("That amount is too big.");
  if (typeof input.seed !== "number" || input.seed % 1 !== 0 || input.seed < 1) return fail_("That payment is missing its stamp.");
  if (typeof input.rot !== "number" || !isFinite(input.rot)) return fail_("That payment is missing its stamp.");
  return { ok: true, value: { id: input.id, from: input.from, to: input.to, cad: cad, seed: input.seed, rot: input.rot } };
}

function validatePersonPatch(patch) {
  if (!isObj_(patch)) return fail_("That didn't come through properly.");
  var out = {};
  var keys = Object.keys(patch);
  if (keys.length === 0) return fail_("Nothing to change.");
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (k === "etransfer") {
      if (typeof patch.etransfer !== "string") return fail_("The e-Transfer address didn't come through properly.");
      var t = patch.etransfer.trim();
      if (t.length > 80) return fail_("Keep the e-Transfer address under 80 letters.");
      out.etransfer = t;
    } else if (k === "simplify") {
      if (typeof patch.simplify !== "boolean") return fail_("Simplify has to be on or off.");
      out.simplify = patch.simplify;
    } else {
      return fail_("You can only change the e-Transfer address and Simplify.");
    }
  }
  return { ok: true, value: out };
}

// ---- sheet row -> API shape ----

function cellDate_(v) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return "";
    if (typeof Utilities !== "undefined" && typeof Session !== "undefined") return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
    return v.toISOString().slice(0, 10);
  }
  return v === undefined || v === null ? "" : String(v);
}

function cellStamp_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? "" : v.toISOString();
  return v === undefined || v === null ? "" : String(v);
}

function cellText_(v) { return v === undefined || v === null ? "" : String(v); }

function cellNum_(v) {
  if (v === "" || v === undefined || v === null) return 0;
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

function cellList_(v) {
  if (v === undefined || v === null || v === "") return [];
  if (Array.isArray(v)) return v.map(cellText_);
  return String(v).split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s !== ""; });
}

function cellSet_(v) { return v !== undefined && v !== null && v !== "" && !(v instanceof Date && isNaN(v.getTime())); }

function expenseFromRow(o) {
  return {
    id: cellText_(o.id),
    day: cellDate_(o.day),
    title: cellText_(o.title),
    amount: cellNum_(o.amount),
    currency: cellText_(o.currency),
    rate: cellNum_(o.rate),
    paidBy: cellText_(o.paid_by),
    split: cellList_(o.split),
    splitMode: cellText_(o.split_mode) || "equal",
    splitVals: cellList_(o.split_vals).map(Number),
    note: cellText_(o.note),
    kind: cellText_(o.kind),
    addedBy: cellText_(o.added_by),
    addedAt: cellStamp_(o.added_at),
    deleted: cellSet_(o.deleted_at),
  };
}

function paymentFromRow(o) {
  return {
    id: cellText_(o.id),
    from: cellText_(o.from),
    to: cellText_(o.to),
    cad: cellNum_(o.cad),
    stampedBy: cellText_(o.stamped_by),
    stampedAt: cellStamp_(o.stamped_at),
    seed: cellNum_(o.seed),
    rot: cellNum_(o.rot),
    removed: cellSet_(o.removed_at),
  };
}

function personFromRow(o) {
  var off = o.simplify === false || String(o.simplify).trim().toUpperCase() === "FALSE";
  return { name: cellText_(o.name), initials: cellText_(o.initials), etransfer: cellText_(o.etransfer), simplify: !off };
}

// ---- API shape -> sheet row ----
// Timestamps (added_at, deleted_at, stamped_at, removed_at) are left to the
// action that writes the row. Optional fields that are absent are left out, so
// the result can also be used as a patch.

function put_(o, key, v) { if (v !== undefined) o[key] = v; }

function expenseToRow(e) {
  var o = {};
  put_(o, "id", e.id);
  put_(o, "day", e.day);
  put_(o, "title", e.title);
  put_(o, "amount", e.amount);
  put_(o, "currency", e.currency);
  put_(o, "rate", e.rate);
  put_(o, "paid_by", e.paidBy);
  put_(o, "split", Array.isArray(e.split) ? e.split.join(",") : undefined);
  put_(o, "split_mode", e.splitMode);
  put_(o, "split_vals", Array.isArray(e.splitVals) ? e.splitVals.join(",") : undefined);
  put_(o, "note", e.note);
  put_(o, "kind", e.kind);
  put_(o, "added_by", e.addedBy);
  return o;
}

function paymentToRow(p) {
  var o = {};
  put_(o, "id", p.id);
  put_(o, "from", p.from);
  put_(o, "to", p.to);
  put_(o, "cad", p.cad);
  put_(o, "stamped_by", p.stampedBy);
  put_(o, "seed", p.seed);
  put_(o, "rot", p.rot);
  return o;
}

// The rows setup() writes into an empty Sheet (also used by the test backend).
function setupSeedRows() {
  var days = [];
  for (var d = 10; d <= 20; d++) days.push({ date: "2026-12-" + d });
  return {
    Trip: [
      { key: "name", value: "Japan 2026" }, { key: "start", value: "2026-12-10" }, { key: "end", value: "2026-12-20" },
      { key: "home", value: "CAD" }, { key: "currency", value: "JPY" }, { key: "tz", value: "Asia/Tokyo" },
    ],
    People: [
      { name: "Mo", initials: "MO", order: 1, etransfer: "", simplify: true, email: "" },
      { name: "Ajen", initials: "AJ", order: 2, etransfer: "", simplify: true, email: "" },
      { name: "Trenton", initials: "TR", order: 3, etransfer: "", simplify: true, email: "" },
    ],
    Days: days,
  };
}

// ---- history and undo ----

function money_(n, currency) {
  var neg = n < 0;
  var s = currency === "JPY" ? String(Math.round(Math.abs(n))) : Math.abs(n).toFixed(2);
  var parts = s.split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + (currency === "JPY" ? "\u00a5" : "$") + parts.join(".");
}

function same_(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function expenseDiff_(before, after) {
  if (before.amount !== after.amount || before.currency !== after.currency) {
    return "changed " + after.title + " " + money_(before.amount, before.currency) + " \u2192 " + money_(after.amount, after.currency);
  }
  if (before.title !== after.title) return "renamed " + before.title + " to " + after.title;
  var changed = [];
  if (before.paidBy !== after.paidBy) changed.push("payer");
  if (!same_(before.split, after.split) || before.splitMode !== after.splitMode || !same_(before.splitVals, after.splitVals)) changed.push("split");
  if (before.day !== after.day) changed.push("day");
  if (before.note !== after.note) changed.push("note");
  return "changed " + after.title + (changed.length ? ": " + changed.join(", ") : "");
}

function summarize(action, kind, before, after) {
  if (kind === "payment") {
    var pay = after || before;
    var what = pay.from + " \u2192 " + pay.to + " " + money_(pay.cad, "CAD");
    if (action === "stamp") return "stamped " + what;
    if (action === "unstamp") return "removed the stamp " + what;
    if (action === "restamp") return "put back the stamp " + what;
    return "changed the stamp " + what;
  }
  var item = after || before;
  var tag = item.title + " " + money_(item.amount, item.currency);
  if (action === "add") return "rang up " + tag;
  if (action === "delete") return "deleted " + tag;
  if (action === "restore") return "brought back " + tag;
  if (action === "edit" && before && after) return expenseDiff_(before, after);
  return "changed " + item.title;
}

function undoTarget(entry) {
  if (entry.before) return JSON.parse(JSON.stringify(entry.before));
  var t = JSON.parse(JSON.stringify(entry.after));
  if (entry.kind === "payment") t.removed = true;
  else t.deleted = true;
  return t;
}

function canUndo(entry, allEntries) {
  if (entry.undoneBy !== null && entry.undoneBy !== undefined && entry.undoneBy !== "") return false;
  for (var i = 0; i < allEntries.length; i++) {
    var o = allEntries[i];
    if (Number(o.id) > Number(entry.id) && o.kind === entry.kind && String(o.ref) === String(entry.ref)) return false;
  }
  return true;
}

function cellId_(v) {
  if (v === "" || v === undefined || v === null) return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function cellJson_(v) {
  if (v === "" || v === undefined || v === null) return null;
  try { return JSON.parse(String(v)); } catch (e) { return null; }
}

function logShape_(o) {
  return {
    id: Number(o.id),
    at: cellStamp_(o.at),
    who: cellText_(o.who),
    via: o.via === "claude" ? "claude" : "app",
    action: cellText_(o.action),
    kind: cellText_(o.kind),
    ref: cellText_(o.ref),
    summary: cellText_(o.summary),
    undoes: cellId_(o.undoes),
    undoneBy: cellId_(o.undone_by),
  };
}

function parseLogRow(o) {
  var e = logShape_(o);
  e.before = cellJson_(o.before);
  e.after = cellJson_(o.after);
  return e;
}

function entryFromRow(o, allRows) {
  var e = logShape_(o);
  e.canUndo = canUndo(e, allRows.map(logShape_));
  return e;
}

if (typeof module !== "undefined") {
  module.exports = { TABS, KINDS, isTextColumn, sanitizeCell, rowToObj, objToRow, validateExpense, validatePayment, validatePersonPatch, expenseFromRow, paymentFromRow, personFromRow, cellDate_, cellStamp_, summarize, undoTarget, canUndo, entryFromRow, parseLogRow, expenseToRow, paymentToRow, setupSeedRows };
}
