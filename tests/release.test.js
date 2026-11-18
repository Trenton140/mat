// The release rules (scripts/release-lib.mjs, scripts/scan.mjs): what may be
// pushed, when a version number is owed, what counts as private, and that the
// backend stamp matches the backend files.
import test from "node:test";
import assert from "node:assert/strict";
import { backendFiles, backendHash, config, judgePush, needsBump, stampIn, writtenBackendStamp } from "../scripts/release-lib.mjs";
import { findings } from "../scripts/scan.mjs";

const ok = { unit: { pass: 10, fail: 0 }, e2e: { pass: 5, fail: 0 } };
const push = (over) => judgePush({ remoteRef: "refs/heads/main", localSha: "a".repeat(40), receipt: ok, commitStamp: "abc", live: "abc", ...over });

test("backend/Stamp.js matches the backend files (run npm run stamp)", () => {
  assert.equal(writtenBackendStamp(), backendHash());
  assert.ok(!backendFiles().includes("Stamp.js"));
  assert.ok(backendFiles().includes("appsscript.json"));
});

test("a push goes out only as main, with a receipt, behind its own backend", () => {
  assert.equal(push({}), null);
  assert.match(push({ remoteRef: "refs/original/refs/heads/main" }), /refs\/original/);
  assert.match(push({ remoteRef: "refs/heads/ticks-build" }), /Only main and dev/);
  // dev (reviewed work waiting for a release) goes out under the same checks.
  assert.equal(push({ remoteRef: "refs/heads/dev" }), null);
  assert.match(push({ remoteRef: "refs/heads/dev", receipt: null }), /npm run gate/);
  assert.match(push({ remoteRef: "refs/heads/dev", localSha: "0".repeat(40) }), /never deleted/);
  assert.match(push({ localSha: "0".repeat(40) }), /never deleted/);
  assert.match(push({ receipt: null }), /npm run gate/);
  assert.match(push({ receipt: { unit: { pass: 9, fail: 1 }, e2e: { pass: 5, fail: 0 } } }), /failing tests/);
  assert.match(push({ receipt: { unit: { pass: 9, fail: 0 }, e2e: { pass: 5, fail: 2 } } }), /failing tests/);
  assert.match(push({ live: "old" }), /backend goes first/);
  assert.match(push({ live: "" }), /backend goes first/);
  // ci/<name> only tries the checks on GitHub: no receipt, but the scan must be clean on exactly that commit.
  const ci = (over) => judgePush({ remoteRef: "refs/heads/ci/browser-tests", localSha: "a".repeat(40), ci: { atHead: true, clean: true, found: 0, ...over } });
  assert.equal(ci({}), null);
  assert.match(ci({ found: 2 }), /private-data scan found 2/);
  assert.match(ci({ clean: false }), /clean checkout/);
  assert.match(ci({ atHead: false }), /clean checkout/);
  assert.match(judgePush({ remoteRef: "refs/heads/ci/x", localSha: "a".repeat(40) }), /clean checkout/);
  assert.match(push({ remoteRef: "refs/heads/ci/a/b" }), /Only main and dev/);
  assert.match(push({ remoteRef: "refs/heads/cicada" }), /Only main and dev/);
  // A commit from before the stamp existed has nothing to compare.
  assert.equal(push({ commitStamp: "", live: "" }), null);
});

test("a change to what the phones run owes a new version number", () => {
  const shell = ["./", "index.html", "js/app.js", "css/base.css"];
  assert.equal(needsBump(["js/app.js"], shell), true);
  assert.equal(needsBump(["index.html"], shell), true);
  assert.equal(needsBump(["sw.js"], shell), true);
  assert.equal(needsBump(["backend/Actions.js", "tests/store.test.js", "README.md", "scripts/ship.mjs"], shell), false);
  assert.equal(needsBump([], shell), false);
});

test("config and the stamp line are read as written", () => {
  const id = "AKfy" + "TESTtest_test-testTEST123"; // in two pieces: the scan refuses a whole one
  const c = config('export const API_URL = "https://script.google.com/macros/s/' + id + '/exec";\nexport const APP_VERSION = "23";\n');
  assert.equal(c.deployId, id);
  assert.equal(c.appVersion, "23");
  assert.equal(stampIn('// note\nvar BACKEND_STAMP = "0123456789";\n'), "0123456789");
  assert.equal(stampIn(""), "");
});

test("the scan finds what must not be public and leaves examples alone", () => {
  const rules = (text, opts) => findings(text, opts).map((f) => f.rule);
  assert.deepEqual(rules("mail mo@example.com, t@example.test, x@sub.example.org"), []);
  assert.deepEqual(rules('"playwright-core@1.48.0" and icon@2x.png and @google/clasp'), []);
  assert.equal(rules("write to someone" + "@" + "gmail.com").length, 1);
  const real = "AKfy" + "c".repeat(40);
  assert.deepEqual(rules("url " + real, { deployId: real }), []);
  assert.equal(rules("url " + real, { deployId: "AKfy" + "d".repeat(40) }).length, 1);
  assert.equal(rules("sheet 1" + "Ab_-9".repeat(8) + "xyz").length, 1);
  assert.equal(rules("a 0f1e2d3c4b5a69788796a5b4c3d2e1f0 hash").length, 0);
  assert.equal(rules("We stay at the Grand Snow Lodge", { words: ["grand snow lodge"] }).length, 1);
  assert.equal(findings("one\ntwo Secret Place\n", { words: ["secret place"] })[0].line, 2);
  // A finding never carries the text it matched.
  assert.deepEqual(Object.keys(findings("x " + "y@" + "real.org")[0]).sort(), ["line", "rule"]);
});
