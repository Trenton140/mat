import test from "node:test";
import assert from "node:assert/strict";
import { fullHeight } from "../js/fill.js";

// An iPhone 16 Pro Max is 440 x 956 points. On the Home Screen the page can be
// told it is shorter than that, which left the bottom bar floating above an
// empty band.
const PHONE = { screenW: 440, screenH: 956 };

test("Home Screen, portrait, page told it is short: the whole screen's height", () => {
  assert.equal(fullHeight({ standalone: true, innerWidth: 440, innerHeight: 874, ...PHONE }), 956);
});

test("Home Screen, landscape, page told it is short: the screen's short side", () => {
  assert.equal(fullHeight({ standalone: true, innerWidth: 956, innerHeight: 380, ...PHONE }), 440);
});

test("Home Screen, page already the full height: nothing to change", () => {
  assert.equal(fullHeight({ standalone: true, innerWidth: 440, innerHeight: 956, ...PHONE }), 0);
  assert.equal(fullHeight({ standalone: true, innerWidth: 440, innerHeight: 955.5, ...PHONE }), 0);
});

test("in Safari (not from the Home Screen): left alone, the toolbars really take that room", () => {
  assert.equal(fullHeight({ standalone: false, innerWidth: 440, innerHeight: 760, ...PHONE }), 0);
  assert.equal(fullHeight({ standalone: undefined, innerWidth: 440, innerHeight: 760, ...PHONE }), 0);
});

test("a window narrower than the screen (an iPad side by side): left alone", () => {
  assert.equal(fullHeight({ standalone: true, innerWidth: 507, innerHeight: 1000, screenW: 1024, screenH: 1366 }), 0);
});

test("screen sizes reported either way round give the same answer", () => {
  assert.equal(fullHeight({ standalone: true, innerWidth: 440, innerHeight: 874, screenW: 956, screenH: 440 }), 956);
});

test("nonsense sizes: left alone", () => {
  assert.equal(fullHeight({ standalone: true, innerWidth: 0, innerHeight: 0, screenW: 0, screenH: 0 }), 0);
  assert.equal(fullHeight({ standalone: true, innerWidth: 440, innerHeight: 874, screenW: NaN, screenH: 956 }), 0);
});
