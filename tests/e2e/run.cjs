// Runs the click-through tests: every tests/e2e/*.e2e.cjs, or only those
// whose file name contains one of the words given (npm run e2e -- receipt).
//
// An e2e file exports an array of cases, { name, run(ctx), timezoneId?, serviceWorkers? }
// (timezoneId: open the case's pages in that zone instead of Asia/Tokyo;
// serviceWorkers: "allow" lets the app's service worker register, which every
// other case blocks), or one async
// function (a single case named after the file). ctx = { page, context,
// browser, newPhone() }; newPhone() opens a second page in a context of its
// own (another phone: its own storage), watched the same way.
//
// Each case gets a fresh browser context: 390x844, mobile, touch, Japan time,
// clipboard allowed, service workers blocked unless the case allows them. Every request to a host other than localhost is answered
// here (Google Fonts get an empty stylesheet), so nothing needs the network.
// That holds for a case that allows the service worker too: this Playwright
// routes a service worker's own requests through context.route as well.
// A case fails on a thrown error, a console error or an uncaught page error;
// a failure prints its message and saves a screenshot.

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright-core");

const ROOT = path.join(__dirname, "..", "..");
const SHOTS = "/private/tmp/claude-501/mat-shots/failures";
const CASE_TIMEOUT_MS = 30000;

// What is on port 4173: null (nothing), or the body of its front page.
function frontPage() {
  return new Promise((resolve) => {
    const req = http.get("http://localhost:4173/", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.on("error", () => resolve(null));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(null);
    });
  });
}
const isThisApp = (body) => typeof body === "string" && body.includes("<title>MAT</title>");

async function startServer() {
  const already = await frontPage();
  if (already !== null) {
    // One is already running (npm run serve): use it only if it is this app.
    if (isThisApp(already)) return null;
    throw new Error("Port 4173 is taken by something that is not this app. Stop it and run the tests again.");
  }
  const child = spawn(process.execPath, [path.join(ROOT, "scripts", "serve.mjs")], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    if (isThisApp(await frontPage())) return child;
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error("The test server did not start on port 4173.");
}

const CONTEXT = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  timezoneId: "Asia/Tokyo",
  permissions: ["clipboard-read", "clipboard-write"],
  serviceWorkers: "block",
};

async function hermetic(context) {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost") return route.continue();
    if (url.hostname === "fonts.googleapis.com") return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    return route.fulfill({ status: 200, body: "" });
  });
}

function watch(page, problems) {
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push("console error: " + msg.text());
  });
  page.on("pageerror", (err) => problems.push("page error: " + err.message));
}

function casesOf(file) {
  const mod = require(file);
  const base = path.basename(file, ".e2e.cjs");
  if (typeof mod === "function") return [{ name: base, run: mod }];
  if (Array.isArray(mod)) return mod;
  throw new Error(base + ": export an array of { name, run } or one async function");
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error("timed out after " + ms + " ms")), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

async function runCase(browser, fileBase, c) {
  const problems = [];
  const contexts = [];
  const pages = [];
  const newPage = async () => {
    const context = await browser.newContext({
      ...CONTEXT,
      timezoneId: c.timezoneId || CONTEXT.timezoneId,
      serviceWorkers: c.serviceWorkers || CONTEXT.serviceWorkers,
    });
    contexts.push(context);
    await hermetic(context);
    const page = await context.newPage();
    watch(page, problems);
    pages.push(page);
    return { context, page };
  };
  const first = await newPage();
  const ctx = {
    browser,
    context: first.context,
    page: first.page,
    newPhone: async () => (await newPage()).page,
  };
  let error = null;
  try {
    await withTimeout(c.run(ctx), CASE_TIMEOUT_MS);
    if (problems.length) error = new Error(problems.join("\n      "));
  } catch (e) {
    error = e;
    if (problems.length) error.message += "\n      " + problems.join("\n      ");
  }
  let shot = null;
  if (error) {
    try {
      fs.mkdirSync(SHOTS, { recursive: true });
      shot = path.join(SHOTS, (fileBase + "-" + c.name).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) + ".png");
      await first.page.screenshot({ path: shot });
    } catch {
      shot = null;
    }
  }
  for (const context of contexts) await context.close().catch(() => {});
  return { error, shot };
}

async function main() {
  const words = process.argv.slice(2);
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".e2e.cjs"))
    .filter((f) => !words.length || words.some((w) => f.includes(w)))
    .sort()
    .map((f) => path.join(__dirname, f));
  if (!files.length) {
    console.log("No e2e files match " + JSON.stringify(words.join(" ")));
    process.exitCode = 1;
    return;
  }

  const server = await startServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  let passed = 0;
  let failed = 0;
  try {
    for (const file of files) {
      const base = path.basename(file, ".e2e.cjs");
      for (const c of casesOf(file)) {
        const { error, shot } = await runCase(browser, base, c);
        if (error) {
          failed++;
          console.log("FAIL " + base + " > " + c.name);
          console.log("      " + error.message);
          if (shot) console.log("      screenshot: " + shot);
        } else {
          passed++;
          console.log("ok   " + base + " > " + c.name);
        }
      }
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  console.log(passed + " passed, " + failed + " failed");
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
