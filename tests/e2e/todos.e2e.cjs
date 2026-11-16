/* Copyright (c) 2026 moissmart1. All rights reserved. No licence is granted: do not copy, adapt or reuse this code or design, and do not use it to train or prompt an AI system to reproduce it. See LICENSE. */
// Task 20: "Before we go" (出発前) on the Days tab. The fake backend runs the
// real backend actions over a fake planner (tests/fake-backend.cjs): its Book
// Now tab is pulled into the Todos tab, a tick writes Booked back to it (or
// cannot: fake.planner.cellFails), and every write it receives is recorded.
// Every item, note, link and id here is made up.

const assert = require("node:assert/strict");
const { SEED, NOON12, makeBackend, open, advance, until, text, expectText, visible } = require("./helpers.cjs");

const PLANNER_ID = "fakePlannerSheet_0123456789abcdefXYZ";
const BHEAD = ["#", "Item", "Who", "Book by", "Status", "Notes", "Booking link"];
const brow = (o) => BHEAD.map((h) => (o[h] === undefined ? "" : o[h]));
const CHEAD = ["#", "Date / time", "Agent / session", "Tab", "Cell(s)", "Item", "Old value", "New value", "Why", "Proof / source", "Verified?"];
const ITEMS = [
  { "#": 1, Item: "Rail pass seat reservations", "Book by": "2026-11-14", Status: "Not booked", Notes: "Window seats for three, both legs.", "Booking link": "https://rail.example.test/book?leg=1" },
  { "#": 2, Item: "Tea ceremony class", "Book by": "2026-11-18", Status: "Pending" },
  { "#": 3, Item: "Snow park day trip", "Book by": "Dec 5", Status: "Not booked", Notes: "Buses leave early." },
  { "#": 4, Item: "Airport bus tickets", Status: "" },
  { "#": 5, Item: "Pocket wifi pickup", "Book by": "2026-11-10", Status: "Booked" },
];
// 14:00 on Mon Nov 16 in Toronto (04:00 on the 17th in Japan): before the trip.
const BEFORE = Date.parse("2026-11-16T19:00:00Z");
const MIN = 60000;

function seedWith(items = ITEMS) {
  return { ...SEED, plannerId: PLANNER_ID, plannerTabs: { "Book Now": [["Before we go: bookings"], BHEAD, ...items.map(brow)], "Change Log": [CHEAD] } };
}

// A backend whose list was pulled `ago` ms before `nowMs` (null: never pulled).
async function listBackend({ nowMs = BEFORE, items = ITEMS, ago = 5 * MIN, claims = {} } = {}) {
  const backend = makeBackend(seedWith(items), { now: nowMs });
  const call = (action, args, actor = "Mo") => backend.fake({ key: "test-key", actor, action, args });
  if (ago !== null) {
    backend.now = nowMs - ago;
    const r = await call("syncTodos", {});
    assert.equal(r.ok, true, JSON.stringify(r));
    backend.now = nowMs;
  }
  for (const [id, who] of Object.entries(claims)) assert.equal((await call("claimTodo", { id, on: true }, who)).ok, true);
  backend.requests.length = 0;
  backend.call = call;
  return backend;
}

async function ready(page, opts = {}) {
  const { nowMs = BEFORE, backend } = opts;
  const be = backend || (await listBackend(opts));
  await open(page, { backend: be, nowMs, tab: "days" });
  await until(() => page.evaluate(() => document.querySelectorAll("#rail .tk").length > 0), "the tickets draw");
  return be;
}

const rowIds = (page, box = "#bwOpen") => page.evaluate((b) => [...document.querySelectorAll(b + " > [data-id]")].map((r) => r.dataset.id), box);
const row = (id) => '#bwOpen .bw-r[data-id="' + id + '"]';
const sent = (backend, action) => backend.requests.filter((r) => r.action === action);
const stored = (backend, id) => backend.fake.tables.Todos.find((r) => r.id === id);
// The day of an instant in Japan (the test phone's own zone), as "Nov 17".
const phoneDay = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", month: "short", day: "numeric" }).format(new Date(ms));

async function openRow(page, id) {
  await page.click(row(id) + " .bw-b");
  await until(() => page.evaluate((sel) => document.querySelector(sel).classList.contains("is-open"), row(id)), "row " + id + " opens");
}

