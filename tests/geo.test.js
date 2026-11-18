import { test } from "node:test";
import assert from "node:assert/strict";
import { metres, walkMinutes, usable, distanceText, pointFromLink, linkProblem, DIRECTIONS_LINK, point, FRESH_MS } from "../js/geo.js";

const GION = { lat: 35.0037, lng: 135.7788 };
const NOW = Date.parse("2026-12-15T13:20:00+09:00");

test("metres: the haversine distance", () => {
  assert.equal(metres(GION, GION), 0);
  // One degree of latitude is about 111.2 km.
  assert.ok(Math.abs(metres({ lat: 35, lng: 135 }, { lat: 36, lng: 135 }) - 111195) < 20);
  // Kyoto Station to Gion-Shijo, about 2.4 km in a straight line.
  const d = metres({ lat: 34.9858, lng: 135.7588 }, { lat: 35.0037, lng: 135.7726 });
  assert.ok(d > 2200 && d < 2500, String(d));
  // Numbers as text, as the Sheet keeps them.
  assert.equal(metres({ lat: "35", lng: "135" }, { lat: 35, lng: 135 }), 0);
  for (const bad of [null, {}, { lat: "", lng: "" }, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: "x", lng: 1 }]) assert.ok(Number.isNaN(metres(bad, GION)), JSON.stringify(bad));
});

test("walkMinutes: 1.3 times the straight line, at 80 m a minute, rounded up", () => {
  assert.equal(walkMinutes(0), 0);
  assert.equal(walkMinutes(1000), 17); // 1300 / 80 = 16.25
  assert.equal(walkMinutes(984.6), 16); // 1280 / 80 = 16, exactly
  assert.equal(walkMinutes(1), 1);
  assert.equal(walkMinutes(3000), 49);
});

test("usable: at most 3 minutes old and 300 m or better", () => {
  const pos = { ...GION, at: NOW, accuracy: 40 };
  assert.equal(usable(pos, NOW), true);
  assert.equal(usable({ ...pos, at: NOW - FRESH_MS }, NOW), true, "exactly 3 minutes");
  assert.equal(usable({ ...pos, at: NOW - FRESH_MS - 1 }, NOW), false, "stale");
  assert.equal(usable({ ...pos, accuracy: 300 }, NOW), true);
  assert.equal(usable({ ...pos, accuracy: 301 }, NOW), false, "rough");
  assert.equal(usable({ ...pos, accuracy: NaN }, NOW), false);
  assert.equal(usable({ ...pos, at: NOW + 2 * 60000 }, NOW), false, "from the future");
  assert.equal(usable({ ...pos, at: NOW + 30000 }, NOW), true, "a clock a little ahead");
  for (const bad of [null, undefined, {}, { lat: 35, lng: 135 }, { ...pos, lat: 99 }]) assert.equal(usable(bad, NOW), false, JSON.stringify(bad));
});

test("distanceText", () => {
  assert.equal(distanceText(4), "10 m");
  assert.equal(distanceText(283), "280 m");
  assert.equal(distanceText(650), "650 m");
  assert.equal(distanceText(994), "990 m");
  assert.equal(distanceText(996), "1.0 km");
  assert.equal(distanceText(1204), "1.2 km");
  assert.equal(distanceText(2449), "2.4 km");
  assert.equal(distanceText(24400), "24 km");
  assert.equal(distanceText(NaN), "");
  assert.equal(distanceText(-1), "");
});

test("pointFromLink: the pin, else the map's centre, else nothing", () => {
  const full = "https://www.google.com/maps/place/Tenryu-ji/@35.0158,135.6721,17z/data=!3m1!4b1!4m6!3m5!1s0x6001!8m2!3d35.0156286!4d135.6737472!16s";
  assert.deepEqual(pointFromLink(full), { lat: 35.0156286, lng: 135.6737472 });
  assert.deepEqual(pointFromLink("https://www.google.com/maps/place/Kyoto+Station/@34.9858,135.7588,15z"), { lat: 34.9858, lng: 135.7588 });
  assert.deepEqual(pointFromLink("  https://www.google.com/maps/search/ramen/@-33.8688,151.2093,12z "), { lat: -33.8688, lng: 151.2093 });
  for (const none of ["https://maps.app.goo.gl/abc123", "Kyoto Station", "", null, 7, "https://www.google.com/maps/@95.1,135.1,15z"]) assert.equal(pointFromLink(none), null, String(none));
  assert.deepEqual(point({ lat: "35.1", lng: "135.2" }), { lat: 35.1, lng: 135.2 });
});

test("I3: a directions link is refused; the map's centre is read only from a place or search link", () => {
  const dir = "https://www.google.com/maps/dir/35.0036,135.7787/Kyoto+Station/@35.0,135.76,14z/data=!3m1!4b1!4m9!4m8!1m1!4e1!1m5!1m1!1s0x0:0x0!2m2!1d135.7588!2d34.9858";
  assert.equal(DIRECTIONS_LINK, "That’s a directions link. Paste the place’s own link.");
  assert.equal(linkProblem(dir), DIRECTIONS_LINK);
  assert.equal(pointFromLink(dir), null, "never read, it may say where a person was");
  assert.equal(pointFromLink("https://www.google.com/maps/dir/?api=1&destination=x!3d35.1!4d139.1"), null);
  // A bare map view's centre is where someone was looking (or standing): not read.
  assert.equal(pointFromLink("https://www.google.com/maps/@34.9858,135.7588,15z"), null);
  assert.equal(linkProblem("https://www.google.com/maps/@34.9858,135.7588,15z"), "");
  // The pin is read from any other Maps link, as before.
  assert.deepEqual(pointFromLink("https://www.google.com/maps/@1,2,3z/data=!3d35.5!4d139.5"), { lat: 35.5, lng: 139.5 });
  assert.equal(linkProblem("https://www.google.com/maps/place/x/@35,139,17z"), "");
  assert.equal(linkProblem(""), "");
});
