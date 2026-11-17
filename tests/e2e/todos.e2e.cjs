/* Copyright (c) 2026 moissmart1. All rights reserved. No licence is granted: do not copy, adapt or reuse this code or design, and do not use it to train or prompt an AI system to reproduce it. See LICENSE. */
// Tasks 20 and 22: "Before we go" (出発前) on its own Before tab. The fake backend runs the
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

// Opens the app and goes to the Before tab (opts.go = false: stay on Days).
async function ready(page, opts = {}) {
  const { nowMs = BEFORE, backend, go = true } = opts;
  const be = backend || (await listBackend(opts));
  await open(page, { backend: be, nowMs, tab: "days" });
  await until(() => page.evaluate(() => document.querySelectorAll("#rail .tk").length > 0), "the tickets draw");
  if (go) await goBefore(page);
  return be;
}

// Taps the Before tab (once it is in the bar) and waits for the list to show.
async function goBefore(page) {
  await until(() => visible(page, "#beforeBtn"), "the Before tab is in the bar");
  await page.click('#nav button[data-tab="before"]');
  await until(() => visible(page, "#todos"), "the list shows");
}
const tabIsIn = (page) => visible(page, "#beforeBtn");
const onScreen = (page) => page.evaluate(() => document.querySelector(".view.is-active").id);

const rowIds = (page, box = "#bwOpen") => page.evaluate((b) => [...document.querySelectorAll(b + " > [data-id]")].map((r) => r.dataset.id), box);
const row = (id) => '#bwOpen .bw-r[data-id="' + id + '"]';
const sent = (backend, action) => backend.requests.filter((r) => r.action === action);
const stored = (backend, id) => backend.fake.tables.Todos.find((r) => r.id === id);
// The day of an instant in Japan (the test phone's own zone), as "Nov 17".
const phoneDay = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", month: "short", day: "numeric" }).format(new Date(ms));

// The thud's audio, counted: window.__thuds goes up each time it sounds.
function stubSound(page) {
  return page.evaluate(() => {
    window.__thuds = 0;
    window.AudioContext = function () {
      return { state: "running", currentTime: 0, destination: {}, createOscillator: () => ({ type: "", frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() { window.__thuds++; }, stop() {} }), createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }) };
    };
  });
}

// Book Now's row for item n in seedWith's tab (a title row, then the header).
const bookRow = (backend, n) => backend.fake.planner.tabs["Book Now"].find((r) => r[0] === n);

async function openRow(page, id) {
  await page.click(row(id) + " .bw-b");
  await until(() => page.evaluate((sel) => document.querySelector(sel).classList.contains("is-open"), row(id)), "row " + id + " opens");
}

