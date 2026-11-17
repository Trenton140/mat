import test from "node:test";
import assert from "node:assert/strict";
import { shrunkBy } from "../js/remeasure.js";

const win = (o) => ({ navigator: { standalone: o.standalone }, innerWidth: o.w, innerHeight: o.h, screen: { width: 440, height: 956 } });

test("a Home Screen app told it is shorter than the screen: short by the difference", () => {
  assert.equal(shrunkBy(win({ standalone: true, w: 440, h: 878 })), 78);
});
test("a Home Screen app at full height: not short", () => {
  assert.equal(shrunkBy(win({ standalone: true, w: 440, h: 956 })), 0);
});
test("a Safari tab: never counted as short", () => {
  assert.equal(shrunkBy(win({ standalone: false, w: 440, h: 760 })), 0);
  assert.equal(shrunkBy(win({ standalone: undefined, w: 440, h: 760 })), 0);
});
test("sideways: measured against the screen's short side", () => {
  assert.equal(shrunkBy(win({ standalone: true, w: 956, h: 400 })), 40);
});
test("a window with no screen sizes: not short", () => {
  assert.equal(shrunkBy({ navigator: { standalone: true }, innerWidth: 440, innerHeight: 800 }), 0);
});
