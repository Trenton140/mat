// Draws the home-screen icons: the app's own vermilion 済 stamp
// (paidStampSVG from js/stamp.js) centred on the dark ground #1A1614, and
// writes icons/icon-180.png (iOS, no transparency) and icons/icon-512.png
// (the stamp kept inside the middle 80%, so it is safe as a maskable icon).
//
// Run once with: node scripts/make-icons.cjs   (needs local Chrome)
// The seal face is Zen Antique when Google Fonts can be reached, else the
// system's Japanese serif (Hiragino Mincho ProN); it prints which it used.

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright-core");

const ROOT = path.join(__dirname, "..");
const GROUND = "#1A1614";
const SEED = 7; // a stamp whose wear reads well at icon size
const ROT = -8; // degrees, as a stamp lands
// size -> how wide the stamp is, as a share of the icon
const ICONS = [
  { size: 180, file: "icon-180.png", stamp: 0.8 },
  { size: 512, file: "icon-512.png", stamp: 0.7 },
];

function page(svg, size, share, withFont) {
  const font = withFont
    ? '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Antique&text=%E6%B8%88&display=block">'
    : "";
  const box = Math.round(size * share);
  return `<!doctype html><html><head><meta charset="utf-8">${font}<style>
html,body{margin:0;width:${size}px;height:${size}px;background:${GROUND};overflow:hidden}
body{display:grid;place-items:center}
.s{width:${box}px;height:${box}px;transform:rotate(${ROT}deg)}
</style></head><body><div class="s">${svg}</div></body></html>`;
}

async function main() {
  const { paidStampSVG } = await import(pathToFileURL(path.join(ROOT, "js", "stamp.js")).href);
  const svg = paidStampSVG(SEED);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    fs.mkdirSync(path.join(ROOT, "icons"), { recursive: true });
    let face = null;
    for (const icon of ICONS) {
      const ctx = await browser.newContext({ viewport: { width: icon.size, height: icon.size }, deviceScaleFactor: 1 });
      const p = await ctx.newPage();
      let zen = false;
      try {
        await p.setContent(page(svg, icon.size, icon.stamp, true), { waitUntil: "load", timeout: 15000 });
        zen = await p.evaluate(async () => {
          await document.fonts.load('58px "Zen Antique"', "済");
          await document.fonts.ready;
          // check() is also true when no face matches at all, so look for the face itself.
          return [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Zen Antique" && f.status === "loaded");
        });
      } catch {
        zen = false;
      }
      if (!zen) await p.setContent(page(svg, icon.size, icon.stamp, false), { waitUntil: "load" });
      face = zen ? "Zen Antique" : "Hiragino Mincho ProN (system serif; Zen Antique could not be loaded)";
      await p.screenshot({ path: path.join(ROOT, "icons", icon.file), omitBackground: false });
      await ctx.close();
      console.log("wrote icons/" + icon.file);
    }
    console.log("seal face: " + face);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