module.exports = [
  {
    name: "before the trip the list is on the Before tab: open items by book-by date, the due lines, the seals, done folded, the fetch line; Days shows none of it",
    async run({ page }) {
      const backend = await ready(page, { claims: { 2: "Ajen" } });
      assert.ok(await visible(page, "#todos"));
      assert.equal(await onScreen(page), "vBefore");
      assert.equal(await page.evaluate(() => document.getElementById("todos").closest("#vBefore") !== null), true, "the list is in the Before view");
      assert.equal(await page.$("#bwFold"), null, "no folded row any more");
      // Days has no list in it.
      assert.equal(await page.$("#vDays #todos, #vDays .bw"), null, "no list inside Days");
      await expectText(page, "#vDays #dayCount", /in 23 days/);
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
    name: "the Before tab: named with the count, the count matches the open rows and follows a tick, and focus and the screen are Days-like",
    async run({ page }) {
      const backend = await ready(page, { claims: { 2: "Ajen" } });
      const bar = () =>
        page.evaluate(() => {
          const b = document.getElementById("beforeBtn");
          const names = [...document.querySelectorAll("#nav [data-tab]")].filter((n) => !n.hidden).map((n) => n.dataset.tab);
          return {
            pill: document.getElementById("beforeN").hidden ? null : document.getElementById("beforeN").textContent,
            name: b.getAttribute("aria-label"),
            current: b.getAttribute("aria-current"),
            active: b.classList.contains("is-active"),
            order: names.join(","),
            rows: document.querySelectorAll("#bwOpen .bw-r:not(.is-landed)").length,
            band: document.querySelector("#bwCard .bw-band .num").textContent,
            small: b.querySelector("small").textContent,
          };
        });
      let b = await bar();
      assert.deepEqual({ ...b }, { pill: "4", name: "Before we go, 4 open", current: "page", active: true, order: "days,before,money", rows: 4, band: "4open", small: "出発前" });
      assert.equal(await page.evaluate(() => document.getElementById("vDays").inert), true, "Days is inert while Before shows");
      await openRow(page, "3");
      await page.click(row(3) + " .bw-tick");
      await until(() => stored(backend, "3").ticked_by === "Mo", "ticked");
      b = await bar();
      assert.equal(b.pill, "3");
      assert.equal(b.name, "Before we go, 3 open");
      assert.equal(b.rows, 3, "the pill and the open rows agree");
      assert.equal(b.band, "3open");
      // Back on Days the tab is still there, and Days has no list.
      await page.click('#nav button[data-tab="days"]');
      assert.equal(await onScreen(page), "vDays");
      assert.ok(await tabIsIn(page));
      assert.equal(await page.$("#vDays #todos, #vDays .bw"), null);
    },
  },
  {
    name: "before the trip the tab is there with 0 open; no planner or no items: no tab; during the trip only while something is open, and ticking the last one on the tab lands on Days",
    async run({ page, newPhone }) {
      // Before the trip, everything done: still there, count 0 and no pill.
      await ready(page, { items: [ITEMS[4]] });
      assert.equal(await page.evaluate(() => document.getElementById("beforeBtn").getAttribute("aria-label")), "Before we go");
      assert.equal(await visible(page, "#beforeN"), false, "no pill at 0");
      // Never loaded (no planner): no tab.
      const other = await newPhone();
      const none = makeBackend(SEED, { now: BEFORE });
      await open(other, { backend: none, nowMs: BEFORE, tab: "days" });
      await until(() => other.evaluate(() => document.querySelectorAll("#rail .tk").length > 0), "the tickets draw");
      assert.equal(await visible(other, "#beforeBtn"), false, "no list, no tab");
      assert.equal(await other.evaluate(() => document.getElementById("beforeBtn").hidden), true);
      // During the trip with nothing open: no tab.
      const third = await newPhone();
      await ready(third, { nowMs: NOON12, items: [ITEMS[4]], go: false });
      await third.evaluate(() => window.__matTest.store.idle());
      assert.equal(await tabIsIn(third), false, "trip on, 0 open: no tab");
      assert.equal(await third.$("#vDays #todos, #vDays .bw"), null, "and no list in Days");
      // During the trip with one open: the tab is there; Days still shows no list.
      const fourth = await newPhone();
      const backend = await ready(fourth, { nowMs: NOON12, items: [ITEMS[1], ITEMS[4]], go: false });
      await until(() => tabIsIn(fourth), "1 open: the tab is in the bar");
      assert.equal(await fourth.$("#vDays #todos, #vDays .bw"), null, "no list, no folded card, inside Days");
      assert.equal(await fourth.$("#bwFold"), null);
      assert.equal(await fourth.evaluate(() => document.getElementById("beforeN").textContent), "1");
      await goBefore(fourth);
      await expectText(fourth, row(2) + " .bw-due", /was due Wed Nov 18 · \d+ days late/);
      await openRow(fourth, "2");
      await fourth.click(row(2) + " .bw-tick");
      await until(() => stored(backend, "2").ticked_by === "Mo", "ticked");
      assert.equal(await onScreen(fourth), "vBefore", "the stamp is seen first");
      await advance(fourth, backend, 1700);
      await until(async () => !(await tabIsIn(fourth)), "the tab goes once all is done");
      assert.equal(await onScreen(fourth), "vDays", "being on it when the last is ticked lands on Days");
      assert.equal(await fourth.evaluate(() => document.querySelector("#nav [data-tab=days]").classList.contains("is-active")), true);
      assert.equal(await fourth.evaluate(() => document.activeElement && document.activeElement.id), "dayCount", "focus goes to the day counter, not lost");
      // A later sync that brings an item back brings the tab back and does not take focus.
      await fourth.evaluate(() => document.getElementById("dayCount").focus());
      assert.equal((await backend.call("undo", { logId: Number(backend.fake.tables.Log[backend.fake.tables.Log.length - 1].id) }, "Ajen")).ok, true);
      await fourth.evaluate(() => window.__matTest.store.checkRev());
      await until(() => tabIsIn(fourth), "back, open again");
      assert.equal(await onScreen(fourth), "vDays", "still on Days");
      assert.equal(await fourth.evaluate(() => document.activeElement && document.activeElement.id), "dayCount", "focus left where it was");
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
      // Weight: the link is outlined like I’ll do it; the stamp spot alone is a solid vermilion ring.
      const look = await page.evaluate((s) => {
        const cs = (q) => getComputedStyle(document.querySelector(s + " " + q));
        const a = cs("a.bw-link");
        const c = cs(".bw-claim");
        const g = cs(".bw-tick .ghost");
        return { linkFill: a.backgroundColor, sameBorder: a.borderTopStyle === c.borderTopStyle && a.borderTopWidth === c.borderTopWidth && a.fontWeight === c.fontWeight, ring: g.borderTopStyle + " " + g.borderTopWidth, ringInk: g.borderTopColor };
      }, row(1));
      assert.deepEqual(look, { linkFill: "rgba(0, 0, 0, 0)", sameBorder: true, ring: "solid 2px", ringInk: "rgb(214, 60, 30)" });
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
      await stubSound(page);
      await openRow(page, "3");
      await page.click(row(3) + " .bw-tick");
      // Stamped in place, with the settle stamp's hit.
      await until(() => page.$(row(3) + ".is-landed .bw-spot .stamp.hit"), "the stamp lands on the row");
      assert.deepEqual(await rowIds(page), ["1", "2", "3", "4"], "still where it was");
      await until(() => page.evaluate(() => window.__thuds === 1), "the thud, once the tick is taken");
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
      assert.ok(await visible(page, "#bwDone"), "still open while the Before tab stays the screen");
      // It does not stay open: the next time the Before tab is shown it is folded again.
      await page.click('#nav button[data-tab="money"]');
      await page.click('#nav button[data-tab="before"]');
      await until(async () => !(await visible(page, "#bwDone")), "folded again");
      assert.equal(await page.getAttribute("#bwDoneB", "aria-expanded"), "false");
    },
  },
  {
    name: "a tick the planner can’t take yet: done in the app, and a line says the planner hasn’t been updated yet",
    async run({ page }) {
      const backend = await ready(page);
      backend.fake.planner.cellFails = true;
      await openRow(page, "1");
      await page.click(row(1) + " .bw-tick");
      await until(() => stored(backend, "1").ticked_by === "Mo", "ticked");
      await until(() => page.evaluate((s) => { const p = document.querySelector(s); return p && !p.hidden; }, row(1) + " .bw-pl"), "the pending line on the stamped row");
      await advance(page, backend, 1700);
      await until(() => page.$('#bwDone .bw-d[data-id="1"]'), "moved to done");
      await expectText(page, '#bwDone .bw-d[data-id="1"] .bw-pl', "The planner hasn’t been updated yet.");
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
      await stubSound(page);
      assert.equal((await backend.call("tickTodo", { id: "4" }, "Ajen")).ok, true);
      await openRow(page, "4");
      await page.click(row(4) + " .bw-tick");
      await expectText(page, "#ubarT", "That one is already done.");
      await until(() => page.evaluate((s) => { const r = document.querySelector(s); return !r || !r.classList.contains("is-landed"); }, row(4)), "no longer stamped");
      await advance(page, backend, 1700);
      assert.equal(await page.evaluate(() => window.__thuds), 0, "no thud for a tick refused");

      await page.context().setOffline(true);
      await openRow(page, "1");
      await page.click(row(1) + " .bw-tick");
      await expectText(page, "#ubarT", "No signal. That wasn’t saved.");
      await until(async () => (await rowIds(page)).includes("1") && !(await page.$(row(1) + ".is-landed")), "back to open");
      assert.equal(stored(backend, "1").ticked_by, "");
      assert.equal(await page.evaluate(() => window.__thuds), 0, "no thud offline either");
      await page.context().setOffline(false);
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
      assert.equal(await visible(other, "#beforeBtn"), false, "no planner: no tab");
      assert.equal(be.requests.filter((r) => r.action === "syncTodos").length, 0, "no planner: no fetch");
    },
  },
  {
    name: "fetched quietly once when an hour old, not when fresh; showing the Before tab again does not fetch a fresh list again",
    async run({ page, newPhone }) {
      const stale = await listBackend({ ago: 61 * MIN });
      await ready(page, { backend: stale });
      await until(() => sent(stale, "syncTodos").length === 1, "one fetch on start");
      assert.deepEqual(sent(stale, "syncTodos")[0].args, { force: false });
      await until(() => page.evaluate(() => /fetched/.test(document.getElementById("bwAt").textContent)), "fetched line");
      await page.click('#nav button[data-tab="money"]');
      await page.click('#nav button[data-tab="before"]');
      await page.evaluate(() => window.__matTest.store.idle());
      assert.equal(sent(stale, "syncTodos").length, 1, "fresh now: not again");
      assert.equal(await text(page, "#bwFetch"), "Fetch", "quietly: Fetch never said Fetching");

      const other = await newPhone();
      const fresh = await listBackend({ ago: 59 * MIN });
      await ready(other, { backend: fresh });
      await other.evaluate(() => window.__matTest.store.idle());
      await other.click('#nav button[data-tab="money"]');
      await other.click('#nav button[data-tab="before"]');
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

      // A forced fetch within 30 seconds of the last answers the stored list (R49 M3): go past that.
      await advance(page, backend, 30 * 1000);
      backend.fake.planner.fails = true;
      await page.click("#bwFetch");
      await expectText(page, "#bwFetch", "Not fetched");
      await expectText(page, "#ubarT", /planner/);

      // Quiet: an hour later, two failed fetches in a row before anything is said.
      await advance(page, backend, 61 * MIN);
      await page.evaluate(() => window.__matTest.store.clearNotice());
      await page.click('#nav button[data-tab="money"]');
      await page.click('#nav button[data-tab="before"]');
      await until(() => sent(backend, "syncTodos").length === 3, "a quiet fetch");
      await page.evaluate(() => window.__matTest.store.idle());
      assert.equal(await visible(page, "#ubar"), false, "first failure: nothing said");
      await page.click('#nav button[data-tab="money"]');
      await page.click('#nav button[data-tab="before"]');
      await until(() => sent(backend, "syncTodos").length === 4, "another quiet fetch");
      await expectText(page, "#ubarT", /planner/);
    },
  },
  {
    name: "sideways (844 × 390): the Before tab in the rail, a row opens and its controls fit",
    viewport: { width: 844, height: 390 },
    async run({ page }) {
      await ready(page, { claims: { 2: "Ajen" } });
      assert.ok(await visible(page, "#todos"));
      // The rail lists Days, Before, Money, You, then Ring up, each 44 px or more.
      const rail = await page.evaluate(() =>
        [...document.querySelectorAll("#nav button")].filter((b) => !b.hidden).map((b) => ({ id: b.dataset.tab || b.id, top: b.getBoundingClientRect().top, h: b.getBoundingClientRect().height })),
      );
      assert.deepEqual(rail.map((r) => r.id), ["days", "before", "money", "youBtn", "ring"]);
      assert.ok(rail.every((r, i) => r.h >= 44 && (i === 0 || r.top > rail[i - 1].top)), JSON.stringify(rail));
      await openRow(page, "1");
      const fit = await page.evaluate(() => {
        const view = document.getElementById("vBefore").getBoundingClientRect();
        const card = document.getElementById("bwCard").getBoundingClientRect();
        const tick = document.querySelector('#bwOpen .bw-r[data-id="1"] .bw-tick').getBoundingClientRect();
        const ctl = [...document.querySelectorAll('#bwOpen .bw-r[data-id="1"] .bw-ctl > *')].map((n) => n.getBoundingClientRect());
        const all = ctl.length === 3 && ctl.every((b) => b.left >= card.left && b.right <= card.right && b.width > 0);
        return { inside: card.left >= view.left && card.right <= view.right, tickIn: tick.right <= card.right, all, scroll: document.getElementById("vBefore").scrollWidth <= document.getElementById("vBefore").clientWidth };
      });
      assert.deepEqual(fit, { inside: true, tickIn: true, all: true, scroll: true });
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
  {
    name: "what the planner says is only ever text: markup is printed as written, a javascript: link is no link, a long word never pushes the page sideways",
    async run({ page }) {
      const items = [
        { "#": 1, Item: "<img src=x onerror=alert(1)>", "Book by": "2026-11-20", Status: "Not booked", Notes: "<b>bold?</b>", "Booking link": "javascript:alert(1)" },
        { "#": 2, Item: "A".repeat(300), "Book by": "2026-11-21", Status: "Not booked", "Booking link": "http://plain.example.test/x" },
      ];
      let dialogs = 0;
      page.on("dialog", (d) => {
        dialogs += 1;
        d.dismiss().catch(() => {});
      });
      await ready(page, { items });
      await expectText(page, row(1) + " .bw-n", "<img src=x onerror=alert(1)>");
      assert.equal(await page.$("#todos img"), null, "no image made from the item");
      await openRow(page, "1");
      await expectText(page, row(1) + " .bw-note", "<b>bold?</b>");
      assert.equal(await page.$(row(1) + " a"), null, "a javascript: link is no link");
      await openRow(page, "2");
      assert.equal(await page.$(row(2) + " a"), null, "an http: link is no link on the phone");
      const wide = await page.evaluate(() => {
        const v = document.getElementById("vBefore");
        const t = document.getElementById("todos");
        return { view: v.scrollWidth <= v.clientWidth, list: t.scrollWidth <= t.clientWidth };
      });
      assert.deepEqual(wide, { view: true, list: true });
      assert.equal(dialogs, 0, "no dialog fired");
    },
  },
  {
    name: "Fetch tapped while a quiet fetch is under way: that one finishes, then the tap gets its own forced fetch",
    async run({ page }) {
      const backend = await listBackend({ ago: 61 * MIN });
      let release;
      const gate = new Promise((r) => (release = r));
      const handle = backend.handle;
      let held = 0;
      backend.handle = async (body) => {
        if (body.action === "syncTodos" && held++ === 0) await gate;
        return handle(body);
      };
      await ready(page, { backend });
      await until(() => held === 1, "the quiet fetch is out");
      await page.click("#bwFetch");
      await expectText(page, "#bwFetch", "Fetching…");
      release();
      await expectText(page, "#bwFetch", "Up to date ✓");
      assert.deepEqual(sent(backend, "syncTodos").map((r) => r.args), [{ force: false }, { force: true }]);
      // Within 30 seconds of the last pull the backend answers the stored list: the line shows when that was.
      const pulled = await page.evaluate(() => window.__matTest.store.state.todosPulledAt);
      assert.ok(pulled);
      const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Date.parse(pulled)));
      await expectText(page, "#bwAt", "From the planner · fetched " + clock);
    },
  },
  {
    name: "the planner's own say: an undo that leaves the planner alone is no error; a pull that takes a tick off shows the item open again",
    async run({ page }) {
      const backend = await ready(page);
      const undos = [];
      const handle = backend.handle;
      backend.handle = async (body) => {
        const env = await handle(body);
        if (body.action === "undo") undos.push(env);
        return env;
      };
      // Ticked and written, then someone changes the planner's Status by hand.
      await openRow(page, "3");
      await page.click(row(3) + " .bw-tick");
      await until(() => stored(backend, "3").planner_written === "yes", "written");
      bookRow(backend, 3)[4] = "Booked (paid at the desk)";
      await page.click("#ubarU");
      await expectText(page, "#ubarT", "Undone.");
      await until(() => stored(backend, "3").ticked_by === "", "undone");
      assert.equal(backend.requests.filter((r) => r.action === "undo").length, 1);
      assert.deepEqual(undos.map((e) => [e.ok, e.data && e.data.planner]), [[true, "kept"]], "the backend answered kept");
      assert.deepEqual(backend.fake.planner.writes.map((w) => w.kind), ["cell", "append"], "the planner was left alone (kept)");
      assert.equal(bookRow(backend, 3)[4], "Booked (paid at the desk)");
      await page.evaluate(() => window.__matTest.store.idle());
      assert.equal(await page.evaluate(() => window.__matTest.store.state.notice), null, "no error said");

      // A tick the planner has not taken; then the planner gives that number to another item.
      backend.fake.planner.cellFails = true;
      await openRow(page, "1");
      await page.click(row(1) + " .bw-tick");
      await until(() => stored(backend, "1").ticked_by === "Mo", "ticked");
      await advance(page, backend, 1700);
      await until(() => page.$('#bwDone .bw-d[data-id="1"]'), "done in the app");
      bookRow(backend, 1)[1] = "Rail pass return leg";
      backend.fake.planner.cellFails = false;
      await advance(page, backend, 31 * 1000);
      await page.click("#bwFetch");
      await until(async () => (await rowIds(page)).includes("1"), "open again");
      await expectText(page, row(1) + " .bw-n", "Rail pass return leg");
      assert.equal(await page.evaluate((s) => document.querySelector(s).classList.contains("is-empty"), row(1) + " .bw-seal"), true);
      assert.equal(await page.$('#bwDone .bw-d[data-id="1"]'), null);
    },
  },
];

// The bottom bar's four tabs and the button, measured: on one line, apart, inside the bar, no text clipped, each at least 44 px tall.
async function barShape(page) {
  return page.evaluate(() => {
    const nav = document.getElementById("nav").getBoundingClientRect();
    const items = [...document.querySelectorAll("#nav button")].filter((b) => !b.hidden);
    const rects = items.map((b) => b.getBoundingClientRect());
    const overlap = [];
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const c = rects[j];
        if (a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5) overlap.push(items[i].textContent + "/" + items[j].textContent);
      }
    const centres = rects.map((r) => r.top + r.height / 2);
    const clipped = items.filter((b) => {
      const r = b.getBoundingClientRect();
      return b.scrollWidth > b.clientWidth + 1 || [...b.children].some((c) => c.getClientRects().length && (c.getBoundingClientRect().right > r.right + 0.5 || c.getBoundingClientRect().left < r.left - 0.5));
    }).map((b) => b.textContent);
    const ring = document.getElementById("ring");
    return {
      names: items.map((b) => b.getAttribute("aria-label") || b.dataset.tab || b.id),
      overlap,
      oneLine: Math.max(...centres) - Math.min(...centres) <= 3,
      inside: rects.every((r) => r.left >= nav.left - 0.5 && r.right <= nav.right + 0.5),
      tall: rects.every((r) => r.height >= 44),
      clipped,
      pageWide: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ringText: ring.innerText.replace(/\s+/g, " ").trim(),
      ringName: ring.getAttribute("aria-label"),
    };
  });
}

