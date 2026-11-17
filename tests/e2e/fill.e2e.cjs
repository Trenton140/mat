// The Home Screen app fills the whole screen, so the bottom bar sits at the
// bottom (an iPhone can tell a Home Screen page it is shorter than the screen).

const assert = require("node:assert/strict");
const { SEED, NOON12, open, until } = require("./helpers.cjs");

// The page is told 874 points of a 956-point screen, as on the iPhone in Mo's screenshot.
const SHORT = { width: 440, height: 874 };
const SCREEN = { width: 440, height: 956 };

const standalone = (page) => page.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, "standalone", { get: () => true, configurable: true });
});

const box = (page) => page.evaluate(() => {
  const r = (sel) => document.querySelector(sel).getBoundingClientRect();
  return { phone: r("#phone").height, navBottom: r(".nav").bottom, docScroll: document.scrollingElement.scrollHeight };
});

module.exports = [
  {
    name: "from the Home Screen: the app runs to the bottom of the screen and the bar sits on it",
    viewport: SHORT,
    screen: SCREEN,
    async run({ page }) {
      await standalone(page);
      await open(page, { seed: SEED, nowMs: NOON12 });
      await until(async () => (await box(page)).phone === 956, "the phone is the screen's height");
      const b = await box(page);
      assert.equal(b.navBottom, 956, "the bar's bottom edge is the screen's");
      assert.ok(b.docScroll <= 874, "the taller app does not make the page itself scroll");
    },
  },
  {
    name: "from the Home Screen, sideways: the app is the screen's short side tall",
    viewport: { width: 956, height: 380 },
    screen: SCREEN,
    async run({ page }) {
      await standalone(page);
      await open(page, { seed: SEED, nowMs: NOON12 });
      await until(async () => (await box(page)).phone === 440, "the phone is the screen's short side");
    },
  },
  {
    name: "in Safari: the page keeps the height it is given",
    viewport: SHORT,
    screen: SCREEN,
    async run({ page }) {
      await open(page, { seed: SEED, nowMs: NOON12 });
      await until(async () => (await box(page)).phone === 874, "the phone is the page's height");
      assert.equal((await box(page)).navBottom, 874);
    },
  },
];
