import test from "node:test";
import assert from "node:assert/strict";
import { rng, paidStampSVG, gateStampSVG, boxSealSVG } from "../js/stamp.js";
import { remindText, sentCents, settledOf, filedText, purposeLine, voucherNo } from "../js/views/slip.js";

test("a stamp is drawn from its seed: the same seed, the same stamp", () => {
  assert.equal(paidStampSVG(42), paidStampSVG(42));
  assert.notEqual(paidStampSVG(42), paidStampSVG(43));
  assert.ok(paidStampSVG(42).includes("済"));
  assert.ok(paidStampSVG(42).startsWith("<svg"));
});

test("rng is deterministic and stays between 0 and 1", () => {
  const a = rng(7);
  const b = rng(7);
  const first = [a(), a(), a()];
  assert.deepEqual([b(), b(), b()], first);
  for (const v of first) assert.ok(v >= 0 && v < 1, String(v));
  assert.notDeepEqual([rng(8)(), rng(8)(), rng(8)()], first);
});

test("the stamp SVG is built only from numbers and constants", () => {
  // No text from outside ever reaches it, so innerHTML is safe for it.
  const svg = paidStampSVG(123456);
  assert.equal(/[<>]\s*script/i.test(svg), false);
  assert.equal(paidStampSVG("1<x>"), paidStampSVG(1), "a seed is read as a number");
});

test("the gate stamp prints its place, date and mark, the same from the same seed", () => {
  const svg = gateStampSVG(1211, "渋谷", "12.11", "MAT");
  for (const s of ["渋谷", "12.11", "MAT"]) assert.ok(svg.includes(s), s);
  assert.ok(svg.startsWith("<svg"));
  assert.equal(gateStampSVG(1211, "渋谷", "12.11", "MAT"), svg);
  assert.notEqual(gateStampSVG(1212, "渋谷", "12.11", "MAT"), svg);
});

test("the gate stamp escapes what it prints", () => {
  const svg = gateStampSVG(1, "<b>", "x", "y");
  assert.ok(svg.includes("&lt;b&gt;"));
  assert.equal(svg.includes("<b>"), false);
  const quoted = gateStampSVG(1, "a", '"&', "'");
  assert.ok(quoted.includes("&quot;&amp;") && quoted.includes("&#39;"));
});

test("the settled seal prints 精算済 and the day, from digits only", () => {
  const svg = boxSealSVG(77, "2026-12-19");
  assert.ok(svg.startsWith("<svg") && svg.includes("精算済") && svg.includes("SETTLED 2026.12.19"));
  assert.equal(boxSealSVG(77, "2026-12-19"), svg, "the same seed, the same seal");
  assert.ok(svg.includes('mask="url(#pmb77)"'), "its own mask, never the paid stamp's");
  assert.equal(paidStampSVG(77).includes("pmb77"), false);
  const odd = boxSealSVG(77, "<b>2026</b>");
  assert.equal(odd.includes("<b>"), false);
  assert.ok(odd.includes(">SETTLED</text>"));
});

test("a slip is settled when nothing is open and something was stamped", () => {
  const st = (id, cad, at, o = {}) => ({ id, from: "Ajen", to: "Mo", cad, stampedAt: at, ...o });
  assert.equal(settledOf([{ from: "Ajen", to: "Mo", cents: 100 }], [st("a", 5, "2026-12-19T12:00:00Z")]), null, "something open");
  assert.equal(settledOf([], []), null, "nobody ever owed anybody");
  const s = settledOf([], [st("b", 250, "2026-12-19T12:00:00Z", { seed: 31 }), st("a", 250.5, "2026-12-14T12:00:00Z")]);
  assert.deepEqual(s, { count: 2, cents: 50050, day: "2026-12-19", seed: 31 });
  assert.deepEqual(filedText(s), { head: "Settled Sat Dec 19", sub: "2 payments, $500.50 in all" });
  assert.equal(filedText({ count: 1, cents: 7200, day: "2026-12-14" }).sub, "1 payment, $72.00 in all");
});

