import test from "node:test";
import assert from "node:assert/strict";
import { FITS, fullSide, loadFit, saveFit } from "../js/fit.js";

const mem = (o = {}) => { const m = new Map(Object.entries(o)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };

test("fullSide: the screen's long side upright, its short side sideways, whichever way the sizes are reported", () => {
  assert.equal(fullSide({ screen: { width: 440, height: 956 }, innerWidth: 440, innerHeight: 878 }), 956);
  assert.equal(fullSide({ screen: { width: 440, height: 956 }, innerWidth: 956, innerHeight: 380 }), 440);
  assert.equal(fullSide({ screen: { width: 956, height: 440 }, innerWidth: 440, innerHeight: 878 }), 956);
  assert.equal(fullSide({ innerWidth: 440, innerHeight: 878 }), 0);
  assert.equal(fullSide({ screen: { width: 0, height: 0 }, innerWidth: 1, innerHeight: 1 }), 0);
});

test("the ways offered: as it is, then A to D", () => {
  assert.deepEqual(FITS.map(([m]) => m), ["", "a", "b", "c", "d"]);
});

test("loadFit and saveFit: only a known way is kept; storage that throws is the same as none", () => {
  const s = mem();
  assert.equal(loadFit(s), "");
  saveFit(s, "b");
  assert.equal(loadFit(s), "b");
  saveFit(s, "zz");
  assert.equal(loadFit(s), "");
  assert.equal(loadFit(mem({ "mat.fit2": "<script>" })), "");
  const bad = { getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); } };
  assert.equal(loadFit(bad), "");
  saveFit(bad, "a");
});

test("a way picked during the trial (kept under the old name) is not read", () => {
  assert.equal(loadFit(mem({ "mat.fit": "d" })), "");
});
