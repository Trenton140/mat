// Screen check (under You): try each way of reaching the bottom of the
// screen on this phone and keep the one that works (js/fit.js). The phone
// here is told 878 of a 956-point screen, as Mo's iPhone is.

const assert = require("node:assert/strict");
const { SEED, NOON12, open, until } = require("./helpers.cjs");

const SHORT = { width: 440, height: 878 };
const SCREEN = { width: 440, height: 956 };
const drawn = (page) => until(() => page.evaluate(() => document.querySelectorAll("#rc .rc-row").length > 0), "the receipt draws");
const openCheck = async (page) => {
  await page.click("#youBtn");
  await until(() => page.evaluate(() => document.getElementById("phone").classList.contains("you-open")), "You is open");
  await page.evaluate(() => document.getElementById("setScreen").scrollIntoView({ block: "center" }));
  await page.click("#setScreen");
  await until(() => page.evaluate(() => !!document.getElementById("screenCheck")), "the check opens");
};
const look = (page) => page.evaluate(() => {
  const root = document.documentElement;
  const r = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().bottom);
  return { cls: root.className.trim(), full: root.style.getPropertyValue("--full-h"), phone: r("#phone"), nav: r(".nav"), fixed: getComputedStyle(document.body).position, kept: localStorage.getItem("mat.fit2") };
});
const tap = (page, fit) => page.click('#screenCheck button[data-fit="' + fit + '"]');

module.exports = [
  {
    name: "Screen check closes You and shows a panel at the top with the five ways and Done; the app shows under it",
    viewport: SHORT,
    screen: SCREEN,
    async run({ page }) {
      await open(page, { seed: SEED, nowMs: NOON12 });
      await drawn(page);
      await openCheck(page);
      assert.equal(await page.evaluate(() => document.getElementById("phone").classList.contains("you-open")), false, "You is closed so the bar can be seen");
      assert.deepEqual(await page.$$eval("#screenCheck button", (bs) => bs.map((b) => b.textContent)), ["Now", "A", "B", "C", "D", "Done"]);
      assert.equal(await page.getAttribute('#screenCheck button[data-fit=""]', "aria-pressed"), "true");
      const box = await page.evaluate(() => { const r = document.getElementById("screenCheck").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, w: r.width }; });
      assert.ok(box.bottom < 440, "the panel stays in the top half: " + JSON.stringify(box));
      assert.match(await page.evaluate(() => document.getElementById("screenCheck").textContent), /screen 440 x 956 · inner 440 x 878/);
      assert.deepEqual(await look(page), { cls: "", full: "", phone: 878, nav: 878, fixed: "static", kept: null });
    },
  },
  {
    name: "each way is applied the moment it is tapped, never pins the page, and is remembered across a reload",
    viewport: SHORT,
    screen: SCREEN,
    async run({ page }) {
      await open(page, { seed: SEED, nowMs: NOON12 });
      await drawn(page);
      await openCheck(page);
      await tap(page, "a");
      assert.deepEqual(await look(page), { cls: "fit-a", full: "956px", phone: 956, nav: 956, fixed: "static", kept: "a" });
      assert.equal(await page.getAttribute('#screenCheck button[data-fit="a"]', "aria-pressed"), "true");
      await tap(page, "c");
      assert.deepEqual(await look(page), { cls: "fit-c", full: "956px", phone: 956, nav: 956, fixed: "static", kept: "c" });
      await tap(page, "b");
      const b = await look(page);
      assert.equal(b.cls, "fit-b");
      assert.equal(b.phone, 878, "100lvh is the told height in this browser");
      await tap(page, "d");
      assert.equal((await look(page)).cls, "fit-d");
      await tap(page, "a");
      await page.click("#screenCheckDone");
      assert.equal(await page.evaluate(() => !!document.getElementById("screenCheck")), false);
      await page.reload();
      await drawn(page);
      assert.deepEqual(await look(page), { cls: "fit-a", full: "956px", phone: 956, nav: 956, fixed: "static", kept: "a" });
      // Back to as it is.
      await openCheck(page);
      await tap(page, "");
      assert.deepEqual(await look(page), { cls: "", full: "", phone: 878, nav: 878, fixed: "static", kept: "" });
    },
  },
  {
    name: "the way in use is in the Report a problem note",
    viewport: SHORT,
    screen: SCREEN,
    async run({ page, context }) {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await open(page, { seed: SEED, nowMs: NOON12, storage: { "mat.fit2": "a" } });
      await drawn(page);
      await page.click("#youBtn");
      await until(() => page.evaluate(() => document.getElementById("phone").classList.contains("you-open")), "You is open");
      await page.evaluate(() => document.getElementById("setReport").scrollIntoView({ block: "center" }));
      await page.click("#setReport");
      await until(async () => /fit a/.test(await page.evaluate(() => navigator.clipboard.readText()).catch(() => "")), "the note says fit a");
    },
  },
  {
    // This browser cannot be put in Home Screen mode, so the rule is read from the stylesheet;
    // that it works on an iPhone was seen on Mo's (2026-11-17).
    name: "the stylesheet gives a Home Screen app the large viewport height, a browser tab is unchanged, and the old trial pick is not used",
    viewport: SHORT,
    screen: SCREEN,
    async run({ page }) {
      await open(page, { seed: SEED, nowMs: NOON12, storage: { "mat.fit": "d" } });
      await drawn(page);
      const seen = await page.evaluate(async () => {
        const css = await (await fetch("css/base.css")).text();
        const at = css.indexOf("@media (display-mode: standalone)");
        return { rule: at < 0 ? "" : css.slice(at, css.indexOf("}", css.indexOf("}", at) + 1) + 1).replace(/\s+/g, " "), html: getComputedStyle(document.documentElement).height, cls: document.documentElement.className.trim(), nav: Math.round(document.querySelector(".nav").getBoundingClientRect().bottom) };
      });
      assert.equal(seen.rule, "@media (display-mode: standalone){ html{height:100%;height:max(100%, 100lvh)} }");
      assert.equal(seen.html, "878px");
      assert.equal(seen.nav, 878);
      assert.equal(seen.cls, "", "the trial kept under the old name is not used");
    },
  },
];
