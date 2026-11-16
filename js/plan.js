// The day logic for the Days screen. Pure: no DOM, no storage, no clock of
// its own (callers pass the instant). Every field of a stop, stay or day may
// be missing or blank, because a person can type into the Sheet by hand.

import { dateIn } from "./time.js";
import { jpyOf } from "./money.js";

const str = (v) => (typeof v === "string" ? v.trim() : "");

// "14:05" -> 845; anything that is not HH:MM (24 h) -> null.
export function minutesOf(time) {
  const m = /^(\d{2}):(\d{2})$/.exec(typeof time === "string" ? time : "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

// The wall-clock fields of an instant in a zone.
function wall(tz, nowMs) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(nowMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour") % 24, mi: get("minute"), s: get("second") };
}

// { date, minutes }: the zone's date and minutes past midnight at this instant.
export function nowIn(tz, nowMs) {
  const w = wall(tz, nowMs);
  return { date: dateIn(tz, nowMs), minutes: w.h * 60 + w.mi };
}

// The ms instant at which the zone's wall clock reads `date` + `minutes`.
export function instantOf(tz, date, minutes) {
  const [y, mo, d] = date.split("-").map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, 0, minutes);
  const offsetAt = (ms) => {
    const w = wall(tz, ms);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
  };
  let guess = asUtc - offsetAt(asUtc);
  guess = asUtc - offsetAt(guess); // once more, in case the zone changed offset between the two
  return guess;
}

export function openDayIndex(trip, days, nowMs) {
  const last = Math.max(0, days.length - 1);
  const today = dateIn(trip.tz, nowMs);
  if (today < trip.start) return 0;
  if (today > trip.end) return last;
  const exact = days.findIndex((d) => d.date === today);
  if (exact >= 0) return exact;
  let found = 0;
  days.forEach((d, i) => { if (d.date < today) found = i; });
  return found;
}

export function dayState(date, today) {
  return date < today ? "used" : date === today ? "today" : "ahead";
}

const dayNumber = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

export function daysToGo(trip, nowMs) {
  return Math.max(0, dayNumber(trip.start) - dayNumber(dateIn(trip.tz, nowMs)));
}

export function stopsFor(stops, date) {
  const mine = stops.filter((s) => s.date === date && !s.deleted);
  const timed = mine.filter((s) => minutesOf(s.time) !== null).sort((a, b) => minutesOf(a.time) - minutesOf(b.time));
  return timed.concat(mine.filter((s) => minutesOf(s.time) === null));
}

export function nextStopId(dayStops, minutes) {
  const s = dayStops.find((x) => { const m = minutesOf(x.time); return m !== null && m >= minutes; });
  return s ? s.id : null;
}

export function isPast(stop, minutes) {
  const m = minutesOf(stop.time);
  return m !== null && m < minutes;
}

const span = (n) => {
  if (n < 60) return n + " min";
  const h = Math.floor(n / 60);
  const r = n % 60;
  return r ? h + " h " + r + " min" : h + " h";
};
const clock = (n) => String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");

export function nextLine(stop, minutes) {
  const at = minutesOf(stop.time);
  if (at === null) return "";
  // Whole minutes, even from an old cache made before the backend rounded them.
  const raw = Number(stop.travelMin);
  const travel = isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
  if (travel > 0) {
    const leave = Math.max(0, at - travel);
    return minutes >= leave ? "Leave now." : "Leave by " + clock(leave) + ", in " + span(leave - minutes) + ".";
  }
  return at - minutes <= 0 ? "Now." : "Next, in " + span(at - minutes) + ".";
}

export function stayFor(stays, date) {
  let best = null;
  for (const s of stays) {
    if (s.deleted || !s.firstNight || !s.lastNight) continue;
    if (s.firstNight <= date && date <= s.lastNight && (!best || s.firstNight < best.firstNight)) best = s;
  }
  return best;
}

export function safeHref(v) {
  return typeof v === "string" && /^https?:\/\/\S+$/i.test(v) ? v : "";
}

// A place that is text (not a link), else "".
const placeText = (v) => (safeHref(v) ? "" : str(v));

const dayBefore = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

export function originFor(dayStops, index, stays, date) {
  if (index > 0) {
    const prev = dayStops[index - 1];
    return prev ? placeText(prev.place) || str(prev.title) : "";
  }
  const stay = stayFor(stays, dayBefore(date));
  return stay ? placeText(stay.place) || str(stay.name) : "";
}

export function mapsUrl(stop, origin) {
  const link = safeHref(stop.place);
  if (link) return link;
  const dest = str(stop.place) || str(stop.title);
  if (!dest) return "";
  const from = origin ? "&origin=" + encodeURIComponent(origin) : "";
  return "https://www.google.com/maps/dir/?api=1&travelmode=transit" + from + "&destination=" + encodeURIComponent(dest);
}

export function stayMapsUrl(stay) {
  const link = safeHref(stay.place);
  if (link) return link;
  const q = str(stay.place) || str(stay.addressJp) || str(stay.name);
  return q ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q) : "";
}

export function inkFor(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const lin = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const lum = 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
  return lum > 0.4 ? "#15120F" : "#FFFFFF";
}

export function header(day) {
  const d = day || {};
  const jp = str(d.lineJp);
  const en = str(d.lineEn);
  const ink = inkFor(d.lineColour);
  const fromJp = str(d.fromJp), fromEn = str(d.fromEn), toJp = str(d.toJp), toEn = str(d.toEn);
  return {
    line: jp || en ? { jp, en } : null,
    colour: ink ? d.lineColour : null,
    ink,
    route: (fromJp || fromEn) && (toJp || toEn) ? { fromJp, fromEn, toJp, toEn } : null,
    city: str(d.city),
    title: str(d.title),
  };
}

export function dayTotalYen(expenses, date) {
  let sum = 0;
  for (const e of expenses) {
    if (e.day !== date || e.deleted) continue;
    const v = jpyOf(e);
    if (Number.isFinite(v)) sum += v;
  }
  return sum;
}

export function gateDate(date) {
  return date.slice(5).replace("-", ".");
}

export function issueLine(date, dayNumber, mark) {
  return date.replace(/-/g, ".") + " " + mark + "発行 " + String(dayNumber).padStart(5, "0") + "-01";
}
