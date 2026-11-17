// Screen check: holding "Report a problem" for a second shows what the phone
// reports and six marks; a tap goes to page 2, another closes it and puts the
// page back. An ordinary tap still copies the note.

const assert = require("node:assert/strict");
const { SEED, NOON12, open, until } = require("./helpers.cjs");

module.exports = [
  {
    name: "held for a second it opens; two taps close it and the page is as it was",
    async run({ page }) {
      await open(page, { seed: SEED, nowMs: NOON12 });
      await until(() => page.evaluate(() => document.querySelectorAll("#rc .rc-row").length > 0), "the receipt draws");
      await page.click("#youBtn");
      await until(() => page.evaluate(() => { const r = document.getElementById("setReport"); return r && r.getBoundingClientRect().height > 0; }), "You is open");
      const before = await page.evaluate(() => [document.documentElement.getAttribute("style") || "", document.body.getAttribute("style") || ""]);
      await page.evaluate(() => document.getElementById("setReport").scrollIntoView({ block: "center" }));
      await page.dispatchEvent("#setReport", "pointerdown");
      await page.clock.runFor(1000);
      await until(() => page.evaluate(() => !!document.getElementById("screenCheck")), "the check opens");
      await page.dispatchEvent("#setReport", "pointerup");
      const seen = await page.evaluate(() => ({ marks: [...document.querySelectorAll("#screenCheck [data-mark]")].map((m) => m.dataset.mark).join(""), text: document.querySelector("#screenCheck > div").textContent }));
      assert.equal(seen.marks, "ABCDEF");
      assert.match(seen.text, /Screen check 1 of 2/);
      assert.match(seen.text, /inner 390 x 844/);
      assert.match(seen.text, /inset top 0 · bottom 0/);
      await page.click("#screenCheck");
      assert.match(await page.evaluate(() => document.querySelector("#screenCheck > div").textContent), /Screen check 2 of 2/);
      await page.click("#screenCheck");
      assert.equal(await page.evaluate(() => !!document.getElementById("screenCheck")), false);
      assert.deepEqual(await page.evaluate(() => [document.documentElement.getAttribute("style") || "", document.body.getAttribute("style") || ""]), before);
    },
  },
  {
    name: "a short press does not open it",
    async run({ page }) {
      await open(page, { seed: SEED, nowMs: NOON12 });
      await until(() => page.evaluate(() => document.querySelectorAll("#rc .rc-row").length > 0), "the receipt draws");
      await page.click("#youBtn");
      await until(() => page.evaluate(() => document.getElementById("setReport").getBoundingClientRect().height > 0), "You is open");
      await page.dispatchEvent("#setReport", "pointerdown");
      await page.clock.runFor(300);
      await page.dispatchEvent("#setReport", "pointerup");
      await page.clock.runFor(1500);
      assert.equal(await page.evaluate(() => !!document.getElementById("screenCheck")), false);
    },
  },
];
