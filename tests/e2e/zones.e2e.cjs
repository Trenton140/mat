// A phone set to a Canadian time zone (final review M4): Days still follows
// Japan. For America/Toronto and America/Vancouver, at three instants in the
// trip (just before and just after Tokyo midnight, mid-afternoon in Tokyo)
// and three before it: today's ticket, the used days, leave-by and the
// countdown. Toronto and Vancouver are still on the earlier calendar day at
// every one of these instants, so a phone-zone date would show the wrong day.

const assert = require("node:assert/strict");
const { WITH_PLAN, open, until, text, expectText } = require("./helpers.cjs");

const jp = (iso) => Date.parse(iso + "+09:00");
const tk = (date) => '#rail .pg[data-date="' + date + '"]';
const row = (id) => '.r[data-id="' + id + '"]';

// Stops whose leave-by line each instant can read.
const EXTRA = [
  { id: "zonestop0001", date: "2026-12-12", time: "16:00", title: "Tower Records", travelMin: 30 },
  { id: "zonestop0002", date: "2026-12-12", time: "23:58", title: "Last train", travelMin: 5 },
  { id: "zonestop0003", date: "2026-12-13", time: "00:30", title: "Night bus", travelMin: 10 },
];
const SEED = { ...WITH_PLAN, stops: [...WITH_PLAN.stops, ...EXTRA] };

async function ready(page, nowMs) {
  await open(page, { seed: SEED, tab: "days", nowMs });
  await until(() => page.evaluate(() => document.querySelectorAll("#rail .pg .tk").length === 11), "the tickets draw");
}

// The squares filled as used, as "1110000…".
const used = (page) => page.evaluate(() => [...document.querySelectorAll("#pager .sq")].map((b) => (b.classList.contains("is-done") ? "1" : "0")).join(""));
// The day whose ticket sits in the middle of the rail.
const inView = (page) =>
  page.evaluate(() => {
    const rail = document.getElementById("rail").getBoundingClientRect();
    const mid = rail.left + rail.width / 2;
    let best = null;
    for (const pg of document.querySelectorAll("#rail .pg")) {
      const r = pg.getBoundingClientRect();
      const off = Math.abs(r.left + r.width / 2 - mid);
      if (!best || off < best.off) best = { date: pg.dataset.date, off };
    }
    return best && best.off < 2 ? best.date : null;
  });

const TRIP = [
  { at: "2026-12-12T23:50:00", label: "just before Tokyo midnight", day: "2026-12-12", count: /^Day 3 of 11 ?today$/, used: "11000000000", next: "zonestop0002", leave: "Leave by 23:53, in 3 min." },
  { at: "2026-12-13T00:10:00", label: "just after Tokyo midnight", day: "2026-12-13", count: /^Day 4 of 11 ?today$/, used: "11100000000", next: "zonestop0003", leave: "Leave by 00:20, in 10 min." },
  { at: "2026-12-12T15:00:00", label: "mid-afternoon in Tokyo", day: "2026-12-12", count: /^Day 3 of 11 ?today$/, used: "11000000000", next: "zonestop0001", leave: "Leave by 15:30, in 30 min." },
];
const BEFORE = [
  { at: "2026-12-09T23:50:00", label: "just before Tokyo midnight on the eve", count: /^Day 1 of 11 ?tomorrow$/, countdown: "あと1日" },
  { at: "2026-12-10T00:10:00", label: "just after Tokyo midnight on Day 1", count: /^Day 1 of 11 ?today$/, countdown: null },
  { at: "2026-11-15T15:00:00", label: "mid-afternoon in Tokyo, weeks before", count: /^Day 1 of 11 ?in 25 days$/, countdown: "あと25日" },
];

const cases = [];
for (const zone of ["America/Toronto", "America/Vancouver"]) {
  for (const t of TRIP) {
    cases.push({
      name: zone + ", " + t.label + ": today's ticket, used days and leave-by follow Japan",
      timezoneId: zone,
      async run({ page }) {
        await ready(page, jp(t.at));
        assert.notEqual(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), "Asia/Tokyo");
        await expectText(page, "#dayCount", t.count);
        await until(async () => (await inView(page)) === t.day, "today's ticket is in view");
        assert.equal(await used(page), t.used);
        assert.equal(await page.evaluate((sel) => document.querySelectorAll(sel + " .insp").length, tk(t.day)), 0, "today is not stamped used");
        await until(() => page.evaluate((sel) => document.querySelector(sel).classList.contains("is-next"), row(t.next)), t.next + " is next");
        assert.equal(await text(page, row(t.next) + " .r-lv"), t.leave);
      },
    });
  }
  for (const t of BEFORE) {
    cases.push({
      name: zone + ", " + t.label + ": the countdown follows Japan",
      timezoneId: zone,
      async run({ page }) {
        await ready(page, jp(t.at));
        await expectText(page, "#dayCount", t.count);
        assert.equal(await used(page), "00000000000");
        const d10 = await text(page, tk("2026-12-10") + " .tk-date");
        if (t.countdown) assert.ok(d10.includes(t.countdown), d10);
        else assert.equal(/あと\d+日/.test(d10), false, d10);
      },
    });
  }
}

module.exports = cases;
