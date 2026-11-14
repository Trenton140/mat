// The real backend in memory. createFakeBackend(seed, { clock }) evaluates the
// actual backend/Pure.js and backend/Actions.js source over in-memory versions
// of the storage primitives Actions.js uses, so tests exercise the real action
// code. The in-memory sheet helpers mirror backend/Sheets.js: same sanitising
// on write, only patched columns written, same return values, and cells read
// back the way Sheets hands them back (a stored "'=x" reads as "=x").
//
// seed = { expenses?, payments?, people?, days? } (see constraints R6).
// The returned function takes a request body and resolves to the envelope.
// Options: clock (() => ISO string); test-only: lockFails (() => boolean),
// keepsApostrophe (Sheets hands back a text cell's leading ' verbatim).
// Test handles: fake.tables (live rows per tab), fake.requests (every body
// received), fake.primitives (the in-memory helpers), fake.props (Script
// Properties).

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BACKEND = path.join(__dirname, "..", "backend");
const script = (name) => new vm.Script(fs.readFileSync(path.join(BACKEND, name), "utf8"), { filename: path.join(BACKEND, name) });
const PURE = script("Pure.js");
const ACTIONS = script("Actions.js");

const TRIP_KEY = "test-key";
const RATE = 111;
const SHEET_URL = "https://example.test/sheet";

const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// What Sheets hands back for a stored cell under setup()'s formatting (see
// isTextColumn in Pure.js). Which way Sheets treats a leading apostrophe in a
// plain-text cell is not yet verified, so both are modelled: by default it is
// the "treat as text" marker and is dropped; with keepsApostrophe a text cell
// hands it back verbatim. (rowToObj then undoes the escape either way.)
// A plain-text column gives back a string even when a number or boolean was
// written; any other column turns a string that looks like a number or
// TRUE/FALSE into a number or boolean.
function readCell(text, v, keepsApostrophe) {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" && v.charAt(0) === "'") return text && keepsApostrophe ? v : v.slice(1);
  if (text) {
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    return String(v);
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (/^(true|false)$/i.test(t)) return t.toUpperCase() === "TRUE";
  }
  return v;
}

function createFakeBackend(seed, { clock, lockFails, keepsApostrophe = false } = {}) {
  const now = clock || (() => new Date().toISOString());
  const world = vm.createContext({});
  PURE.runInContext(world);
  const P = world;

  const tables = {};
  for (const tab of Object.keys(P.TABS)) tables[tab] = [];
  // Seeded Log rows are not writes, so REV starts at 0 even when seeded (an
  // unset REV would otherwise fall back to the Log's highest id).
  const props = { TRIP_KEY, REV: "0" };

  const headers = (tab) => {
    const h = P.TABS[tab];
    if (!h) throw new Error("Missing tab: " + tab + ". Run setup().");
    return h;
  };
  const cellOut = (tab, h, v) => readCell(P.isTextColumn(tab, h), v, keepsApostrophe);
  // Same path as the real readTable_: cells as Sheets hands them back, then rowToObj.
  const readRow = (tab, stored) => {
    const h = headers(tab);
    return P.rowToObj(h, h.map((col) => cellOut(tab, col, stored[col])));
  };

  const primitives = {
    readTable_(tab) {
      headers(tab);
      return tables[tab].map((r) => readRow(tab, r));
    },
    appendObj_(tab, obj) {
      const h = headers(tab);
      const cells = P.objToRow(h, obj);
      const stored = {};
      h.forEach((col, i) => { stored[col] = cells[i]; });
      tables[tab].push(stored);
    },
    updateWhere_(tab, column, value, patch) {
      if (value === "" || value === null || value === undefined) return null;
      const h = headers(tab);
      if (h.indexOf(column) === -1) return null;
      for (const stored of tables[tab]) {
        if (String(P.unsanitizeCell(cellOut(tab, column, stored[column]))) !== String(value)) continue;
        for (const key of Object.keys(patch)) {
          if (h.indexOf(key) === -1 || patch[key] === undefined) continue;
          stored[key] = patch[key] === null ? "" : P.sanitizeCell(patch[key]);
        }
        return readRow(tab, stored);
      }
      return null;
    },
    updateById_(tab, id, patch) {
      return primitives.updateWhere_(tab, "id", id, patch);
    },
    getProp_(key) {
      return Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null;
    },
    setProp_(key, value) {
      props[key] = String(value);
    },
    // Test-only: lockFails() returning true plays a lock that never frees up
    // (same envelope as Env.js withLock_).
    withLock_(fn) {
      if (lockFails && lockFails()) return { ok: false, error: "busy", message: "Someone else is saving right now. Try again in a moment." };
      return fn();
    },
    getRate_: () => RATE,
    nowIso_: () => now(),
    sheetUrl_: () => SHEET_URL,
  };
  Object.assign(world, primitives);
  ACTIONS.runInContext(world);

  seedWorld(P, primitives, tables, props, seed || {}, now);

  const requests = [];
  const fake = (request) => {
    const body = copy(request);
    requests.push(copy(body));
    let env;
    try {
      env = world.handle_(body);
    } catch (e) {
      // Same as doPost's last-resort catch.
      env = { ok: false, error: "server", message: "Something went wrong on our side. Try again. (" + e.message + ")" };
    }
    return Promise.resolve(copy(env));
  };
  fake.tables = tables;
  fake.requests = requests;
  fake.primitives = primitives;
  fake.props = props;
  return fake;
}

