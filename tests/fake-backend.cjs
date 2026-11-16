// The real backend in memory. createFakeBackend(seed, { clock }) evaluates the
// actual backend/Pure.js, Actions.js, Money.js and Mcp.js source over
// in-memory versions of the storage primitives they use, so tests exercise
// the real action and connector code. The in-memory sheet helpers mirror backend/Sheets.js: same sanitising
// on write, only patched columns written, same return values, and cells read
// back the way Sheets hands them back (a stored "'=x" reads as "=x").
//
// seed = { expenses?, payments?, people?, days?, stops?, stays? } (see
// constraints R6). stops and stays are arrays in API shape (deleted: true marks
// one deleted), each logged as added by Mo; days is a per-date patch in the
// Sheet's own column names.
// The returned function takes a request body and resolves to the envelope.
// Options: clock (() => ISO string); test-only: lockFails (() => boolean;
// each true is a busy lock that made the caller wait 8 s: fake.lockWaitedMs()),
// keepsApostrophe (Sheets hands back a text cell's leading ' verbatim).
// Test handles: fake.tables (live rows per tab), fake.requests (every body
// received, including those the connector hands to handle_), fake.mcp(msg,
// params) (the Claude connector: mcp_, as doPost calls it for a JSON-RPC body),
// fake.beforeConnectorWrite (test-only: set it to run code just before a
// request the connector makes reaches handle_), fake.primitives (the in-memory helpers), fake.props (Script
// Properties), fake.propReads (every Script Properties key read, in order),
// fake.setRate(rate, source) (today's rate and where it came from: "live",
// "last" or "fallback"; default 111, "live").

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const BACKEND = path.join(__dirname, "..", "backend");
const script = (name) => new vm.Script(fs.readFileSync(path.join(BACKEND, name), "utf8"), { filename: path.join(BACKEND, name) });
const PURE = script("Pure.js");
const ACTIONS = script("Actions.js");
const MONEY = script("Money.js");
const MCP = script("Mcp.js");

const TRIP_KEY = "test-key";
const CLAUDE_TOKEN = "claude-token";
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

// "YYYY-MM-DD" at this ISO instant in the zone tz.
function dayIn(iso, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
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
  const props = { TRIP_KEY, CLAUDE_TOKEN, REV: "0" };
  const propReads = [];
  const rate = { rate: RATE, source: "live" };
  const cache = {}; // the script cache, for the trip key
  let lockWaited = 0; // ms the in-memory lock has made callers wait

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
        if (P.cellDate_(P.unsanitizeCell(cellOut(tab, column, stored[column]))) !== String(value)) continue;
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
    // The in-memory tabs always have every column TABS names.
    ensureColumns_: () => [],
    getProp_(key) {
      propReads.push(key);
      return Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null;
    },
    // Same as Env.js: the cached key, Script Properties only on a miss.
    tripKey_() {
      if (cache.TRIP_KEY) return cache.TRIP_KEY;
      const key = Object.prototype.hasOwnProperty.call(props, "TRIP_KEY") ? props.TRIP_KEY : null;
      if (key) cache.TRIP_KEY = key;
      return key;
    },
    setProp_(key, value) {
      props[key] = String(value);
    },
    // Test-only: lockFails() returning true plays a lock that never frees up
    // (same envelope as Env.js withLock_).
    // A lock that is not freed waits its 8 seconds first (lockWaited), as
    // tryLock(8000) does, so the connector's retry timing can be tested.
    withLock_(fn) {
      if (lockFails && lockFails()) {
        lockWaited += 8000;
        return { ok: false, error: "busy", message: "Someone else is saving right now. Try again in a moment." };
      }
      return fn();
    },
    clockMs_: () => Date.now() + lockWaited,
    getRate_: () => rate.rate,
    getRateInfo_: () => ({ rate: rate.rate, source: rate.source }),
    nowIso_: () => now(),
    sheetUrl_: () => SHEET_URL,
    // Same as Env.js: 20 letters and digits, starting with a letter.
    newId_: () => "m" + crypto.randomBytes(16).toString("hex").slice(0, 19),
    // Today in the Trip tab's zone, by this backend's clock.
    today_: () => dayIn(now(), world.tripInfo_().tz || "Asia/Tokyo"),
    claudeToken_: () => (Object.prototype.hasOwnProperty.call(props, "CLAUDE_TOKEN") && props.CLAUDE_TOKEN) || null,
    ensureClaudeToken_() {
      if (!primitives.claudeToken_()) props.CLAUDE_TOKEN = crypto.randomBytes(16).toString("hex");
    },
  };
  Object.assign(world, primitives);
  ACTIONS.runInContext(world);
  MONEY.runInContext(world);
  MCP.runInContext(world);
  // A request the connector hands to handle_ is recorded like one from a phone.
  const handle = world.handle_;

  seedWorld(P, primitives, tables, props, seed || {}, now);

  const requests = [];
  const fake = (request) => {
    const body = copy(request);
    requests.push(copy(body));
    let env;
    try {
      env = handle(body);
    } catch (e) {
      // Same as doPost's last-resort catch.
      env = { ok: false, error: "server", message: "Something went wrong on our side. Try again. (" + e.message + ")" };
    }
    return Promise.resolve(copy(env));
  };
  world.handle_ = (body) => {
    requests.push(copy(body));
    // Test-only: fake.beforeConnectorWrite(body) runs between whatever the
    // connector did first and its request reaching handle_ (another phone's
    // write landing in that gap).
    if (typeof fake.beforeConnectorWrite === "function") fake.beforeConnectorWrite(copy(body));
    return handle(body);
  };
  fake.mcp = (msg, params) => copy(world.mcp_(copy(msg), copy(params)));
  fake.tables = tables;
  fake.requests = requests;
  fake.primitives = primitives;
  fake.lockWaitedMs = () => lockWaited;
  fake.props = props;
  fake.propReads = propReads;
  fake.setRate = (r, source) => {
    rate.rate = r;
    rate.source = source;
  };
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

  for (const kind of ["stop", "stay"]) {
    const tab = kind === "stop" ? "Stops" : "Stays";
    const toRow = kind === "stop" ? P.stopToRow : P.stayToRow;
    const fromRow = kind === "stop" ? P.stopFromRow : P.stayFromRow;
    for (const given of seed[kind + "s"] || []) {
      const at = now();
      const row = toRow(given);
      row.deleted_at = given.deleted ? at : "";
      prim.appendObj_(tab, row);
      const saved = fromRow(lastRow(tab));
      const live = { ...saved, deleted: false };
      const base = { at, who: "Mo", kind, ref: saved.id };
      events.push({ ...base, action: "add", summary: P.summarize("add", kind, null, live), before: null, after: live });
      if (saved.deleted) events.push({ ...base, action: "delete", summary: P.summarize("delete", kind, live, saved), before: live, after: saved });
    }
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
