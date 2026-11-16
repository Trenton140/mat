// Writes backend/Money.js: js/money.js with each leading `export ` removed,
// so the backend runs the very same money maths as the phones. Run by
//
//   npm run stamp
//
// tests/backend-money.test.cjs uses generate() to fail when backend/Money.js
// no longer matches js/money.js. Apps Script has no modules: anything that
// stripping `export ` would not turn into a plain declaration is refused.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const HEADER = "// Generated from js/money.js by npm run stamp. Do not edit.";

function refuse(why) {
  throw new Error("js/money.js " + why + ": backend/Money.js can only be made from plain `export function` / `export const` declarations.");
}

export function generate(src) {
  if (/^\s*import\b/m.test(src) || /\bimport\s*\(/.test(src)) refuse("imports something");
  if (/\bexport\s+default\b/.test(src)) refuse("has a default export");
  if (/\bexport\s*[{*]/.test(src)) refuse("has an export list");
  const body = src.replace(/^export (?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm, "");
  if (/^\s*export\b/m.test(body)) refuse("has an export this script can’t turn into a plain declaration");
  return HEADER + "\n" + body;
}

function main() {
  const out = generate(readFileSync(join(ROOT, "js", "money.js"), "utf8"));
  const file = join(ROOT, "backend", "Money.js");
  let before = null;
  try {
    before = readFileSync(file, "utf8");
  } catch {
    // not made yet
  }
  if (before === out) {
    console.log("backend/Money.js already current");
    return;
  }
  writeFileSync(file, out);
  console.log("backend/Money.js written from js/money.js");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