for (const width of [320, 350, 390, 430]) {
  module.exports.push({
    name: "the bar at " + width + " px: Days, Before, Money, You and the button on one line, no overlap, nothing clipped, each tab 44 px tall" + (width <= 350 ? "; the button is the plus alone" : ""),
    viewport: { width, height: 760 },
    async run({ page }) {
      await ready(page, { claims: { 2: "Ajen" }, go: false });
      await until(() => tabIsIn(page), "the Before tab is in the bar");
      // With a count showing, on Days and on Before.
      for (const tab of ["days", "before"]) {
        await page.click('#nav button[data-tab="' + tab + '"]');
        const shape = await barShape(page);
        assert.deepEqual(shape.overlap, [], "overlap on " + tab);
        assert.equal(shape.oneLine, true, "one line");
        assert.equal(shape.inside, true, "inside the bar");
        assert.equal(shape.tall, true, "44 px tall");
        assert.deepEqual(shape.clipped, [], "clipped text");
        assert.equal(shape.pageWide, true, "the page is not wider than the screen");
        assert.equal(shape.names.length, 5);
        assert.equal(shape.ringName, "Ring up");
        assert.equal(shape.ringText, width <= 350 ? "＋" : "＋ Ring up");
      }
      // The pill sits on its tab, inside the bar.
      const pill = await page.evaluate(() => {
        const p = document.getElementById("beforeN").getBoundingClientRect();
        const n = document.getElementById("nav").getBoundingClientRect();
        return { in: p.left >= n.left && p.right <= n.right && p.top >= n.top, text: document.getElementById("beforeN").textContent };
      });
      assert.deepEqual(pill, { in: true, text: "4" });
    },
  });
}

