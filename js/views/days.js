// The Days screen: a rail of day tickets (js/views/ticket.js), one per trip
// day, swiped with the browser's own scroll snapping; a counter ("Day 3 of
// 11") and a row of squares, one per day, that jump to a day.
//
// mountDays(root, store, { clock, onStop, onAddStop, onStay, onAllDays })
//   -> { goDay(index, smooth), day() }
// - clock: the trip's clock (js/clock.js). Every "now" here comes from
//   clock.now(), never Date.now(), and is judged in the trip's time zone.
// - onAllDays(): the counter was tapped. onStop, onAddStop, onStay are for
//   the stop and stay parts of the ticket.
// - goDay(index, smooth): bring that day's ticket into view. day(): the date
//   of the ticket in view.
// It opens on today (js/plan.js openDayIndex). When the store changes the
// tickets are redrawn in place and the day in view stays in view.

import { openDayIndex, dayState, daysToGo, nowIn, stopsFor, header, dayTotalYen } from "../plan.js";
import { issuer, dayShort } from "../format.js";
import { ticketEl } from "./ticket.js";

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const list = (v) => (Array.isArray(v) ? v : []);
const calm = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// onStop, onAddStop and onStay are taken now and called once the ticket has
// those parts.
export function mountDays(root, store, { clock, onAllDays = () => {} } = {}) {
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
  let cur = -1; // the index of the day in view
  let opened = false; // has it been put on today yet

  const step = () => {
    const pg = rail.firstElementChild;
    if (!pg) return 1;
    const gap = parseFloat(getComputedStyle(rail).columnGap) || 0;
    return pg.offsetWidth + gap || 1;
  };
  const clamp = (i) => Math.max(0, Math.min(dates.length - 1, i));

  function showDay() {
    count.textContent = dates.length ? "Day " + (cur + 1) + " of " + dates.length : "";
    count.hidden = !dates.length;
    pager.querySelectorAll(".sq").forEach((b, i) => {
      b.classList.toggle("is-cur", i === cur);
      if (i === cur) b.setAttribute("aria-current", "date");
      else b.removeAttribute("aria-current");
    });
  }

  function goDay(index, smooth = false) {
    if (!dates.length) return;
    const i = clamp(index);
    cur = i;
    showDay();
    rail.scrollTo({ left: i * step(), behavior: smooth && !calm() ? "smooth" : "auto" });
  }

  // The day in view follows the rail as it is swiped.
  rail.addEventListener("scroll", () => {
    if (!dates.length) return;
    const i = clamp(Math.round(rail.scrollLeft / step()));
    if (i !== cur) {
      cur = i;
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
    if (ev.key === "ArrowRight") goDay(cur + 1, true);
    if (ev.key === "ArrowLeft") goDay(cur - 1, true);
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
    const toGo = daysToGo({ ...s.trip, tz }, nowMs);
    const mark = issuer(list(s.people));
    const stops = list(s.stops);
    const expenses = list(s.expenses);
    const inView = cur >= 0 ? dates[cur] : null;
    const left = rail.scrollLeft;

    const sameDays = days.length === dates.length && days.every((d, i) => d.date === dates[i]);
    if (!sameDays) {
      dates = days.map((d) => d.date);
      rail.replaceChildren(...dates.map((date) => {
        const pg = el("div", "pg");
        pg.dataset.date = date;
        return pg;
      }));
      drawPager();
    }

    days.forEach((day, i) => {
      const model = {
        day,
        number: i + 1,
        count: days.length,
        state: dayState(day.date, now.date),
        header: header(day),
        stops: stopsFor(stops, day.date),
        total: dayTotalYen(expenses, day.date),
        mark,
        stay: null,
        nextId: null,
        minutes: now.minutes,
        toGo,
        openId: null,
        tripName: s.trip.name,
      };
      rail.children[i].replaceChildren(ticketEl(model));
    });

    if (!opened) {
      opened = true;
      goDay(openDayIndex({ ...s.trip, tz }, days, nowMs));
      return;
    }
    // Keep the day in view where it was, without animation.
    const keep = inView ? dates.indexOf(inView) : -1;
    if (!sameDays) goDay(keep >= 0 ? keep : cur);
    else if (rail.scrollLeft !== left) rail.scrollLeft = left;
    else showDay();
  }

  render(store.state);
  store.subscribe(render);

  return {
    goDay,
    day: () => (cur >= 0 ? dates[cur] : null),
  };
}
