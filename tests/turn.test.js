import test from "node:test";
import assert from "node:assert/strict";
import { paidMost, shareCard, lineNames, reasonText, GAP_CENTS } from "../js/turn.js";
import { balances } from "../js/money.js";
import { dollars } from "../js/format.js";

const P = ["Mo", "Ajen", "Trenton"];
const E = (o) => ({ id: "e", day: "pre", title: "x", currency: "CAD", rate: 111, split: P, deleted: false, ...o });
const pay = (from, to, cad, removed = false) => ({ id: "p", from, to, cad, removed });

test("no lines yet: hidden, even with payments", () => {
  assert.equal(paidMost(P, [], []), null);
  assert.equal(paidMost(P, [E({ amount: 900, paidBy: "Mo", deleted: true })], [pay("Ajen", "Mo", 50)]), null);
});

test("names whoever is furthest ahead of their share, same figure as balances()", () => {
  const ex = [E({ amount: 300, paidBy: "Mo" }), E({ amount: 60, paidBy: "Ajen" })];
  const r = paidMost(P, ex, []);
  assert.deepEqual(r.names, ["Mo"]);
  assert.deepEqual(r.rows.map((x) => x.name), ["Mo", "Ajen", "Trenton"]);
  const bal = balances(P, ex, []);
  for (const row of r.rows) assert.equal(row.ahead, bal[row.name]);
  assert.deepEqual(r.rows[0], { name: "Mo", paid: 30000, share: 12000, sent: 0, received: 0, put: 30000, ahead: 18000, sentTo: [], backFrom: [] });
});

test("exactly $40.00 from even is within: hidden; one cent more shows", () => {
  // Mo pays $120 for all three: Mo +$80, the others -$40 each.
  assert.equal(GAP_CENTS, 4000);
  // Mo +$40.00, Ajen -$40.00, Trenton even.
  const at = [E({ amount: 80, paidBy: "Mo", split: ["Mo", "Ajen"] })];
  assert.equal(paidMost(P, at, []), null);
  const over = [E({ amount: 80.02, paidBy: "Mo", split: ["Mo", "Ajen"] })];
  assert.deepEqual(paidMost(P, over, []).names, ["Mo"]);
});

test("someone behind by more than $40 shows the line even when nobody is that far ahead", () => {
  // Ajen -$59.99, Mo +$30.00, Trenton +$29.99.
  const ex = [E({ amount: 30, paidBy: "Mo", split: ["Ajen"] }), E({ amount: 29.99, paidBy: "Trenton", split: ["Ajen"] })];
  const r = paidMost(P, ex, []);
  assert.ok(r);
  assert.deepEqual(r.names, ["Mo"]);
});

test("a tie names both, in the trip's order", () => {
  const ex = [E({ amount: 60, paidBy: "Trenton", split: ["Ajen"] }), E({ amount: 60, paidBy: "Mo", split: ["Ajen"] })];
  const r = paidMost(P, ex, []);
  assert.deepEqual(r.names, ["Mo", "Trenton"]);
  assert.deepEqual(r.rows.map((x) => x.name), ["Mo", "Trenton", "Ajen"]);
});

test("one person: always even, so hidden", () => {
  assert.equal(paidMost(["Mo"], [E({ amount: 500, paidBy: "Mo", split: ["Mo"] })], []), null);
});

test("payments between people count: sent adds, received takes away", () => {
  const ex = [E({ amount: 300, paidBy: "Mo" })]; // Mo +200, Ajen -100, Trenton -100
  const r = paidMost(P, ex, [pay("Ajen", "Mo", 100), pay("Trenton", "Mo", 50), pay("Trenton", "Mo", 999, true)]);
  const by = Object.fromEntries(r.rows.map((x) => [x.name, x]));
  assert.equal(by.Mo.put, 30000 - 15000);
  assert.equal(by.Mo.ahead, 5000);
  assert.equal(by.Ajen.ahead, 0);
  assert.equal(by.Trenton.ahead, -5000);
  assert.deepEqual(by.Mo.backFrom, ["Ajen", "Trenton"]);
  // Everyone now within $40.00 of even: hidden.
  assert.equal(paidMost(P, ex, [pay("Ajen", "Mo", 100), pay("Trenton", "Mo", 60)]), null);
  // Payments alone can make someone the one furthest ahead.
  const r2 = paidMost(P, [E({ amount: 30, paidBy: "Mo" })], [pay("Trenton", "Ajen", 100)]);
  assert.deepEqual(r2.names, ["Trenton"]);
  assert.deepEqual(r2.rows[0].sentTo, ["Ajen"]);
  assert.deepEqual(r2.rows.find((x) => x.name === "Ajen").backFrom, ["Trenton"]);
});

test("the line says you for the viewer", () => {
  const r = { names: ["Mo", "Trenton"], rows: [] };
  assert.deepEqual(lineNames(r, "Mo"), ["you", "Trenton"]);
  assert.deepEqual(lineNames(null, "Mo"), []);
});

test("the reasoning's words", () => {
  const row = (o) => ({ name: "Ajen", paid: 21200, share: 64000, sent: 0, received: 0, put: 21200, ahead: 0, sentTo: [], backFrom: [], ...o });
  assert.deepEqual(reasonText(row(), "Mo", true, dollars), { head: "Ajen has paid $212.00 of a $640.00 share", sub: "" });
  assert.deepEqual(reasonText(row({ name: "Mo" }), "Mo", true, dollars), { head: "You have paid $212.00 of a $640.00 share", sub: "" });
  assert.deepEqual(
    reasonText(row({ name: "Trenton", paid: 56800, sent: 7200, put: 64000, sentTo: ["Mo"] }), "Mo", false, dollars),
    { head: "Trenton: $640.00 of $640.00", sub: "$568.00 for the group, $72.00 sent to you" },
  );
  assert.deepEqual(
    reasonText(row({ name: "Mo", paid: 114000, received: 7200, put: 106800, backFrom: ["Trenton"] }), "Mo", false, dollars),
    { head: "You: $1,068.00 of $640.00", sub: "$1,140.00 for the group, $72.00 back from Trenton" },
  );
  assert.equal(reasonText(row({ sent: 500, sentTo: ["Mo", "Trenton"] }), "Mo", false, dollars).sub, "$212.00 for the group, $5.00 sent");
});

test("the share card: tenths of a share, a half box, and +n past ten", () => {
  assert.deepEqual(shareCard(21200, 64000), { full: 3, half: 1, more: 0 });
  assert.deepEqual(shareCard(64000, 64000), { full: 10, half: 0, more: 0 });
  assert.deepEqual(shareCard(106800, 64000), { full: 10, half: 0, more: 7 });
  assert.deepEqual(shareCard(-500, 64000), { full: 0, half: 0, more: 0 });
  assert.equal(shareCard(100, 0), null);
});
