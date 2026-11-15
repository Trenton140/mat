// The stop sheet: adding a stop to a day, or changing or removing one. Opened
// from a ticket's ＋ Add a stop row or an open stop's Edit button.
//
// mountStopSheet(root, store, { clock }) -> { add(date), edit(id), close(restoreFocus), isOpen() }
// root is the phone. The fields are filled once, when the sheet opens; a
// sync or another phone's change never rewrites them while it is open, so
// nothing half-typed is lost. Save sends the stop (store.addStop), or only
// the fields that were changed (store.updateStop), and closes the sheet; the
// undo bar shows the change, or the backend's words when it refuses. Stop
// writes need a connection: with no signal (store.state.online false) Save
// and Remove are off and the sheet says so. The sheet closes itself when the
// stop it is changing is removed (by another phone, say). The fields are
// words, so the phone's own keyboard is used; the field being typed in is
// kept in view above it. `clock` is taken for the Days sheets' common shape;
// nothing here depends on the time.

import { dayHead } from "../format.js";

const NO_SIGNAL = "No signal. Stops need a connection.";
const TIME = /^([01]\d|2[0-3]):[0-5]\d/;

const MARKUP = `
<div class="sheet-top"><span id="stHead">Add a stop</span><button type="button" id="stDone">Done</button></div>
<div class="st">
  <div class="st-day" id="stDay"></div>
  <label class="st-f"><span>What</span><input id="stWhat" maxlength="80" autocomplete="off" enterkeyhint="next"></label>
  <label class="st-f st-time"><span>Time</span><input id="stTime" type="time"></label>
  <label class="st-f"><span>A line of detail</span><input id="stDetail" maxlength="120" autocomplete="off" enterkeyhint="next"></label>
  <label class="st-f"><span>How to get there</span><textarea id="stGo" maxlength="300" rows="2"></textarea></label>
  <label class="st-f st-time"><span>Minutes to get there</span><input id="stMin" inputmode="numeric" maxlength="3" autocomplete="off" enterkeyhint="next"></label>
  <label class="st-sw"><span>The time can’t slip<i>指定</i></span><input id="stFixed" type="checkbox" role="switch"></label>
  <label class="st-f"><span>Place name or pasted Maps link</span><input id="stPlace" maxlength="200" autocomplete="off" enterkeyhint="next"></label>
  <label class="st-f"><span>Link to a ticket or confirmation</span><input id="stLink" type="url" inputmode="url" autocomplete="off" enterkeyhint="next"></label>
  <label class="st-f"><span>Japanese name on signs</span><input id="stSign" maxlength="20" lang="ja" autocomplete="off" enterkeyhint="done"></label>
  <p class="st-msg" id="stMsg" role="status"></p>
  <div class="st-btns"><button type="button" id="stDel" hidden>Remove</button><button type="button" id="stSave" disabled>Add stop</button></div>
</div>`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const str = (v) => (typeof v === "string" ? v : "");
// "HH:MM" from what a time field gives, else "" (the backend does not trim it).
const cleanTime = (v) => {
  const m = TIME.exec(str(v).trim());
  return m ? m[0] : "";
};
// A whole number of minutes from 0 up (empty is 0, as the backend keeps it).
const cleanMin = (v) => {
  const digits = str(v).replace(/\D/g, "");
  return digits ? Number(digits) : 0;
};