module.exports.push({
  name: "the bar has a crisp edge: a black top border and a contact shadow, and no gradient drawn above it",
  async run({ page }) {
    await ready(page, { go: false });
    const edge = await page.evaluate(() => {
      const nav = document.getElementById("nav");
      const cs = getComputedStyle(nav);
      const before = getComputedStyle(nav, "::before");
      return { image: before.backgroundImage, content: before.content, top: cs.borderTopWidth + " " + cs.borderTopStyle + " " + cs.borderTopColor, shadow: cs.boxShadow, height: nav.getBoundingClientRect().height };
    });
    assert.equal(edge.image, "none", "no gradient");
    assert.equal(edge.content, "none", "no ::before at all");
    assert.equal(edge.top, "1px solid rgb(0, 0, 0)");
    assert.equal(edge.shadow, "rgba(0, 0, 0, 0.7) 0px -12px 18px -12px");
    assert.equal(edge.height, 74);
  },
});

module.exports.push({
  name: "the list's last row can be scrolled clear above the bar",
  async run({ page }) {
    const items = [];
    for (let i = 1; i <= 14; i++) items.push({ "#": i, Item: "Made-up booking " + i, "Book by": "2026-12-0" + ((i % 9) + 1), Status: "Not booked" });
    await ready(page, { items });
    const gap = await page.evaluate(() => {
      const v = document.getElementById("vBefore");
      v.scrollTop = v.scrollHeight;
      const foot = document.querySelector("#bwCard .bw-foot").getBoundingClientRect();
      return document.getElementById("nav").getBoundingClientRect().top - foot.bottom;
    });
    assert.ok(gap >= 0, "the foot ends " + gap + " px above the bar");
  },
});

