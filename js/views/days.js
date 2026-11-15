// The Days screen: a rail of day tickets (js/views/ticket.js), one per trip
// day, swiped with the browser's own scroll snapping; a counter ("Day 3 of
// 11", then "today", "used" or how long until that day) and a row of squares,
// one per day, filled for used days, that jump to a day.
//
// mountDays(root, store, { clock, onStop, onAddStop, onStay, onAllDays })
//   -> { goDay(index, smooth), day() }
// - clock: the trip's clock (js/clock.js). Every "now" here comes from
//   clock.now(), never Date.now(), and is judged in the trip's time zone.
// - onAllDays(): the counter was tapped. onStay(stayId): a ticket's stay row
//   was tapped. onStop, onAddStop are for the stop parts of the ticket.
// - goDay(index, smooth): bring that day's ticket into view. day(): the date
//   of the ticket in view.
// It opens on today (js/plan.js openDayIndex).
//
// Redrawing while someone is reading: the store changes on every sync and
// the clock is asked again every 15 seconds while the screen is in use. Only
// a ticket whose drawing changed is touched, and in it only the parts that
// changed (a stop row that is the same is kept as it is), so the stop that
// is open, the row that has focus, a height change under way and the gate
// stamp all survive. The day in view stays in view.
//
// The open stop: today's next stop is open by default. Once a person opens
// or closes a stop by hand, that choice holds (the next stop no longer opens
// itself) until the day in view changes.

import { openDayIndex, dayState, daysToGo, nowIn, stopsFor, nextStopId, header, dayTotalYen, stayFor } from "../plan.js";
import { issuer, dayShort } from "../format.js";
import { ticketEl } from "./ticket.js";

const TICK_MS = 15000;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const list = (v) => (Array.isArray(v) ? v : []);
const calm = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// A row's markup as it was drawn (before it was opened or closed), to tell
// whether a redrawn row is the same as the one on screen.
const drawn = new WeakMap();

// A row's markup without the text of its leave-by line.
const LEAD = /(<b class="r-lv">)[^<]*(<\/b>)/;
const withoutLead = (html) => html.replace(LEAD, "$1$2");

// Puts the fresh rows into `rows` in order, keeping each old row that is
// drawn the same. A row that differs only in its leave-by line's words (the
// next stop, every minute) keeps its node, and only those words change, so
// focus, its photo, a height change under way and a screen reader are left
// alone. Only rows that changed otherwise, or moved, are touched.
function patchRows(rows, fresh) {
  const old = new Map();
  for (const r of rows.children) if (r.dataset.id) old.set(r.dataset.id, r);
  const want = [...fresh.children].map((r) => {
    const keep = r.dataset.id ? old.get(r.dataset.id) : null;
    if (!keep) return r;
    const was = drawn.get(keep);
    const now = drawn.get(r);
    if (was === now) return keep;
    const lead = keep.querySelector(".r-lv");
    const next = r.querySelector(".r-lv");
    if (lead && next && withoutLead(was) === withoutLead(now)) {
      lead.textContent = next.textContent;
      drawn.set(keep, now);
      return keep;
    }
    return r;
  });
  want.forEach((node, i) => {
    const at = rows.children[i];
    if (at !== node) rows.insertBefore(node, at || null);
  });
  while (rows.children.length > want.length) rows.lastElementChild.remove();
}

// Brings the ticket on screen (`old`) in line with a freshly drawn one,
// part by part. Returns the ticket now on screen.
function patchTicket(old, fresh) {
  const a = [...old.children];
  const b = [...fresh.children];
  const sameShape = a.length === b.length && a.every((n, i) => n.className === b[i].className && n.tagName === b[i].tagName);
  if (!sameShape) {
    old.replaceWith(fresh);
    return fresh;
  }
  if (old.getAttribute("style") !== fresh.getAttribute("style")) {
    const style = fresh.getAttribute("style");
    if (style === null) old.removeAttribute("style");
    else old.setAttribute("style", style);
  }
  a.forEach((n, i) => {
    if (n.classList.contains("rows")) patchRows(n, b[i]);
    else if (n.outerHTML !== b[i].outerHTML) n.replaceWith(b[i]);
  });
  return old;
}

