import test from "node:test";
import assert from "node:assert/strict";
import { reportText } from "../js/views/you.js";
import { freshText, historySentence, localDay } from "../js/format.js";

const base = { me: "Ajen", screen: "Money", version: "7", when: "Sat Dec 12, 13:20" };

test("reportText names who, which screen, the version, the time and the newest history sentences", () => {
  const sentences = ["Mo rang up Ramen ¥1,200", "Ajen deleted Taxi ¥3,000"];
  const t = reportText({ ...base, sentences });
  assert.deepEqual(t.split("\n"), [
    "MAT: a problem to look at",
    "Who: Ajen",
    "Screen: Money",
    "App version: 7",
    "Time: Sat Dec 12, 13:20",
    "Latest changes, newest first:",
    "- Mo rang up Ramen ¥1,200",
    "- Ajen deleted Taxi ¥3,000",
    "What went wrong: ",
  ]);
});

test("reportText keeps only the five newest sentences", () => {
  const sentences = Array.from({ length: 8 }, (_, i) => "change " + i);
  const lines = reportText({ ...base, sentences }).split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(lines, ["- change 0", "- change 1", "- change 2", "- change 3", "- change 4"]);
});

test("reportText says history unavailable with no signal, and none yet for an empty tape", () => {
  assert.match(reportText({ ...base, sentences: null }), /^Latest changes: history unavailable$/m);
  assert.match(reportText({ ...base, sentences: [] }), /^Latest changes: none yet$/m);
  assert.match(reportText({ ...base, me: null, sentences: [] }), /^Who: nobody chosen$/m);
});

test("freshText and historySentence", () => {
  assert.equal(freshText(Date.parse("2026-12-12T13:20:00")), "Up to date 13:20");
  assert.equal(historySentence({ who: "Ajen", summary: "rang up Tempura ¥101", via: "app" }), "Ajen rang up Tempura ¥101");
  assert.equal(historySentence({ who: "Ajen", summary: "renamed A to B", via: "claude" }), "Ajen renamed A to B (through Claude)");
});

test("localDay is the phone's own day, and empty for no time", () => {
  assert.equal(localDay(Date.parse("2026-12-12T13:20:00")), "2026-12-12");
  assert.equal(localDay(NaN), "");
});
