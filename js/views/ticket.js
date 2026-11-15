// One day as a railway ticket: the line's band with the day number, the route
// in large type, the date, a perforation, the day's stops as printed rows and
// a fine-print footer. Ported from the mockup's ticket(), built node by node:
// every name, title and note from the Sheet goes in with textContent, and a
// link or photo from the Sheet becomes an href or src only through safeHref.
//
// ticketEl(model) -> HTMLElement (an <article class="tk">), where
// model = { day, number, count, state, header, stops, stays, total, mark,
//           stay, nextId, minutes, toGo, tripName }
// - day: the Days row ({ date, city, title, ... }); header: header(day) from
//   js/plan.js; stops: stopsFor(...) for the day, in order; stays: every stay
//   (the first stop's directions start from the night before's); number:
//   1-based; mark: the issuer's mark ("MAT"); tripName: printed when the day
//   has no route and no city.
// - state: dayState(...) ("used", "today", "ahead"); minutes: the trip zone's
//   minutes past midnight; nextId: today's next stop (nextStopId), else null;
//   total: the day's logged yen (dayTotalYen), printed as the fare when above
//   zero; toGo: days until the trip starts (daysToGo), counted down on Day 1.
// - stay: tonight's stay, drawn elsewhere.
// Every row is drawn closed: the Days view opens one (.is-open on the .r, and
// aria-expanded on its [role=button], and un-inerts its .r-more).
// A used day's gate stamp is made once per day, place and mark, and reused.

import { minutesOf, issueLine, isPast, nextLine, originFor, mapsUrl, safeHref, gateDate } from "../plan.js";
import { dayHead, yen } from "../format.js";
import { rng, gateStampSVG } from "../stamp.js";

const SVG = "http://www.w3.org/2000/svg";

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const str = (v) => (typeof v === "string" ? v.trim() : "");

// The large type shrinks with the name's length, as the mockup's fsFor does.
// A Latin letter is about half as wide as a Japanese character, so it counts
// as a little over half of one. `wide`: the name has the ticket's whole width
// to itself (no arrow, no second station), so it may be twice as long.
export function fsFor(name, wide = false) {
  let n = 0;
  for (const c of name) n += c.codePointAt(0) < 0x2e80 ? 0.55 : 1;
  if (wide) n /= 2;
  return n <= 2 ? 46 : n <= 3 ? 38 : n <= 4 ? 31 : n <= 5 ? 26 : 22;
}

// A station: its name large (Japanese when there is one), English under it.
function station(jp, en, cls, wide = false) {
  const s = el("div", cls);
  const big = jp || en;
  const b = el("b", "", big);
  b.style.fontSize = fsFor(big, wide) + "px";
  s.append(b);
  if (jp && en) s.append(el("span", "", en));
  return s;
}

function arrow() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "arr");
  svg.setAttribute("viewBox", "0 0 48 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "M0 8h30V0l18 12-18 12v-8H0z");
  svg.append(path);
  return svg;
}

function band(h, number) {
  const b = el("div", "tk-band");
  if (h.line) {
    const name = el("span", "", h.line.jp || h.line.en);
    if (h.line.jp && h.line.en) name.append(el("i", "", h.line.en));
    b.append(name);
  } else if (h.city) {
    b.append(el("span", "", h.city));
  }
  const num = el("span", "num");
  num.append(el("small", "", "D"), " " + String(number).padStart(2, "0"));
  b.append(num);
  return b;
}

function route(h, tripName) {
  const r = el("div", "tk-route");
  if (h.route) {
    const { fromJp, fromEn, toJp, toEn } = h.route;
    r.append(station(fromJp, fromEn, "stn"), arrow(), station(toJp, toEn, "stn to"));
    return r;
  }
  // No route: the city alone, or the trip's name, across the whole ticket.
  r.classList.add("is-one");
  const name = h.city || str(tripName);
  if (name) r.append(station("", name, "stn", true));
  return r;
}

// The time column: the time ("—" without a valid one), and 指定 under it
// for a time that cannot slip.
function timeCell(stop) {
  const c = el("div", "r-c");
  c.append(el("div", "r-t", minutesOf(stop.time) === null ? "—" : stop.time));
  if (stop.fixed === true) {
    const fx = el("div", "r-fx");
    fx.append(el("b", "", "指定"), el("i", "", "Fixed time"));
    c.append(fx);
  }
  return c;
}