module.exports = [
  {
    name: "before the trip the list sits under the countdown: open items by book-by date, the due lines, the seals, done folded, the fetch line",
    async run({ page }) {
      const backend = await ready(page, { claims: { 2: "Ajen" } });
      assert.ok(await visible(page, "#todos"));
      assert.equal(await visible(page, "#bwFold"), false, "no folded row before the trip");
      const order = await page.evaluate(() => [...document.getElementById("vDays").children].map((n) => n.id || n.className));
      assert.ok(order.indexOf("todos") === order.indexOf("rail") - 1 && order[order.indexOf("todos") - 1] === "bar", "between the counter and the rail: " + order.join(","));
      await expectText(page, "#dayCount", /in 23 days/);
      await expectText(page, "#bwTitle", "出発前Before we go");
      await expectText(page, "#bwCard .bw-band .num", "4open");
      assert.deepEqual(await rowIds(page), ["1", "2", "3", "4"]);
      await expectText(page, row(1) + " .bw-due", "was due Sat Nov 14 · 2 days late");
      assert.equal(await page.evaluate((s) => document.querySelector(s).classList.contains("is-late"), row(1) + " .bw-due"), true);
      const late = await page.evaluate((s) => getComputedStyle(document.querySelector(s)).color, row(1) + " .bw-due");
      assert.equal(late, "rgb(214, 60, 30)", "late is in the vermilion ink");
      await expectText(page, row(2) + " .bw-due", "by Wed Nov 18 · in 2 days");
      await expectText(page, row(2) + " .bw-due b", "Wed Nov 18");
      await expectText(page, row(3) + " .bw-due", "by Sat Dec 5 · in 19 days");
      assert.equal(await page.$(row(3) + " .bw-due b"), null, "not heavier 19 days out");
      assert.equal(await page.$(row(4) + " .bw-due"), null, "no date, no due line");
      // Ajen is on #2: his seal; nobody on the others: an empty ring.
      assert.equal(await page.evaluate((s) => document.querySelector(s).classList.contains("is-empty"), row(2) + " .bw-seal"), false);
      assert.ok((await text(page, row(2) + " .bw-seal")).length > 0);
      assert.equal(await page.evaluate((s) => document.querySelector(s).classList.contains("is-empty"), row(1) + " .bw-seal"), true);
      await expectText(page, row(2) + " .bw-b", /Ajen is on it/);
      await expectText(page, "#bwDoneB", "済 Done (1)");
      assert.equal(await visible(page, "#bwDone"), false, "done is folded");
      await expectText(page, "#bwAt", /^From the planner · fetched \d\d:\d\d$/);
      // Fetched 5 minutes ago: no fetch of its own.
      assert.equal(sent(backend, "syncTodos").length, 0);
      // Nothing opens by itself; the controls are out of reach while closed.
      assert.equal(await page.evaluate(() => document.querySelectorAll("#bwOpen .bw-r.is-open").length), 0);
      assert.equal(await page.evaluate((s) => document.querySelector(s).inert, row(1) + " .bw-more"), true);
      // The done group lists the planner's own booking, plainly.
      await page.click("#bwDoneB");
      await expectText(page, '#bwDone .bw-d[data-id="5"] .bw-n', "Pocket wifi pickup");
      await expectText(page, '#bwDone .bw-d[data-id="5"] .bw-due', "Booked in the planner");
      assert.equal(await page.$$eval("#bwDone button, #bwDone a", (n) => n.length), 0, "no controls in the done group");
    },
  },
  {
    name: "a row opens in place: the whole item, the note, the controls named with the item; the booking opens in a new tab",
    async run({ page, context }) {
      await ready(page, { claims: { 2: "Ajen" } });
      await openRow(page, "1");
      await expectText(page, row(1) + " .bw-note", "Window seats for three, both legs.");
      const link = await page.$eval(row(1) + " a.bw-link", (a) => ({ href: a.href, target: a.target, rel: a.rel, text: a.textContent, name: a.getAttribute("aria-label") }));
      assert.deepEqual(link, { href: "https://rail.example.test/book?leg=1", target: "_blank", rel: "noopener", text: "Open the booking ↗", name: "Open the booking for Rail pass seat reservations" });
      const names = await page.$$eval(row(1) + " button", (b) => b.map((x) => x.getAttribute("aria-label") || x.textContent.trim()));
      assert.ok(names.every((n) => n.includes("Rail pass seat reservations")), names.join(" | "));
      await expectText(page, row(1) + " .bw-claim", "I’ll do it");
      await expectText(page, row(1) + " .bw-tick", "Tick it off済");
      // No link: no link control.
      await openRow(page, "3");
      assert.equal(await page.evaluate((s) => document.querySelector(s).classList.contains("is-open"), row(1)), false, "opening one closes the other");
      assert.equal(await page.$(row(3) + " a"), null);
      await expectText(page, row(2) + " .bw-claim", "Take it over");
      // The link opens its address in a new tab.
      await openRow(page, "1");
      const [tab] = await Promise.all([context.waitForEvent("page"), page.click(row(1) + " a.bw-link")]);
      assert.equal(tab.url(), "https://rail.example.test/book?leg=1");
      await tab.close();
      // A sync while it is open leaves it open.
      await page.evaluate(() => window.__matTest.store.checkRev());
      assert.equal(await page.evaluate((s) => document.querySelector(s).classList.contains("is-open"), row(1)), true);
    },
  },
  {
    name: "I’ll do it, hand it back, take it over: shown at once, saved, said on the undo bar",
    async run({ page }) {
      const backend = await ready(page, { claims: { 2: "Ajen" } });
      await openRow(page, "3");
      await page.click(row(3) + " .bw-claim");
      await expectText(page, "#ubarT", "You’re on Snow park day trip.");
      await until(() => stored(backend, "3").claimed_by === "Mo", "saved as Mo's");
      assert.equal(await page.evaluate((s) => document.querySelector(s).classList.contains("is-empty"), row(3) + " .bw-seal"), false);
      await expectText(page, row(3) + " .bw-claim", "Hand it back");
      assert.equal(await page.evaluate((s) => document.querySelector(s).classList.contains("is-open"), row(3)), true, "still open");
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.act), "claim", "focus stays on the control");

      await page.click(row(3) + " .bw-claim");
      await expectText(page, "#ubarT", "Handed back Snow park day trip.");
      await until(() => stored(backend, "3").claimed_by === "", "handed back");
      assert.equal(await page.evaluate((s) => document.querySelector(s).classList.contains("is-empty"), row(3) + " .bw-seal"), true);

      await openRow(page, "2");
      await page.click(row(2) + " .bw-claim");
      await expectText(page, "#ubarT", "Took over Tea ceremony class.");
      await until(() => stored(backend, "2").claimed_by === "Mo", "taken over");
      await expectText(page, row(2) + " .bw-claim", "Hand it back");
      assert.deepEqual(sent(backend, "claimTodo").map((r) => r.args), [{ id: "3", on: true }, { id: "3", on: false }, { id: "2", on: true }]);

      // History: each kind of entry, the newest of each item with its Undo.
      await page.click("#youBtn");
      await page.click("#setHist");
      const tape = () => page.evaluate(() => [...document.querySelectorAll("#hist .tp-row")].map((r) => [r.querySelector(".tp-s").textContent, !!r.querySelector(".tp-undo")]));
      await until(async () => (await tape()).some(([s]) => s.startsWith("Mo took over")), "History lists the claims");
      const got = await tape();
      for (const want of [["Mo took over: Tea ceremony class, from Ajen", true], ["Mo handed back: Snow park day trip", true], ["Mo is on: Snow park day trip", false]]) {
        assert.ok(got.some((g) => g[0] === want[0] && g[1] === want[1]), JSON.stringify(want) + " in " + JSON.stringify(got));
      }
      await page.evaluate(() => {
        const r = [...document.querySelectorAll("#hist .tp-row")].find((x) => x.querySelector(".tp-s").textContent.startsWith("Mo took over"));
        r.querySelector(".tp-undo").click();
      });
      await until(() => stored(backend, "2").claimed_by === "Ajen", "the undo gives it back to Ajen");
    },
  },
  {
    name: "Tick it off: the stamp lands with its thud, the planner is written, the row moves to done; History has it and its Undo brings it back",
    async run({ page }) {
      const backend = await ready(page);
      await page.evaluate(() => {
        window.__thuds = 0;
        const AC = function () {
          return { state: "running", currentTime: 0, destination: {}, createOscillator: () => ({ type: "", frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() { window.__thuds++; }, stop() {} }), createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }) };
        };
        window.AudioContext = AC;
      });
      await openRow(page, "3");
      await page.click(row(3) + " .bw-tick");
      // Stamped in place, with the settle stamp's hit.
      await until(() => page.$(row(3) + ".is-landed .bw-spot .stamp.hit"), "the stamp lands on the row");
      assert.deepEqual(await rowIds(page), ["1", "2", "3", "4"], "still where it was");
      assert.equal(await page.evaluate(() => window.__thuds), 1, "the thud");
      await expectText(page, row(3) + " .bw-due", "済 Mo · " + phoneDay(BEFORE));
      await expectText(page, "#ubarT", "Ticked off Snow park day trip.");
      await until(() => stored(backend, "3").ticked_by === "Mo" && stored(backend, "3").planner_written === "yes", "ticked and written to the planner");
      assert.deepEqual(backend.fake.planner.writes.map((w) => [w.kind, w.tab, w.cell || "", w.value || ""]), [["cell", "Book Now", "E5", "Booked"], ["append", "Change Log", "", ""]]);
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("bw-tick")), true, "focus on the stamp");
      await expectText(page, "#bwCard .bw-band .num", "3open");

      await advance(page, backend, 1700);
      await until(async () => !(await rowIds(page)).includes("3"), "it moves to the done group");
      assert.ok(await visible(page, "#bwDone"), "the done group opens to show it");
      await expectText(page, "#bwDoneB", "済 Done (2)");
      assert.deepEqual(await rowIds(page, "#bwDone"), ["3", "5"], "newest first");
      await expectText(page, '#bwDone .bw-d[data-id="3"] .bw-n', "Snow park day trip");
      await expectText(page, '#bwDone .bw-d[data-id="3"] .bw-due', "済 Mo · " + phoneDay(BEFORE));
      assert.equal(await page.evaluate(() => document.querySelector('#bwDone .bw-d[data-id="3"] .bw-seal').classList.contains("is-empty")), false, "the ticker's seal");
      assert.equal(await page.$('#bwDone .bw-d[data-id="3"] .bw-pl'), null, "written: no pending line");
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "bwDoneB");

      await page.click("#youBtn");
      await page.click("#setHist");
      await until(() => page.evaluate(() => [...document.querySelectorAll("#hist .tp-row .tp-s")].some((s) => s.textContent === "Mo ticked off: Snow park day trip")), "History lists the tick");
      await page.evaluate(() => {
        const r = [...document.querySelectorAll("#hist .tp-row")].find((x) => x.querySelector(".tp-s").textContent === "Mo ticked off: Snow park day trip");
        r.querySelector(".tp-undo").click();
      });
      await until(() => stored(backend, "3").ticked_by === "", "undone on the backend");
      await page.click("#histDone");
      await until(async () => (await rowIds(page)).includes("3"), "back among the open items");
      await expectText(page, "#bwDoneB", "済 Done (1)");
    },
  },
  {
    name: "a tick the planner can't take yet: done in the app, and a line says the planner will be updated at the next fetch",
    async run({ page }) {
      const backend = await ready(page);
      backend.fake.planner.cellFails = true;
      await openRow(page, "1");
      await page.click(row(1) + " .bw-tick");
      await until(() => stored(backend, "1").ticked_by === "Mo", "ticked");
      await until(() => page.evaluate((s) => { const p = document.querySelector(s); return p && !p.hidden; }, row(1) + " .bw-pl"), "the pending line on the stamped row");
      await advance(page, backend, 1700);
      await until(() => page.$('#bwDone .bw-d[data-id="1"]'), "moved to done");
      await expectText(page, '#bwDone .bw-d[data-id="1"] .bw-pl', "The planner will be updated at the next fetch.");
      assert.equal(stored(backend, "1").planner_written, "");
      // The next fetch writes it, and the line goes.
      backend.fake.planner.cellFails = false;
      await page.click("#bwFetch");
      await until(() => stored(backend, "1").planner_written === "yes", "the fetch writes it");
      await until(async () => (await page.$('#bwDone .bw-d[data-id="1"] .bw-pl')) === null, "the line goes");
    },
  },
  {
    name: "a tick refused (another phone ticked it first) rolls back with the usual notice; offline it is not saved",
    async run({ page }) {
      const backend = await ready(page);
      assert.equal((await backend.call("tickTodo", { id: "4" }, "Ajen")).ok, true);
      await openRow(page, "4");
      await page.click(row(4) + " .bw-tick");
      await expectText(page, "#ubarT", "That one is already done.");
      await until(() => page.evaluate((s) => { const r = document.querySelector(s); return !r || !r.classList.contains("is-landed"); }, row(4)), "no longer stamped");

      await page.context().setOffline(true);
      await openRow(page, "1");
      await page.click(row(1) + " .bw-tick");
      await expectText(page, "#ubarT", "No signal. That wasn’t saved.");
      await until(async () => (await rowIds(page)).includes("1") && !(await page.$(row(1) + ".is-landed")), "back to open");
      assert.equal(stored(backend, "1").ticked_by, "");
      await page.context().setOffline(false);
    },
  },
  {
    name: "during the trip: one folded row while anything is open, which opens the list; nothing once all is done",
    async run({ page }) {
      const items = [ITEMS[1], ITEMS[4]];
      const backend = await ready(page, { nowMs: NOON12, items });
      assert.ok(await visible(page, "#bwFold"));
      await expectText(page, "#bwFold", "出発前1 thing still open");
      assert.equal(await page.getAttribute("#bwFold", "aria-expanded"), "false");
      assert.equal(await visible(page, "#bwCard"), false);
      await page.click("#bwFold");
      assert.ok(await visible(page, "#bwCard"));
      assert.equal(await page.getAttribute("#bwFold", "aria-expanded"), "true");
      await expectText(page, row(2) + " .bw-due", /was due Wed Nov 18 · \d+ days late/);
      await openRow(page, "2");
      await page.click(row(2) + " .bw-tick");
      await until(() => stored(backend, "2").ticked_by === "Mo", "ticked");
      await advance(page, backend, 1700);
      await until(async () => !(await visible(page, "#todos")), "nothing shows once all is done");
    },
  },
  {
    name: "before the trip with everything done: all done, and the done group; no planner or no items: nothing",
    async run({ page, newPhone }) {
      await ready(page, { items: [ITEMS[4]] });
      await expectText(page, "#bwOpen", "済 All done. Nothing left to book.");
      await expectText(page, "#bwDoneB", "済 Done (1)");
      await expectText(page, "#bwCard .bw-band .num", "0open");

      const other = await newPhone();
      const be = makeBackend(SEED, { now: BEFORE });
      await open(other, { backend: be, nowMs: BEFORE, tab: "days" });
      await until(() => other.evaluate(() => document.querySelectorAll("#rail .tk").length > 0), "the tickets draw");
      assert.equal(await visible(other, "#todos"), false);
      assert.equal(be.requests.filter((r) => r.action === "syncTodos").length, 0, "no planner: no fetch");
    },
  },
  {
    name: "fetched quietly once when an hour old, not when fresh; showing Days again does not fetch a fresh list again",
    async run({ page, newPhone }) {
      const stale = await listBackend({ ago: 61 * MIN });
      await ready(page, { backend: stale });
      await until(() => sent(stale, "syncTodos").length === 1, "one fetch on start");
      assert.deepEqual(sent(stale, "syncTodos")[0].args, { force: false });
      await until(() => page.evaluate(() => /fetched/.test(document.getElementById("bwAt").textContent)), "fetched line");
      await page.click('#nav button[data-tab="money"]');
      await page.click('#nav button[data-tab="days"]');
      await page.evaluate(() => window.__matTest.store.idle());
      assert.equal(sent(stale, "syncTodos").length, 1, "fresh now: not again");
      assert.equal(await text(page, "#bwFetch"), "Fetch", "quietly: Fetch never said Fetching");

      const other = await newPhone();
      const fresh = await listBackend({ ago: 59 * MIN });
      await ready(other, { backend: fresh });
      await other.evaluate(() => window.__matTest.store.idle());
      await other.click('#nav button[data-tab="money"]');
      await other.click('#nav button[data-tab="days"]');
      await other.evaluate(() => window.__matTest.store.idle());
      assert.equal(sent(fresh, "syncTodos").length, 0);
    },
  },
  {
    name: "a first fetch of a long list asks again while more remain, then shows it all",
    async run({ page }) {
      const items = [];
      for (let i = 1; i <= 17; i++) items.push({ "#": i, Item: "Made-up booking " + i, "Book by": "2026-12-0" + ((i % 9) + 1), Status: "Not booked" });
      const backend = await ready(page, { items, ago: null });
      await until(() => page.evaluate(() => document.querySelectorAll("#bwOpen .bw-r").length === 17), "all 17 show");
      assert.deepEqual(sent(backend, "syncTodos").map((r) => r.args), [{ force: false }, { force: true }]);
    },
  },
  {
    name: "Fetch says Fetching… then how it went, in place; a quiet fetch that fails twice in a row says so",
    async run({ page }) {
      const backend = await listBackend({ ago: 2 * MIN });
      let release;
      const gate = new Promise((r) => (release = r));
      const handle = backend.handle;
      backend.handle = async (body) => {
        if (body.action === "syncTodos") await gate;
        return handle(body);
      };
      await ready(page, { backend });
      await advance(page, backend, 3 * MIN);
      await page.click("#bwFetch");
      await expectText(page, "#bwFetch", "Fetching…");
      assert.equal(await page.evaluate(() => document.getElementById("bwFetch").disabled), true);
      release();
      await expectText(page, "#bwFetch", "Up to date ✓");
      assert.deepEqual(sent(backend, "syncTodos").map((r) => r.args), [{ force: true }]);
      const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(BEFORE + 3 * MIN));
      await expectText(page, "#bwAt", "From the planner · fetched " + clock);
      await advance(page, backend, 4000);
      await expectText(page, "#bwFetch", "Fetch");

      backend.fake.planner.fails = true;
      await page.click("#bwFetch");
      await expectText(page, "#bwFetch", "Not fetched");
      await expectText(page, "#ubarT", /planner/);

      // Quiet: an hour later, two failed fetches in a row before anything is said.
      await advance(page, backend, 61 * MIN);
      await page.evaluate(() => window.__matTest.store.clearNotice());
      await page.click('#nav button[data-tab="money"]');
      await page.click('#nav button[data-tab="days"]');
      await until(() => sent(backend, "syncTodos").length === 3, "a quiet fetch");
      await page.evaluate(() => window.__matTest.store.idle());
      assert.equal(await visible(page, "#ubar"), false, "first failure: nothing said");
      await page.click('#nav button[data-tab="money"]');
      await page.click('#nav button[data-tab="days"]');
      await until(() => sent(backend, "syncTodos").length === 4, "another quiet fetch");
      await expectText(page, "#ubarT", /planner/);
    },
  },
  {
    name: "sideways (844 × 390): the list under the counter, a row opens and its controls fit",
    viewport: { width: 844, height: 390 },
    async run({ page }) {
      await ready(page, { claims: { 2: "Ajen" } });
      assert.ok(await visible(page, "#todos"));
      await openRow(page, "1");
      const fit = await page.evaluate(() => {
        const view = document.getElementById("vDays").getBoundingClientRect();
        const card = document.getElementById("bwCard").getBoundingClientRect();
        const tick = document.querySelector('#bwOpen .bw-r[data-id="1"] .bw-tick').getBoundingClientRect();
        return { inside: card.left >= view.left && card.right <= view.right, tickIn: tick.right <= card.right, scroll: document.getElementById("vDays").scrollWidth <= document.getElementById("vDays").clientWidth };
      });
      assert.deepEqual(fit, { inside: true, tickIn: true, scroll: true });
    },
  },
  {
    name: "portrait (390 × 844): the open row's controls fit the card and the Tick it off target is large",
    async run({ page }) {
      await ready(page);
      await openRow(page, "1");
      const box = await page.evaluate(() => {
        const card = document.getElementById("bwCard").getBoundingClientRect();
        const tick = document.querySelector('#bwOpen .bw-r[data-id="1"] .bw-tick').getBoundingClientRect();
        return { right: tick.right <= card.right, h: tick.height };
      });
      assert.equal(box.right, true);
      assert.ok(box.h >= 44, "tap target " + box.h);
    },
  },
];
