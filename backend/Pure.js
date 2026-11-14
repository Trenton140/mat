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

function validateExpense(input, peopleNames) {
  if (!isObj_(input)) return fail_("That didn't come through properly.");
  var id = input.id, day = input.day, title = input.title, amount = input.amount;
  if (typeof id !== "string" || !ID_RE_.test(id)) return fail_("That line has a bad id.");
  if (typeof day !== "string" || (day !== "pre" && !DAY_RE_.test(day))) return fail_("Pick a day.");
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
    for (var x = 0; x < vals.length; x++) {
      var v = vals[x];
      if (typeof v !== "number" || !isFinite(v) || !(v > 0)) return fail_("Every amount has to be more than zero.");
      if (currency === "JPY") {
        if (v % 1 !== 0) return fail_("Yen amounts must be whole numbers.");
        sum += v;
      } else {
        sum += cents_(v);
      }
    }
    var total = currency === "JPY" ? amount : cents_(amount);
    if (sum !== total) return fail_("The amounts don't add up to the total.");
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

if (typeof module !== "undefined") {
  module.exports = { TABS, KINDS, sanitizeCell, rowToObj, objToRow, validateExpense, validatePayment, validatePersonPatch, expenseFromRow, paymentFromRow, personFromRow, cellDate_, cellStamp_ };
}
