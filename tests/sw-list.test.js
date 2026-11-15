// sw.js keeps a hand-written list of the shell files (there is no build
// step). This checks that list against the repo.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");

// The strings inside `const SHELL = [ ... ];`.
function shellList() {
  const m = SRC.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(m, "sw.js has const SHELL = [ ... ];");
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + "/" + entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(rel));
    else if (!entry.name.startsWith(".")) out.push(rel);
  }
  return out;
}

test("SW_VERSION is \"1\"", () => {
  assert.match(SRC, /^const SW_VERSION = "1";$/m);
});

test("the shell list names every file the app needs", () => {
  const list = new Set(shellList());
  const needed = [
    "./",
    "index.html",
    "manifest.webmanifest",
    ...filesUnder("css"),
    ...filesUnder("js"),
    ...fs.readdirSync(path.join(ROOT, "icons")).filter((f) => f.endsWith(".png")).map((f) => "icons/" + f),
  ];
  const missing = needed.filter((f) => !list.has(f));
  assert.deepEqual(missing, [], "missing from SHELL in sw.js");
});

test("the shell list names only files that exist, never tools, tests, backend or scripts", () => {
  const list = shellList();
  assert.equal(new Set(list).size, list.length, "no file twice");
  for (const f of list) {
    if (f === "./") continue;
    assert.ok(fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile(), f + " is in SHELL but does not exist");
    assert.equal(/^(tools|tests|backend|scripts)\//.test(f), false, f + " must not be cached");
    assert.equal(f, path.posix.normalize(f), f + " is written plainly");
  }
});

test("the worker never touches the trip backend", () => {
  assert.ok(SRC.includes('"script.google.com"') && SRC.includes('"script.googleusercontent.com"'));
  assert.match(SRC, /if \(BACKEND_HOSTS\.includes\(url\.hostname\)\) return;/);
});
