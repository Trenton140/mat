// Writes SW_VERSION in sw.js: a short hash of every file in the worker's
// shell list, so any change to the shell makes a new worker (and a new
// cache) on the phones. Run it after changing any shell file:
//
//   npm run stamp
//
// tests/sw-list.test.js uses shellList() and shellHash() to fail when the
// hash in sw.js no longer matches the files.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_LINE = /^const SW_VERSION = "([^"]*)";$/m;

export function readSw(root = ROOT) {
  return readFileSync(join(root, "sw.js"), "utf8");
}

// The strings inside `const SHELL = [ ... ];`.
export function shellList(src = readSw()) {
  const m = src.match(/const SHELL = \[([\s\S]*?)\];/);
  if (!m) throw new Error("sw.js has no const SHELL = [ ... ];");
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

// The SW_VERSION written in sw.js, or null.
export function writtenVersion(src = readSw()) {
  const m = src.match(VERSION_LINE);
  return m ? m[1] : null;
}

// Ten hex digits of sha-256 over each listed file's path and bytes, in list
// order ("./" is the front page, index.html).
export function shellHash(root = ROOT, list = shellList(readSw(root))) {
  const h = createHash("sha256");
  for (const entry of list) {
    const file = entry === "./" ? "index.html" : entry;
    h.update(entry + "\0");
    h.update(readFileSync(join(root, file)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 10);
}

function main() {
  const src = readSw();
  const before = writtenVersion(src);
  if (before === null) throw new Error('sw.js has no line const SW_VERSION = "...";');
  const version = shellHash();
  if (version === before) {
    console.log("sw.js already stamped " + version);
    return;
  }
  writeFileSync(join(ROOT, "sw.js"), src.replace(VERSION_LINE, 'const SW_VERSION = "' + version + '";'));
  console.log("sw.js stamped " + version + " (was " + before + ")");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
