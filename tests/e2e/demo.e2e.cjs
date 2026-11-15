// The demo clock: from Settings, "Try another day" makes the Days screen
// behave as if it were a chosen trip day (07:00, running 120x, holding at
// 23:30). Only Days follows it: Money, the register's day, History times and
// everything sent to the backend use the real time (R28). Nothing is stored,
// so a reload ends it. The plan is tests/fixtures/plan.json over the seed; the
// real time is Nov 15, 12:00 in Japan, before the trip.

const assert = require("node:assert/strict");
const { WITH_PLAN, open, advance, until, text, expectText, visible } = require("./helpers.cjs");

const NOV15 = Date.parse("2026-11-15T12:00:00+09:00");
const row = (id) => '.r[data-id="' + id + '"]';
const MEIJI = "planstop1201";
const SKY = "planstop1203";
const WRITES = ["addExpense", "editExpense", "deleteExpense", "addStop", "editStop", "addStay", "setPerson", "undo"];

async function ready(page, opts = {}) {
  const backend = await open(page, { seed: WITH_PLAN, tab: "days", nowMs: NOV15, ...opts });
  await until(() => page.evaluate(() => document.querySelectorAll("#rail .pg .tk").length === 11), "the tickets draw");
  return backend;
}

const waitYou = (page) =>
  until(() => page.evaluate(() => {
    const s = document.getElementById("you");
    return s.classList.contains("is-open") && Math.abs(s.getBoundingClientRect().bottom - innerHeight) < 1;
  }), "Settings opens");

// Settings, Try another day, then the day's button ("Sat 12").
async function tryDay(page, label) {
  await page.click("#youBtn");
  await waitYou(page);
  await page.click("#setDemo");
  await until(() => visible(page, "#setDemoDays button"), "the days show");
  const date = await page.evaluate((l) => [...document.querySelectorAll("#setDemoDays button[data-date]")].find((b) => b.textContent === l).dataset.date, label);
  await page.click('#setDemoDays button[data-date="' + date + '"]');
  await expectText(page, "#demo", /^Pretending it’s /);
}

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
const klass = (page, sel) => page.evaluate((s) => (document.querySelector(s) || { className: "" }).className, sel);
const writes = (backend) => backend.requests.filter((r) => WRITES.includes(r.action));