// Two-digit counts: about 18 open items is the real list; 99 is the most the pill is asked to hold.
const manyItems = (n) => Array.from({ length: n }, (_, i) => ({ "#": i + 1, Item: "Made-up booking " + (i + 1), "Book by": "2026-12-0" + ((i % 9) + 1), Status: "Not booked" }));

for (const [n, widths] of [[18, [320, 360, 375, 380, 390, 430]], [99, [320, 390]]]) {
  for (const width of widths) {
    module.exports.push({
      name: "the bar with " + n + " open items at " + width + " px: one line, no overlap, nothing clipped, the pill reads " + n,
      viewport: { width, height: 760 },
      async run({ page }) {
        await ready(page, { items: manyItems(n), go: false });
        await until(() => tabIsIn(page), "the Before tab is in the bar");
        // The planner read stops short of 99 rows: put the number on the pill itself (it is the pill's room under test).
        if (n === 99) await page.evaluate(() => { document.getElementById("beforeN").textContent = "99"; });
        for (const tab of ["days", "before"]) {
          await page.click('#nav button[data-tab="' + tab + '"]');
          if (n === 99) await page.evaluate(() => { document.getElementById("beforeN").textContent = "99"; });
          const shape = await barShape(page);
          assert.deepEqual(shape.overlap, [], "overlap on " + tab);
          assert.equal(shape.oneLine, true, "one line");
          assert.equal(shape.inside, true, "inside the bar");
          assert.equal(shape.tall, true, "44 px tall");
          assert.deepEqual(shape.clipped, [], "clipped text");
          assert.equal(shape.pageWide, true, "the page is not wider than the screen");
          assert.equal(shape.names.length, 5);
          const more = await page.evaluate(() => {
            const nav = document.getElementById("nav");
            const bad = [...nav.querySelectorAll("*")].filter((e) => e.getClientRects().length && e.scrollWidth > e.clientWidth).map((e) => e.id || e.className || e.tagName);
            return { bad, navScroll: nav.scrollWidth, navClient: nav.clientWidth, pill: document.getElementById("beforeN").textContent };
          });
          assert.deepEqual(more.bad, [], "scrollWidth over clientWidth");
          assert.equal(more.navScroll, more.navClient, "the bar does not scroll sideways");
          assert.equal(more.pill, String(n));
        }
      },
    });
  }
}