// What shows when the stop is open: the photo, how to get there, the note,
// and the buttons (directions, and the stop's own link).
function more(stop, origin) {
  const wrap = el("div", "r-more");
  wrap.inert = true;
  const inner = el("div");
  const photo = safeHref(stop.photo);
  if (photo) {
    const img = el("img", "r-ph");
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => img.remove(), { once: true });
    img.src = photo;
    inner.append(img);
  }
  const go = str(stop.gettingThere);
  if (go) inner.append(el("div", "r-go", go));
  const note = str(stop.note);
  if (note) inner.append(el("div", "r-note", note));
  const btns = el("div", "r-btns");
  const link = (cls, text, href) => {
    const a = el("a", cls, text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  };
  const map = mapsUrl(stop, origin);
  if (map) btns.append(link("r-map", "地図 Directions ↗", map));
  const own = safeHref(stop.link);
  if (own) btns.append(link("r-map alt", "Ticket or booking ↗", own));
  if (btns.childElementCount) inner.append(btns);
  wrap.append(inner);
  return wrap;
}

function row(stop, i, model) {
  const { state, minutes, nextId, stops, stays, day } = model;
  const next = state === "today" && stop.id === nextId;
  const r = el("div", "r");
  r.dataset.id = stop.id;
  if (state === "used" || (state === "today" && isPast(stop, minutes))) r.classList.add("is-done");
  if (next) r.classList.add("is-next");

  // The name and the line under it: the part that opens and closes the stop.
  const body = el("div", "r-b");
  body.setAttribute("role", "button");
  body.tabIndex = 0;
  body.setAttribute("aria-expanded", "false");
  const title = str(stop.title);
  if (title || next) {
    const n = el("div", "r-n");
    if (next) n.append(el("span", "tag", "こんど"));
    if (title) n.append(title);
    body.append(n);
  }
  const lead = next ? nextLine(stop, minutes) : "";
  const detail = str(stop.detail);
  if (lead || detail) {
    const s = el("div", "r-s");
    if (lead) s.append(el("b", "r-lv", lead));
    if (lead && detail) s.append(" ");
    if (detail) s.append(detail);
    body.append(s);
  }
  r.append(timeCell(stop), body, el("div", "r-j", str(stop.signJp)), more(stop, originFor(stops, i, stays, day.date)));
  return r;
}

// Drawn once per day, place and mark; a redraw reuses the string.
const stamps = new Map();

// A used day's gate stamp, the same on every phone: seeded from the date's
// digits; its place the day's last station, else the city.
function gate(day, h, mark) {
  const seed = Number(day.date.replace(/-/g, "")) || 1;
  const place = str(day.toJp) || h.city;
  const key = seed + "|" + place + "|" + mark;
  if (!stamps.has(key)) {
    stamps.set(key, { svg: gateStampSVG(seed, place, gateDate(day.date), mark), rot: (-14 + rng(seed)() * 22).toFixed(1) + "deg" });
  }
  const { svg, rot } = stamps.get(key);
  const insp = el("div", "insp");
  insp.style.setProperty("--rot", rot);
  insp.innerHTML = svg; // escaped by gateStampSVG
  return insp;
}

// The right-hand side of the date row: 当日限り有効, or on Day 1 before the
// trip how many days until it is valid.
function validity(number, toGo) {
  if (number === 1 && toGo > 0) {
    const s = el("span", "", "あと" + toGo + "日");
    s.append(el("i", "", toGo === 1 ? "Valid tomorrow" : "Valid in " + toGo + " days"));
    return s;
  }
  return el("span", "", "当日限り有効");
}

export function ticketEl(model) {
  const { day, number, header: h, stops, mark, tripName, state, total, toGo } = model;
  const date = day.date;
  const tk = el("article", "tk");
  // The line's colour; without a valid one the band stays neutral (css/days.css).
  if (h.colour) {
    tk.style.setProperty("--line", h.colour);
    tk.style.setProperty("--line-ink", h.ink);
  }

  const head = el("div", "tk-head");
  const kind = el("div", "tk-kind");
  const k = el("span", "", "一日乗車券");
  k.append(el("i", "", "1-Day Ticket"));
  kind.append(k, el("span", "fare", total > 0 ? yen(total) : ""));
  head.append(kind, route(h, tripName));
  if (h.title) head.append(el("div", "tk-title", h.title));
  const dh = dayHead(date);
  const when = el("span", "", dh.jp);
  when.append(el("i", "", dh.en));
  const dateRow = el("div", "tk-date");
  dateRow.append(when, validity(number, toGo));
  head.append(dateRow);
  if (state === "used") head.append(gate(day, h, mark));

  const rows = el("div", "rows");
  if (stops.length) rows.append(...stops.map((stop, i) => row(stop, i, model)));
  else rows.append(el("div", "r-none", "Nothing planned yet."));

  const foot = el("div", "tk-foot");
  foot.append(el("span", "", issueLine(date, number, mark)), el("span", "", "Good for this day only"));

  // A used day is punched on the perforation, clear of the print.
  const perf = el("div", "tk-perf");
  if (state === "used") perf.append(el("span", "punch"));
  tk.append(band(h, number), head, perf, rows, foot);
  return tk;
}
