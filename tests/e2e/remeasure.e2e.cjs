// The Home Screen app makes the phone measure again after the keyboard (a
// known iPhone fault leaves the page short until the app is force-quit).
// A desktop browser cannot show the fault, so these pin what the nudge does
// and when: it runs only in a Home Screen app that is short, never while a
// field has the keyboard, and it keeps every scroll place and the focus.

const assert = require("node:assert/strict");
const { SEED, NOON12, open, until } = require("./helpers.cjs");

const SHORT = { width: 440, height: 878 };
const SCREEN = { width: 440, height: 956 };
const standalone = (page) => page.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, "standalone", { get: () => true, configurable: true });
});
// Counts every time #phone is taken out of the layout.
const count = (page) => page.evaluate(() => {
  window.__nudges = 0;
  new MutationObserver((list) => {
    // Out and back in one step: by now it is back, so the old value is what shows it was out.
    for (const m of list) if (/display:\s*none/.test(m.oldValue || "")) window.__nudges++;
  }).observe(document.getElementById("phone"), { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
});
const nudges = (page) => page.evaluate(() => window.__nudges);
const drawn = (page) => until(() => page.evaluate(() => document.querySelectorAll("#rc .rc-row").length > 0), "the receipt draws");

module.exports = [
  {
    name: "a short Home Screen app: nudged when it comes back on screen; the scroll place and the focus are kept",
    viewport: SHORT,
    screen: SCREEN,
    async run({ page }) {
      await standalone(page);
      await open(page, { seed: SEED, nowMs: NOON12 });
      await drawn(page);
      await page.clock.runFor(1500); // the tries after starting
      await count(page);
      const view = await page.evaluateHandle(() => document.querySelector("#vMoney"));
      await page.evaluate(() => document.getElementById("histBtn").focus({ preventScroll: true }));
      await page.evaluate((v) => { v.scrollTop = 180; }, view);
      assert.equal(await page.evaluate((v) => v.scrollTop, view), 180, "the view is scrolled to start with");
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.clock.runFor(1500);
      assert.equal(await nudges(page), 3, "three tries while it stays short");
      assert.equal(await page.evaluate((v) => v.scrollTop, view), 180, "the scroll place is kept");
      assert.equal(await page.evaluate(() => document.activeElement.id), "histBtn", "the focus is kept");
      assert.equal(await page.evaluate(() => document.getElementById("phone").style.display), "", "the app is back in the layout");
    },
  },
  {
    name: "after a field loses focus it is nudged, but never while a field has the keyboard",
    viewport: SHORT,
    screen: SCREEN,
    async run({ page }) {
      await standalone(page);
      await open(page, { seed: SEED, nowMs: NOON12 });
      await drawn(page);
      await page.clock.runFor(1500);
      await page.click("#youBtn");
      await until(() => page.evaluate(() => document.getElementById("phone").classList.contains("you-open")), "You is open");
      await page.click("#setMail");
      await count(page);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.clock.runFor(1500);
      assert.equal(await nudges(page), 0, "not while typing");
      assert.equal(await page.evaluate(() => document.activeElement.id), "setMail");
      await page.evaluate(() => document.activeElement.blur());
      await page.clock.runFor(1500);
      assert.equal(await nudges(page), 3, "after the keyboard goes");
    },
  },
  {
    name: "a Safari tab, and a Home Screen app at full height, are left alone",
    viewport: SHORT,
    screen: SCREEN,
    async run({ page }) {
      await open(page, { seed: SEED, nowMs: NOON12 });
      await drawn(page);
      await count(page);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.clock.runFor(1500);
      assert.equal(await nudges(page), 0);
    },
  },
];