module.exports.push({
  name: "tapping the Before tab while on it does nothing: the done group stays open and no extra fetch goes out",
  async run({ page }) {
    const backend = await ready(page);
    await page.click("#bwDoneB");
    await until(() => visible(page, "#bwDone"), "the done group opens");
    const before = sent(backend, "syncTodos").length;
    await page.click('#nav button[data-tab="before"]');
    await page.waitForTimeout(300);
    assert.equal(await visible(page, "#bwDone"), true, "still open");
    assert.equal(sent(backend, "syncTodos").length, before, "no extra syncTodos");
  },
});

module.exports.push({
  name: "the Before tab goes while focus is on it: focus moves to the Days tab",
  async run({ page }) {
    // During the trip the tab is only there while something is open.
    const backend = await ready(page, { nowMs: NOON12, items: [ITEMS[1], ITEMS[4]] });
    await page.focus('#nav button[data-tab="before"]');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.tab), "before");
    assert.equal((await backend.call("tickTodo", { id: "2" }, "Ajen")).ok, true, "ticked on another phone");
    await advance(page, backend, 31 * 1000);
    await page.evaluate(() => window.__matTest.store.checkRev());
    await advance(page, backend, 1700);
    await until(async () => !(await tabIsIn(page)), "the tab goes");
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.tab), "days", "focus is on Days, not the body");
  },
});