test("Remind says who, how much and where to send it", () => {
  const people = [{ name: "Mo", etransfer: "mo@example.com" }];
  assert.equal(
    remindText("Mo", { from: "Ajen", to: "Mo", cents: 25030 }, people),
    "Ajen, you owe me $250.30 for the Japan trip. e-Transfer: mo@example.com",
  );
  assert.equal(remindText("Mo", { from: "Ajen", to: "Mo", cents: 25030 }, [{ name: "Mo", etransfer: "" }]), "Ajen, you owe me $250.30 for the Japan trip.");
  assert.equal(remindText("Mo", { from: "Ajen", to: "Mo", cents: 25030 }, []), "Ajen, you owe me $250.30 for the Japan trip.");
});

test("what was sent is read as dollars and cents, on the string", () => {
  assert.equal(sentCents("250"), 25000);
  assert.equal(sentCents("250.3"), 25030);
  assert.equal(sentCents("250.30"), 25030);
  assert.equal(sentCents(" 0.29 "), 29);
  assert.equal(sentCents("100000"), 10000000);
  assert.equal(sentCents("1121.35"), 112135);
  // A decimal comma (some iPhone keypads) and a leading dot.
  assert.equal(sentCents("250,30"), 25030);
  assert.equal(sentCents("250,3"), 25030);
  assert.equal(sentCents(".5"), 50);
  assert.equal(sentCents(",05"), 5);
  for (const bad of ["", ".", ",", "0", "0.00", ",00", "-5", "100000.01", "250.301", "250,301", "2,500", "1,2,3", "1.2,3", "$250", "abc", "1e3", "5.", "5,", "12 3", "Infinity"]) {
    assert.equal(sentCents(bad), null, JSON.stringify(bad));
  }
});

test("the routing sentence says who is paid through whom, from the viewer's side", async () => {
  const { routeSentence } = await import("../js/views/working.js");
  const row = { from: "Mo", to: "Trenton", cents: 1000 };
  assert.equal(routeSentence(row, "Ajen", "Mo"), "You pay Trenton because you owe Ajen and Ajen owes Trenton. Fewer payments, same totals.");
  assert.equal(routeSentence(row, "Ajen", "Trenton"), "Mo pays you because Mo owes Ajen and Ajen owes you. Fewer payments, same totals.");
  assert.equal(routeSentence(row, "Ajen", "Ajen"), "Mo pays Trenton because Mo owes you and you owe Trenton. Fewer payments, same totals.");
  assert.equal(routeSentence(row, "others", "Mo"), "You pay Trenton to cover what the others owe. Fewer payments, same totals.");
});

test("the working: paid, share, sent, and received only when not zero", async () => {
  const { workingLines } = await import("../js/views/working.js");
  const w = { paid: 0, share: 1000, sent: 0, received: 0 };
  assert.deepEqual(workingLines("Mo", w, "Mo").map((l) => l.label), ["You paid", "Your share came to", "Already sent"]);
  const other = workingLines("Ajen", { ...w, received: 400 }, "Mo");
  assert.deepEqual(other.map((l) => [l.label, l.cents]), [["Ajen paid", 0], ["Ajen’s share came to", 1000], ["Already sent", 0], ["Already received", 400]]);
  assert.equal(other[0].paid, true);
});

test("the voucher's 但 line: the trip, its dates and year, and how many people", () => {
  const P3 = [{ name: "Mo" }, { name: "Ajen" }, { name: "Trenton" }];
  assert.equal(purposeLine({ name: "Japan", start: "2026-12-10", end: "2026-12-20" }, P3), "Japan, Dec 10 to 20, 2026. Three people.");
  assert.equal(purposeLine({ name: "Japan 2026", start: "2026-12-10", end: "2026-12-20" }, P3), "Japan 2026, Dec 10 to 20. Three people.", "the year once");
  assert.equal(purposeLine({ name: "", start: "2026-12-30", end: "2027-01-02" }, P3.slice(0, 1)), "Dec 30 to Jan 2, 2027. One person.");
  assert.equal(purposeLine({ name: "<b>x</b>", start: "2026-12-10", end: "2026-12-20" }, Array(12).fill({ name: "a" })), "<b>x</b>, Dec 10 to 20, 2026. 12 people.", "plain text, set with textContent");
});

test("the voucher's number counts the stamped payments, this one included", () => {
  assert.equal(voucherNo(0), "No.0001");
  assert.equal(voucherNo(6), "No.0007");
});
