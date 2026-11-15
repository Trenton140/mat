import test from "node:test";
import assert from "node:assert/strict";
import { createClock } from "../js/clock.js";
import { nowIn } from "../js/plan.js";

test("the demo clock starts at 07:00 on the chosen day, runs fast and holds at 23:30", () => {
  let real = 1000;
  const told = [];
  const clock = createClock({ now: () => real, getTz: () => "Asia/Tokyo" });
  clock.subscribe(() => told.push(clock.demoDay()));
  assert.equal(clock.now(), 1000);
  clock.start("2026-12-12");
  assert.deepEqual(nowIn("Asia/Tokyo", clock.now()), { date: "2026-12-12", minutes: 420 });
  real += 30000; // 30 real seconds is one trip hour
  assert.equal(nowIn("Asia/Tokyo", clock.now()).minutes, 480);
  real += 3600000;
  assert.deepEqual(nowIn("Asia/Tokyo", clock.now()), { date: "2026-12-12", minutes: 23 * 60 + 30 });
  clock.stop();
  assert.equal(clock.now(), real);
  assert.deepEqual(told, ["2026-12-12", null]);
});