module.exports = [
  {
    name: "try a day: Settings closes, Days shows that day at 07:00",
    async run({ page }) {
      await ready(page);
      await expectText(page, "#dayCount", /^Day 1 of 11 in 25 days/);
      assert.equal(await visible(page, "#demo"), false);
      await page.click("#youBtn");
      await waitYou(page);
      await expectText(page, "#setDemo", /^Try another day\s*See how a day will look before you go/);
      assert.equal(await visible(page, "#setDemoDays"), false, "the days are folded away");
      await page.click("#setDemo");
      const labels = await page.$$eval("#setDemoDays button[data-date]", (bs) => bs.map((b) => b.textContent));
      assert.equal(labels.length, 11);
      assert.equal(labels[2], "Sat 12");
      await page.click('#setDemoDays button[data-date="2026-12-12"]');
      await until(() => page.evaluate(() => !document.getElementById("you").classList.contains("is-open")), "Settings closes");
      await expectText(page, "#demo", "Pretending it’s Sat Dec 12, 07:00Stop");
      await expectText(page, "#dayCount", /^Day 3 of 11 today/);
      await until(async () => (await inView(page)) === "2026-12-12", "Dec 12 is in view");
      assert.ok((await klass(page, row(MEIJI))).includes("is-next"), "Meiji Shrine is next");
      await expectText(page, row(MEIJI) + " .r-s", /^Next, in 2 h\./);
      assert.equal(await visible(page, "#demo"), true);
    },
  },
  {
    name: "it runs fast, and Shibuya Sky is done by 15:00",
    async run({ page }) {
      const backend = await ready(page);
      await tryDay(page, "Sat 12");
      await advance(page, backend, 60000);
      await expectText(page, "#demo", /09:00/);
      await expectText(page, row(MEIJI) + " .r-s", /^Now\./);
      await advance(page, backend, 180000);
      await expectText(page, "#demo", /15:00/);
      await until(async () => (await klass(page, row(SKY))).includes("is-done"), "Shibuya Sky is done");
    },
  },
  {
    name: "it holds at the end of the day",
    async run({ page }) {
      const backend = await ready(page);
      await tryDay(page, "Sat 12");
      await advance(page, backend, 600000);
      await expectText(page, "#demo", /Sat Dec 12, 23:30/);
      await expectText(page, "#dayCount", /^Day 3 of 11 today/);
      await advance(page, backend, 600000);
      await expectText(page, "#demo", /Sat Dec 12, 23:30/);
    },
  },
  {
    name: "it touches nothing real: Ring up is dated with the real day, History times are real",
    async run({ page }) {
      const backend = await ready(page);
      await tryDay(page, "Sat 12");
      await advance(page, backend, 60000); // the demo says 09:00; the real time is 12:01 on Nov 15
      await page.click("#ring");
      await until(() => page.evaluate(() => {
        const r = document.getElementById("reg");
        return r.classList.contains("is-open") && Math.abs(r.getBoundingClientRect().bottom - innerHeight) < 1;
      }), "the register opens");
      await expectText(page, "#xDay", "Before");
      assert.equal(writes(backend).length, 0, "opening the register sends nothing");
      await page.fill("#xWhat", "Ramen");
      for (const k of "5 0 0".split(" ")) await page.click('#pad .key[data-k="' + k + '"]');
      await until(() => page.evaluate(() => !document.getElementById("kGo").disabled), "Ring it up is ready");
      await page.click("#kGo");
      const add = await until(() => backend.requests.find((r) => r.action === "addExpense"), "the line is sent");
      assert.equal(add.args.expense.day, "pre", "dated with the real day");
      assert.equal(writes(backend).length, 1);
      await page.click("#regDone");
      await expectText(page, "#demo", /Pretending it’s Sat Dec 12, 09:/);
      // History: the line was added at the real 12:01, not at the demo's time.
      await page.click("#youBtn");
      await waitYou(page);
      await page.click("#setHist");
      await until(() => page.evaluate(() => document.querySelectorAll("#tape .tp-row").length > 0), "History has rows");
      const first = await page.$eval("#tape .tp-row time", (t) => t.textContent);
      assert.equal(first, "12:01", "History shows the real time");
      assert.equal(await text(page, "#tape .tp-row .tp-s"), "Mo rang up Ramen ¥500");
    },
  },
  {
    name: "Stop ends it, with no signal too",
    async run({ page }) {
      const backend = await ready(page);
      await tryDay(page, "Sat 12");
      backend.failWith = "network";
      await page.click("#demoStop");
      await until(async () => !(await visible(page, "#demo")), "the banner goes");
      await expectText(page, "#dayCount", /^Day 1 of 11 in 25 days/);
      await until(async () => (await inView(page)) === "2026-12-10", "the rail is back on Day 1");
      assert.equal(await visible(page, "#demoStop"), false);
    },
  },
  {
    name: "a day browsed while the demo runs is left alone, then Stop goes back to the real today",
    async run({ page }) {
      const backend = await ready(page);
      await tryDay(page, "Sat 12");
      await page.click("#pager .sq:nth-child(6)");
      await until(async () => (await inView(page)) === "2026-12-15", "Dec 15 is in view");
      await advance(page, backend, 120000);
      await expectText(page, "#demo", /11:00/);
      assert.equal(await inView(page), "2026-12-15", "the rail stays where it was put");
      await page.click("#demoStop");
      await until(async () => (await inView(page)) === "2026-12-10", "Stop returns to Day 1");
    },
  },
  {
    name: "the all-days list follows the demo",
    async run({ page }) {
      const backend = await ready(page);
      await tryDay(page, "Sat 12");
      await page.click("#dayCount");
      await until(() => page.evaluate(() => document.getElementById("allDays").classList.contains("is-open")), "the list opens");
      const stamps = () => page.$$eval("#allDaysList .ad-row", (rows) => rows.map((r) => (r.querySelector(".ad-st") || {}).textContent || ""));
      const s = await stamps();
      assert.deepEqual(s.slice(0, 4), ["used", "used", "today", ""]);
      await page.keyboard.press("Escape");
      await page.click("#demoStop");
      await page.click("#dayCount");
      await until(async () => (await stamps()).every((x) => x === "" ), "the list is back to the real day");
      void backend;
    },
  },
  {
    name: "a reload ends it",
    async run({ page }) {
      await ready(page);
      await tryDay(page, "Sat 12");
      await page.reload();
      await until(() => page.evaluate(() => document.querySelectorAll("#rail .pg .tk").length === 11), "the tickets draw again");
      assert.equal(await visible(page, "#demo"), false);
      await expectText(page, "#dayCount", /^Day 1 of 11 in 25 days/);
      assert.equal(await page.evaluate(() => JSON.stringify(Object.keys(localStorage).filter((k) => /demo|pretend/i.test(k)))), "[]", "nothing stored");
    },
  },
  {
    name: "started from Money: Days shows, and Money keeps the real day",
    async run({ page }) {
      await ready(page, { tab: "money" });
      await page.click("#youBtn");
      await waitYou(page);
      await page.click("#setDemo");
      await page.click('#setDemoDays button[data-date="2026-12-12"]');
      await expectText(page, "#demo", /Pretending it’s Sat Dec 12, 07:/);
      assert.equal(await page.evaluate(() => document.getElementById("vDays").classList.contains("is-active")), true);
      await expectText(page, "#dayCount", /^Day 3 of 11 today/);
      await until(async () => (await inView(page)) === "2026-12-12", "Dec 12 is in view");
      assert.equal(await page.evaluate(() => localStorage.getItem("mat.tab")), "money", "the remembered screen is untouched");
    },
  },
];