// onStop and onAddStop are taken now and called once the ticket has those parts.
export function mountDays(root, store, { clock, onAllDays = () => {}, onStay = () => {} } = {}) {
  const count = el("button", "bar-t");
  count.type = "button";
  count.id = "dayCount";
  const pager = el("div", "pager");
  pager.id = "pager";
  const bar = el("div", "bar");
  bar.append(count, pager);
  const rail = el("div", "rail");
  rail.id = "rail";
  root.replaceChildren(bar, rail);

  let dates = []; // the dates of the drawn tickets, in order
  let states = []; // each one's dayState
  let ahead = []; // before the trip: days until each one, else 0
  const sigs = new Map(); // date -> what its ticket was drawn from
  let cur = -1; // the index of the day in view
  let opened = false; // has it been put on today yet
  let seen = null; // { date, minutes } in the trip's zone when last drawn
  let autoId = null; // today's next stop: open unless a person chose
  let chosen = false; // a person has opened or closed a stop by hand
  let openId = null; // the stop they left open, or null

  const step = () => {
    const pg = rail.firstElementChild;
    if (!pg) return 1;
    const gap = parseFloat(getComputedStyle(rail).columnGap) || 0;
    return pg.offsetWidth + gap || 1;
  };
  const clamp = (i) => Math.max(0, Math.min(dates.length - 1, i));

  function applyOpen() {
    const id = chosen ? openId : autoId;
    for (const r of rail.querySelectorAll(".r[data-id]")) {
      const on = r.dataset.id === id;
      if (r.classList.contains("is-open") !== on) r.classList.toggle("is-open", on);
      const b = r.querySelector(".r-b");
      if (b) b.setAttribute("aria-expanded", String(on));
      const more = r.querySelector(".r-more");
      if (more) more.inert = !on;
    }
  }

  // The day in view changed: a choice made by hand no longer holds.
  function setCur(i) {
    if (i === cur) return;
    cur = i;
    if (chosen) {
      chosen = false;
      openId = null;
      applyOpen();
    }
  }

  function showDay() {
    const word = !dates.length ? "" : states[cur] === "today" ? "today" : states[cur] === "used" ? "used" : ahead[cur] === 1 ? "tomorrow" : ahead[cur] > 1 ? "in " + ahead[cur] + " days" : "";
    const parts = [];
    if (dates.length) parts.push(el("span", "", "Day " + (cur + 1) + " of " + dates.length));
    if (word) parts.push(" ", el("i", "", word));
    count.replaceChildren(...parts);
    count.hidden = !dates.length;
    pager.querySelectorAll(".sq").forEach((b, i) => {
      b.classList.toggle("is-cur", i === cur);
      b.classList.toggle("is-done", states[i] === "used");
      if (i === cur) b.setAttribute("aria-current", "date");
      else b.removeAttribute("aria-current");
    });
  }

  function goDay(index, smooth = false) {
    if (!dates.length) return;
    setCur(clamp(index));
    showDay();
    rail.scrollTo({ left: cur * step(), behavior: smooth && !calm() ? "smooth" : "auto" });
  }

  // The day in view follows the rail as it is swiped.
  rail.addEventListener("scroll", () => {
    if (!dates.length) return;
    const i = clamp(Math.round(rail.scrollLeft / step()));
    if (i !== cur) {
      setCur(i);
      showDay();
    }
  }, { passive: true });
  pager.addEventListener("click", (ev) => {
    const b = ev.target.closest(".sq");
    if (b) goDay(Number(b.dataset.i), true);
  });
  count.addEventListener("click", () => onAllDays());
  root.addEventListener("keydown", (ev) => {
    if (ev.target.closest("input, textarea, select")) return;
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.classList.contains("r-b")) {
      ev.preventDefault();
      toggle(ev.target.closest(".r"));
      return;
    }
    if (ev.key === "ArrowRight") goDay(cur + 1, true);
    if (ev.key === "ArrowLeft") goDay(cur - 1, true);
  });

  // Opening a stop closes the one that was open; tapping the open one closes it.
  function toggle(r) {
    if (!r || !r.dataset.id) return;
    const was = chosen ? openId : autoId;
    chosen = true;
    openId = was === r.dataset.id ? null : r.dataset.id;
    applyOpen();
  }
  rail.addEventListener("click", (ev) => {
    const stay = ev.target.closest(".tk-stay");
    if (stay) {
      onStay(stay.dataset.stay);
      return;
    }
    if (ev.target.closest("a, button")) return;
    toggle(ev.target.closest(".r[data-id]"));
  });

  function drawPager() {
    pager.replaceChildren(...dates.map((date, i) => {
      const b = el("button", "sq");
      b.type = "button";
      b.dataset.i = String(i);
      b.setAttribute("aria-label", dayShort(date));
      return b;
    }));
  }

  // Where focus is in the rail, to put it back if a redraw took it away.
  function focusSpot() {
    const a = document.activeElement;
    if (!a || !rail.contains(a)) return null;
    const r = a.closest(".r[data-id]");
    const pg = a.classList.contains("tk-stay") ? a.closest(".pg") : null;
    return { node: a, id: r ? r.dataset.id : null, cls: a.className, stayOn: pg ? pg.dataset.date : null };
  }
  function restoreFocus(spot) {
    if (!spot || document.activeElement === spot.node) return;
    let target = spot.node.isConnected ? spot.node : null;
    if (!target && spot.id) {
      const r = rail.querySelector('.r[data-id="' + CSS.escape(spot.id) + '"]');
      target = r && ((spot.cls && r.getElementsByClassName(spot.cls.split(" ")[0])[0]) || r.querySelector(".r-b"));
    }
    if (!target && spot.stayOn) target = rail.querySelector('.pg[data-date="' + CSS.escape(spot.stayOn) + '"] .tk-stay');
    if (target) target.focus({ preventScroll: true });
  }

  function render(s) {
    const ready = s.status === "ready" && s.trip && s.trip.start && list(s.days).length;
    if (!ready) {
      if (!dates.length) {
        count.hidden = true;
        rail.replaceChildren();
        pager.replaceChildren();
      }
      return;
    }
    const days = list(s.days).filter((d) => d && typeof d.date === "string" && d.date);
    const tz = s.trip.tz || "Asia/Tokyo";
    const nowMs = clock.now();
    const now = nowIn(tz, nowMs);
    seen = now;
    const toGo = daysToGo({ ...s.trip, tz }, nowMs);
    const mark = issuer(list(s.people));
    // A row typed into the Sheet by hand may be blank or have no id.
    const stops = list(s.stops).filter((x) => x && typeof x.id === "string" && x.id && typeof x.date === "string");
    const stays = list(s.stays).filter((x) => x && typeof x === "object");
    const expenses = list(s.expenses).filter((x) => x && typeof x === "object");
    const inView = cur >= 0 ? dates[cur] : null;
    const left = rail.scrollLeft;
    const spot = focusSpot();

    const sameDays = days.length === dates.length && days.every((d, i) => d.date === dates[i]);
    if (!sameDays) {
      dates = days.map((d) => d.date);
      sigs.clear();
      rail.replaceChildren(...dates.map((date) => {
        const pg = el("div", "pg");
        pg.dataset.date = date;
        return pg;
      }));
      drawPager();
    }
    states = days.map((d) => dayState(d.date, now.date));
    ahead = days.map((d) => (toGo > 0 ? daysToGo({ start: d.date, tz }, nowMs) : 0));

    autoId = null;
    days.forEach((day, i) => {
      const state = states[i];
      const dayStops = stopsFor(stops, day.date);
      const nextId = state === "today" ? nextStopId(dayStops, now.minutes) : null;
      if (nextId) autoId = nextId;
      const model = {
        day,
        number: i + 1,
        count: days.length,
        state,
        header: header(day),
        stops: dayStops,
        stays,
        total: dayTotalYen(expenses, day.date),
        mark,
        stay: stayFor(stays, day.date),
        nextId,
        // Only today's ticket changes with the minute; only Day 1 counts down.
        minutes: state === "today" ? now.minutes : null,
        toGo: i === 0 ? toGo : 0,
        tripName: s.trip.name,
      };
      const sig = JSON.stringify(model);
      if (sigs.get(day.date) === sig) return;
      sigs.set(day.date, sig);
      const fresh = ticketEl(model);
      for (const r of fresh.querySelectorAll(".r[data-id]")) drawn.set(r, r.outerHTML);
      const pg = rail.children[i];
      const old = pg.firstElementChild;
      if (old) patchTicket(old, fresh);
      else pg.append(fresh);
    });
    applyOpen();
    restoreFocus(spot);

    if (!opened) {
      opened = true;
      // Put on today while Days is not the screen showing (the app opened on
      // Money, or in the background): Days counts as last seen today, so
      // coming to it on a later day moves the rail on (R32).
      if (!timer) leftOn = now.date;
      goDay(openDayIndex({ ...s.trip, tz }, days, nowMs));
      return;
    }
    // Keep the day in view where it was, without animation.
    const keep = inView ? dates.indexOf(inView) : -1;
    if (!sameDays) goDay(keep >= 0 ? keep : cur);
    else {
      if (rail.scrollLeft !== left) rail.scrollLeft = left;
      showDay();
    }
  }

  const tzOf = (s) => s.trip.tz || "Asia/Tokyo";
  const tripReady = (s) => s.status === "ready" && s.trip && s.trip.start;

  // Ask the clock again: redraw when the trip zone's minute or day moved on.
  function tick() {
    const s = store.state;
    if (!tripReady(s)) return;
    const now = nowIn(tzOf(s), clock.now());
    if (!seen || now.date !== seen.date || now.minutes !== seen.minutes) render(s);
  }

  // The clock is asked only while the app is on screen and Days is the
  // screen showing; at once when either comes back. Coming back on a later
  // trip day than Days was last seen on, the rail moves to today's ticket
  // (R32); it never moves while the screen is being looked at.
  let timer = null;
  let leftOn = null; // the trip-zone date when Days was last on screen
  function wake() {
    const live = document.visibilityState !== "hidden" && root.classList.contains("is-active");
    const s = store.state;
    if (live && !timer) {
      timer = setInterval(tick, TICK_MS);
      tick();
      const back = leftOn;
      leftOn = null;
      if (back && tripReady(s) && dates.length) {
        const nowMs = clock.now();
        if (nowIn(tzOf(s), nowMs).date > back) goDay(openDayIndex({ ...s.trip, tz: tzOf(s) }, dates.map((date) => ({ date })), nowMs));
      }
    } else if (!live && timer) {
      clearInterval(timer);
      timer = null;
      leftOn = tripReady(s) ? nowIn(tzOf(s), clock.now()).date : null;
    }
  }
  document.addEventListener("visibilitychange", wake);
  new MutationObserver(wake).observe(root, { attributes: true, attributeFilter: ["class"] });

  render(store.state);
  store.subscribe(render);
  if (clock.subscribe) clock.subscribe(() => render(store.state));
  wake();

  return {
    goDay,
    day: () => (cur >= 0 ? dates[cur] : null),
  };
}