// Writes what setup() writes, then the seed's patches, items and Log rows.
// Not routed through handle_ (it must be able to set addedAt and the like),
// but every row goes through the same converters and sheet helpers.
function seedWorld(P, prim, tables, props, seed, now) {
  const rows = P.setupSeedRows();
  for (const tab of ["Trip", "People", "Days"]) for (const o of rows[tab]) prim.appendObj_(tab, o);
  for (const [name, patch] of Object.entries(seed.people || {})) prim.updateWhere_("People", "name", name, patch);
  for (const [date, patch] of Object.entries(seed.days || {})) prim.updateWhere_("Days", "date", date, patch);

  const lastRow = (tab) => prim.readTable_(tab)[tables[tab].length - 1];
  const events = [];

  for (const given of seed.expenses || []) {
    const e = { rate: RATE, splitMode: "equal", splitVals: [], note: "", kind: "", deleted: false, ...copy(given) };
    if (e.addedBy === undefined) e.addedBy = e.paidBy;
    if (e.addedAt === undefined) e.addedAt = now();
    const row = P.expenseToRow(e);
    row.added_at = e.addedAt;
    if (e.deleted) row.deleted_at = e.addedAt;
    prim.appendObj_("Expenses", row);
    const saved = P.expenseFromRow(lastRow("Expenses"));
    const live = { ...saved, deleted: false };
    const base = { at: e.addedAt, who: e.addedBy, kind: "expense", ref: saved.id };
    events.push({ ...base, action: "add", summary: P.summarize("add", "expense", null, live), before: null, after: live });
    if (saved.deleted) events.push({ ...base, action: "delete", summary: P.summarize("delete", "expense", live, saved), before: live, after: saved });
  }

  for (const given of seed.payments || []) {
    const p = { seed: 1, rot: 0, removed: false, ...copy(given) };
    if (p.stampedBy === undefined) p.stampedBy = p.from;
    if (p.stampedAt === undefined) p.stampedAt = now();
    const row = P.paymentToRow(p);
    row.stamped_at = p.stampedAt;
    if (p.removed) row.removed_at = p.stampedAt;
    prim.appendObj_("Settlements", row);
    const saved = P.paymentFromRow(lastRow("Settlements"));
    const live = { ...saved, removed: false };
    const base = { at: p.stampedAt, who: p.stampedBy, kind: "payment", ref: saved.id };
    events.push({ ...base, action: "stamp", summary: P.summarize("stamp", "payment", null, live), before: null, after: live });
    if (saved.removed) events.push({ ...base, action: "unstamp", summary: P.summarize("unstamp", "payment", live, saved), before: live, after: saved });
  }

  // Log ids follow time order (a stable sort keeps each add before its delete).
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  events.forEach((ev, i) => {
    prim.appendObj_("Log", {
      id: i + 1, at: ev.at, who: ev.who, via: "app", action: ev.action, kind: ev.kind, ref: ev.ref, summary: ev.summary,
      before: ev.before ? JSON.stringify(ev.before) : "", after: JSON.stringify(ev.after), undoes: "", undone_by: "",
    });
  });
  if (events.length) props.LOGSEQ = String(events.length);
}

module.exports = { createFakeBackend };
