import test from "node:test";
import assert from "node:assert/strict";
import { minutesOf, nowIn, instantOf, openDayIndex, dayState, daysToGo, stopsFor, nextStopId, isPast, nextLine, stayFor, safeHref, originFor, mapsUrl, stayMapsUrl, inkFor, header, dayTotalYen, gateDate, issueLine } from "../js/plan.js";

const TZ = "Asia/Tokyo";
const TRIP = { start: "2026-12-10", end: "2026-12-20", tz: TZ };
const DAYS = Array.from({ length: 11 }, (_, i) => ({ date: "2026-12-" + (10 + i) }));
const at = (iso) => Date.parse(iso);
const stop = (id, time, more = {}) => ({ id, date: "2026-12-12", time, title: id, place: "", travelMin: 0, deleted: false, ...more });

test("Japan time, whatever the phone thinks", () => {
  // 13:20 on Dec 12 in Japan is 23:20 on Dec 11 in Toronto.
  assert.deepEqual(nowIn(TZ, at("2026-12-12T13:20:00+09:00")), { date: "2026-12-12", minutes: 800 });
  assert.equal(instantOf(TZ, "2026-12-12", 800), at("2026-12-12T13:20:00+09:00"));
});
test("which day opens", () => {
  assert.equal(openDayIndex(TRIP, DAYS, at("2026-11-15T12:00:00+09:00")), 0);
  assert.equal(openDayIndex(TRIP, DAYS, at("2026-12-12T13:20:00+09:00")), 2);
  assert.equal(openDayIndex(TRIP, DAYS, at("2026-12-13T00:30:00+09:00")), 3); // just past midnight
  assert.equal(openDayIndex(TRIP, DAYS, at("2026-12-25T12:00:00+09:00")), 10);
});
test("days to go", () => {
  assert.equal(daysToGo(TRIP, at("2026-11-15T12:00:00+09:00")), 25);
  assert.equal(daysToGo(TRIP, at("2026-12-09T23:59:00+09:00")), 1);
  assert.equal(daysToGo(TRIP, at("2026-12-10T00:00:00+09:00")), 0);
});
test("a day's stops: timed in order, untimed last, deleted and bad times handled", () => {
  const all = [stop("c", "19:00"), stop("x", ""), stop("a", "09:00"), stop("gone", "10:00", { deleted: true }), stop("odd", "9:5"), stop("other", "08:00", { date: "2026-12-13" })];
  assert.deepEqual(stopsFor(all, "2026-12-12").map((s) => s.id), ["a", "c", "x", "odd"]);
});
test("next and past", () => {
  const day = [stop("a", "09:00"), stop("b", "14:00"), stop("late", "23:50"), stop("x", "")];
  assert.equal(nextStopId(day, 800), "b");
  assert.equal(nextStopId(day, 23 * 60 + 40), "late");
  assert.equal(nextStopId(day, 23 * 60 + 55), null);
  assert.deepEqual(day.map((s) => isPast(s, 800)), [true, false, false, false]);
});
test("the next stop's line", () => {
  assert.equal(nextLine(stop("b", "14:00", { travelMin: 30 }), 800), "Leave by 13:30, in 10 min.");
  assert.equal(nextLine(stop("b", "14:00", { travelMin: 30 }), 815), "Leave now.");
  // Minutes from an old cache made before the backend rounded them: never a fraction.
  assert.equal(nextLine(stop("b", "14:00", { travelMin: 12.5 }), 800), "Leave by 13:47, in 27 min.");
  assert.equal(nextLine(stop("b", "14:00", { travelMin: "20" }), 800), "Leave by 13:40, in 20 min.");
  assert.equal(nextLine(stop("b", "14:00", { travelMin: -10 }), 800), "Next, in 40 min.");
  assert.equal(nextLine(stop("b", "14:00"), 800), "Next, in 40 min.");
  assert.equal(nextLine(stop("b", "15:25"), 800), "Next, in 2 h 5 min.");
  assert.equal(nextLine(stop("b", "14:20"), 800), "Next, in 1 h.");
  assert.equal(nextLine(stop("b", "13:20"), 800), "Now.");
});
test("where you sleep", () => {
  const stays = [{ id: "s1", name: "Asakusa", firstNight: "2026-12-10", lastNight: "2026-12-12", deleted: false }, { id: "s2", name: "Niseko", firstNight: "2026-12-13", lastNight: "2026-12-15", deleted: false }, { id: "s0", name: "Gone", firstNight: "2026-12-10", lastNight: "2026-12-20", deleted: true }];
  assert.equal(stayFor(stays, "2026-12-12").name, "Asakusa");
  assert.equal(stayFor(stays, "2026-12-13").name, "Niseko");
  assert.equal(stayFor(stays, "2026-12-20"), null);
});
test("directions", () => {
  const stays = [{ id: "s1", name: "Asakusa hotel", place: "Asakusa hotel Tokyo", firstNight: "2026-12-10", lastNight: "2026-12-12", deleted: false }];
  const day = [stop("Meiji Shrine", "09:00", { place: "Meiji Jingu" }), stop("Lunch", "12:30", { place: "https://maps.app.goo.gl/abc" }), stop("Sky", "14:00", { place: "Shibuya Sky" })];
  assert.equal(originFor(day, 0, stays, "2026-12-12"), "Asakusa hotel Tokyo");
  assert.equal(originFor(day, 1, stays, "2026-12-12"), "Meiji Jingu");
  assert.equal(originFor(day, 2, stays, "2026-12-12"), "Lunch"); // a link cannot be an origin
  assert.equal(originFor(day, 0, [], "2026-12-12"), "");
  assert.equal(mapsUrl(day[0], "Asakusa hotel Tokyo"), "https://www.google.com/maps/dir/?api=1&travelmode=transit&origin=Asakusa%20hotel%20Tokyo&destination=Meiji%20Jingu");
  assert.equal(mapsUrl(day[1], "Meiji Jingu"), "https://maps.app.goo.gl/abc");
  assert.equal(mapsUrl(stop("Dinner", "19:00"), ""), "https://www.google.com/maps/dir/?api=1&travelmode=transit&destination=Dinner");
  assert.equal(stayMapsUrl({ name: "Lodge", place: "", addressJp: "北海道虻田郡" }), "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("北海道虻田郡"));
});
test("links from the Sheet", () => {
  assert.equal(safeHref("https://example.test/a"), "https://example.test/a");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", " https://x.test", "https://x .test", "", null, 7]) assert.equal(safeHref(bad), "");
});
test("the header copes with a sparse or hand-edited day", () => {
  assert.deepEqual(header({ date: "2026-12-13", city: "Niseko" }), { line: null, colour: null, ink: null, route: null, city: "Niseko", title: "" });
  const full = header({ date: "2026-12-12", city: "Tokyo", title: "", lineJp: "山手線", lineEn: "Yamanote Line", lineColour: "#9ACD32", fromJp: "新宿", fromEn: "Shinjuku", toJp: "渋谷", toEn: "Shibuya" });
  assert.deepEqual([full.line.jp, full.colour, full.ink, full.route.toJp], ["山手線", "#9ACD32", "#15120F", "渋谷"]);
  assert.equal(header({ date: "2026-12-12", lineJp: "山手線", lineColour: "green" }).colour, null);
  assert.equal(header({ date: "2026-12-12", fromJp: "新宿" }).route, null);
  assert.equal(inkFor("#1A1A6E"), "#FFFFFF");
});
test("the fare and the small print", () => {
  const ex = [{ day: "2026-12-11", amount: 3000, currency: "JPY", rate: 111, deleted: false }, { day: "2026-12-11", amount: 10, currency: "CAD", rate: 111, deleted: false }, { day: "2026-12-11", amount: 999, currency: "JPY", rate: 111, deleted: true }];
  assert.equal(dayTotalYen(ex, "2026-12-11"), 4110);
  assert.equal(gateDate("2026-12-11"), "12.11");
  assert.equal(issueLine("2026-12-11", 2, "MAT"), "2026.12.11 MAT発行 00002-01");
});

test("a place from the Sheet is only a link when safeHref says so", () => {
  const evil = "javascript:alert(1)";
  const spaced = "http://x y";
  const url = mapsUrl(stop("Odd", "10:00", { place: evil }), "");
  assert.equal(url, "https://www.google.com/maps/dir/?api=1&travelmode=transit&destination=" + encodeURIComponent(evil));
  assert.equal(mapsUrl(stop("Odd", "10:00", { place: spaced }), "Here"), "https://www.google.com/maps/dir/?api=1&travelmode=transit&origin=Here&destination=" + encodeURIComponent(spaced));
  assert.equal(stayMapsUrl({ name: "Inn", place: evil }), "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(evil));
  assert.equal(stayMapsUrl({ name: "Inn", place: spaced }), "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(spaced));
  // a hand-typed place is still text as an origin
  assert.equal(originFor([stop("a", "09:00", { place: evil }), stop("b", "10:00")], 1, [], "2026-12-12"), evil);
});
test("blank or missing fields never print undefined", () => {
  assert.equal(nextLine({ id: "x", time: "" }, 800), "");
  assert.equal(nextLine({ id: "x", time: "25:00" }, 800), "");
  assert.equal(minutesOf("25:00"), null);
  assert.equal(minutesOf("14:05"), 845);
  assert.equal(minutesOf(undefined), null);
  assert.equal(mapsUrl({ id: "x" }, ""), "");
  assert.equal(stayMapsUrl({}), "");
  assert.equal(originFor([{ id: "a" }, { id: "b" }], 1, [], "2026-12-12"), "");
  assert.deepEqual(header({}), { line: null, colour: null, ink: null, route: null, city: "", title: "" });
  assert.equal(stayFor([{ id: "s", name: "No dates" }], "2026-12-12"), null);
});
test("the open day when today is inside the trip but missing from the list", () => {
  const some = [{ date: "2026-12-10" }, { date: "2026-12-14" }];
  assert.equal(openDayIndex(TRIP, some, at("2026-12-12T12:00:00+09:00")), 0);
  assert.equal(openDayIndex(TRIP, some, at("2026-12-16T12:00:00+09:00")), 1);
  assert.equal(openDayIndex(TRIP, [{ date: "2026-12-15" }], at("2026-12-12T12:00:00+09:00")), 0);
  assert.equal(dayState("2026-12-11", "2026-12-12"), "used");
  assert.equal(dayState("2026-12-12", "2026-12-12"), "today");
  assert.equal(dayState("2026-12-13", "2026-12-12"), "ahead");
});