export function mountStopSheet(root, store) {
  const scrim = el("div", "scrim");
  scrim.id = "stopScrim";
  scrim.hidden = true;
  const sheet = el("div", "sheet stop");
  sheet.id = "stop";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "stHead");
  sheet.inert = true;
  sheet.innerHTML = MARKUP;
  root.append(scrim, sheet);

  const $ = (id) => sheet.querySelector("#" + id);
  const head = $("stHead");
  const dayLine = $("stDay");
  const done = $("stDone");
  const msg = $("stMsg");
  const save = $("stSave");
  const del = $("stDel");
  const f = {
    title: $("stWhat"), time: $("stTime"), detail: $("stDetail"), gettingThere: $("stGo"), travelMin: $("stMin"),
    fixed: $("stFixed"), place: $("stPlace"), link: $("stLink"), signJp: $("stSign"),
  };

  let mode = null; // "add" or "edit" while open
  let date = null; // the day the stop is on
  let stopId = null; // the stop being changed
  let was = null; // the fields as they were filled, to send only what changed

  const isOpen = () => sheet.classList.contains("is-open");
  const current = () => (store.state.stops || []).find((s) => s && s.id === stopId && !s.deleted) || null;
  const online = () => store.state.online !== false;

  // The fields as the backend takes them.
  function read() {
    return {
      title: f.title.value.trim(),
      time: cleanTime(f.time.value),
      detail: f.detail.value.trim(),
      gettingThere: f.gettingThere.value.trim(),
      travelMin: cleanMin(f.travelMin.value),
      fixed: f.fixed.checked,
      place: f.place.value.trim(),
      link: f.link.value.trim(),
      signJp: f.signJp.value.trim(),
    };
  }

  function fill(stop) {
    f.title.value = str(stop.title);
    f.time.value = cleanTime(stop.time);
    f.detail.value = str(stop.detail);
    f.gettingThere.value = str(stop.gettingThere);
    const min = Number(stop.travelMin);
    f.travelMin.value = Number.isInteger(min) && min > 0 ? String(min) : "";
    f.fixed.checked = stop.fixed === true;
    f.place.value = str(stop.place);
    f.link.value = str(stop.link);
    f.signJp.value = str(stop.signJp);
    was = read();
  }

  // Save and Remove, and the no-signal line: from the store and the name.
  function update() {
    if (!isOpen()) return;
    const off = !online();
    save.disabled = off || f.title.value.trim() === "";
    del.disabled = off;
    msg.textContent = off ? NO_SIGNAL : "";
  }

  function render() {
    if (!isOpen()) return;
    if (mode === "edit" && !current()) {
      close(false);
      return;
    }
    update();
  }

  function show(title, day, saveWord) {
    head.textContent = title;
    const dh = dayHead(day);
    dayLine.replaceChildren(el("b", "", dh.en), el("i", "", dh.jp));
    save.textContent = saveWord;
    del.hidden = mode !== "edit";
    sheet.classList.add("is-open");
    sheet.inert = false;
    scrim.hidden = false;
    root.classList.add("stop-open");
    sheet.scrollTop = 0;
    update();
    // Done, not the name field: the keyboard does not cover the sheet as it rises.
    done.focus({ preventScroll: true });
  }

  function add(day) {
    if (typeof day !== "string" || !day) return false;
    mode = "add";
    date = day;
    stopId = null;
    fill({});
    show("Add a stop", day, "Add stop");
    return true;
  }

  function edit(id) {
    stopId = id;
    const stop = current();
    if (!stop) {
      stopId = null;
      return false;
    }
    mode = "edit";
    date = stop.date;
    fill(stop);
    show("Change a stop", stop.date, "Save");
    return true;
  }

  // restoreFocus: back to what opened the sheet on the ticket in view (the
  // stop's Edit, else its day's ＋ Add a stop).
  function close(restoreFocus = true) {
    if (!isOpen()) return;
    const id = stopId;
    const day = date;
    mode = null;
    stopId = null;
    sheet.classList.remove("is-open");
    sheet.inert = true;
    scrim.hidden = true;
    root.classList.remove("stop-open");
    sheet.style.removeProperty("--kb");
    if (sheet.contains(document.activeElement)) document.activeElement.blur();
    if (restoreFocus !== true) return;
    const edit = id ? root.querySelector('.r[data-id="' + CSS.escape(id) + '"] .r-edit') : null;
    const back = edit || (day ? root.querySelector('.pg[data-date="' + CSS.escape(day) + '"] .tk-add') : null);
    if (back) back.focus({ preventScroll: true });
  }

  function onSave() {
    if (save.disabled) return;
    const now = read();
    if (!now.title) return;
    if (mode === "add") {
      store.addStop({ date, ...now });
    } else if (mode === "edit") {
      const patch = {};
      for (const k of Object.keys(now)) if (now[k] !== was[k]) patch[k] = now[k];
      if (Object.keys(patch).length) store.updateStop(stopId, patch);
    }
    close();
  }

  function onRemove() {
    if (mode !== "edit" || del.disabled) return;
    const id = stopId;
    store.deleteStop(id);
    stopId = null; // its row is gone: focus goes to the day's ＋ Add a stop
    close();
  }

  // The phone's keyboard covers the bottom of the screen: the sheet sits on
  // top of it, and the field being typed in is scrolled into the sheet's view.
  function keepInView() {
    if (!isOpen()) return;
    const vv = globalThis.visualViewport;
    const kb = vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
    if (kb > 0) sheet.style.setProperty("--kb", kb + "px");
    else sheet.style.removeProperty("--kb");
    const a = document.activeElement;
    if (!a || !sheet.contains(a) || !a.matches("input, textarea")) return;
    const box = (a.closest(".st-f, .st-sw") || a).getBoundingClientRect();
    const view = sheet.getBoundingClientRect();
    const pad = 12;
    if (box.bottom > view.bottom - pad) sheet.scrollTop += box.bottom - view.bottom + pad;
    else if (box.top < view.top + pad) sheet.scrollTop -= view.top + pad - box.top;
  }
  sheet.addEventListener("focusin", () => requestAnimationFrame(keepInView));
  if (globalThis.visualViewport) globalThis.visualViewport.addEventListener("resize", keepInView);

  f.title.addEventListener("input", update);
  // Minutes are a whole number: anything else typed is dropped.
  f.travelMin.addEventListener("input", () => {
    const digits = f.travelMin.value.replace(/\D/g, "");
    if (digits !== f.travelMin.value) f.travelMin.value = digits;
  });
  save.addEventListener("click", onSave);
  del.addEventListener("click", onRemove);
  done.addEventListener("click", () => close());
  scrim.addEventListener("click", () => close());
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") close();
  });
  // The keyboard's Next goes to the next field; on the last one it puts the keyboard away.
  const order = [f.title, f.time, f.detail, f.travelMin, f.place, f.link, f.signJp];
  sheet.addEventListener("keydown", (ev) => {
    const i = order.indexOf(ev.target);
    if (ev.key !== "Enter" || i < 0 || ev.isComposing) return;
    ev.preventDefault();
    if (order[i + 1]) order[i + 1].focus();
    else ev.target.blur();
  });
  store.subscribe(render);

  return { add, edit, close: (restoreFocus) => close(restoreFocus), isOpen };
}
