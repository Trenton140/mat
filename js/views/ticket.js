// One day as a railway ticket: the line's band with the day number, the route
// in large type, the date, a perforation, the day's stops as printed rows and
// a fine-print footer. Ported from the mockup's ticket(), built node by node:
// every name, title and note from the Sheet goes in with textContent.
//
// ticketEl(model) -> HTMLElement (an <article class="tk">), where
// model = { day, number, count, state, header, stops, total, mark, stay,
//           nextId, minutes, toGo, openId, tripName }
// - day: the Days row ({ date, city, title, ... }); header: header(day) from
//   js/plan.js; stops: stopsFor(...) for the day, in order; number: 1-based;
//   mark: the issuer's mark ("MAT"); tripName: printed when the day has no
//   route and no city.
// - state, total, stay, nextId, minutes, toGo and openId are carried for the
//   time-of-day and stay parts of the ticket, which are drawn elsewhere.

import { minutesOf, issueLine } from "../plan.js";
import { dayHead } from "../format.js";

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

function row(stop) {
  const r = el("div", "r");
  r.dataset.id = stop.id;
  const t = minutesOf(stop.time) === null ? "—" : stop.time;
  const body = el("div");
  const title = str(stop.title);
  if (title) body.append(el("div", "r-n", title));
  const detail = str(stop.detail);
  if (detail) body.append(el("div", "r-s", detail));
  r.append(el("div", "r-t", t), body, el("div", "r-j", str(stop.signJp)));
  return r;
}

export function ticketEl(model) {
  const { day, number, header: h, stops, mark, tripName } = model;
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
  kind.append(k, el("span", "fare"));
  head.append(kind, route(h, tripName));
  if (h.title) head.append(el("div", "tk-title", h.title));
  const dh = dayHead(date);
  const when = el("span", "", dh.jp);
  when.append(el("i", "", dh.en));
  const dateRow = el("div", "tk-date");
  dateRow.append(when, el("span", "", "当日限り有効"));
  head.append(dateRow);

  const rows = el("div", "rows");
  if (stops.length) rows.append(...stops.map(row));
  else rows.append(el("div", "r-none", "Nothing planned yet."));

  const foot = el("div", "tk-foot");
  foot.append(el("span", "", issueLine(date, number, mark)), el("span", "", "Good for this day only"));

  tk.append(band(h, number), head, el("div", "tk-perf"), rows, foot);
  return tk;
}
