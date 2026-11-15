// Starts the app: takes the trip key from the invite link, builds the api and
// the store, mounts the two screens (Days and Money) and boots.

import { API_URL } from "./config.js";
import { createApi } from "./api.js";
import { createStore } from "./store.js";
import { createClock } from "./clock.js";
import { dateIn, defaultRingDay, tripDay } from "./time.js";
import { mountDays } from "./views/days.js";
import { mountMoney } from "./views/money.js";
import { mountFirst } from "./views/first.js";
import { mountRegister } from "./views/register.js";
import { mountLine } from "./views/line.js";
import { mountHistory } from "./views/history.js";
import { mountYou } from "./views/you.js";
import { mountUndoBar } from "./views/ubar.js";
import { mountNet } from "./views/net.js";

// How often a visible phone asks the backend whether anything changed.
const CHECK_MS = 20000;
const TABS = ["days", "money"];

// localStorage, or a stand-in in memory when the browser will not give it.
function phoneStorage() {
  try {
    const s = globalThis.localStorage;
    s.getItem("mat.key");
    return s;
  } catch {
    const mem = new Map();
    return { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  }
}

// The invite link carries the key as #k=<key>. Keep it on the phone and take
// it out of the address bar, so it is not left in history or a shared URL.
// Returns the key found (or null), so it still works for this visit when the
// phone will not store it.
function takeKey(storage) {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return null;
  const parts = hash.split("&");
  const found = parts.find((p) => p.startsWith("k="));
  if (found === undefined) return null;
  let key = found.slice(2);
  try {
    key = decodeURIComponent(key);
  } catch {
    // keep it as typed
  }
  if (key) {
    try {
      storage.setItem("mat.key", key);
    } catch {
      // nowhere to keep it: it works for this visit only
    }
  }
  const rest = parts.filter((p) => p !== found).join("&");
  history.replaceState(history.state, "", location.pathname + location.search + (rest ? "#" + rest : ""));
  return key || null;
}

// The phone's storage, except that mat.key falls back to the key from this
// visit (its link, or a pasted one) when the phone could not keep it.
function withKey(storage, keyHere) {
  return {
    getItem(k) {
      let v = null;
      try {
        v = storage.getItem(k);
      } catch {
        v = null;
      }
      return v === null && k === "mat.key" ? keyHere() : v;
    },
    setItem: (k, v) => storage.setItem(k, v),
  };
}

// The two screens. showTab(tab) shows one, marks its button and makes the
// other inert; with `remember` it keeps the choice (mat.tab) and the trip day
// it was made on (mat.tabDay, by the real time, never the demo clock).
function mountTabs(store, storage) {
  const views = { days: document.getElementById("vDays"), money: document.getElementById("vMoney") };
  const nav = document.getElementById("nav");
  const read = (k) => {
    try {
      return storage.getItem(k);
    } catch {
      return null;
    }
  };
  const keptTab = TABS.includes(read("mat.tab")) ? read("mat.tab") : null;
  const keptDay = read("mat.tabDay");
  let tab = null;
  let settled = false; // the opening screen has been decided with the trip known

  function showTab(t, remember = true) {
    tab = t;
    for (const b of nav.querySelectorAll("button[data-tab]")) {
      const on = b.dataset.tab === t;
      b.classList.toggle("is-active", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    }
    for (const [name, view] of Object.entries(views)) {
      view.classList.toggle("is-active", name === t);
      view.inert = name !== t;
    }
    if (!remember) return;
    const trip = store.state.trip;
    try {
      storage.setItem("mat.tab", t);
      storage.setItem("mat.tabDay", dateIn((trip && trip.tz) || "Asia/Tokyo", Date.now()));
    } catch {
      // private mode: it opens on Days next time
    }
  }

  // The stored screen, except that on a new day of the trip it is the ticket;
  // with nothing stored it is the ticket.
  function opening(trip) {
    if (!keptTab) return "days";
    if (trip && trip.start) {
      const today = tripDay(trip, Date.now());
      if (today !== "pre" && today !== "post" && keptDay !== today) return "days";
    }
    return keptTab;
  }

  function settle(s) {
    if (settled || !(s.trip && s.trip.start)) return;
    settled = true;
    showTab(opening(s.trip));
  }

  showTab(opening(null), false);
  settle(store.state);
  store.subscribe(settle);
  nav.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-tab]");
    if (!b) return;
    settled = true;
    showTab(b.dataset.tab);
  });
  return { showTab, tab: () => tab };
}

function start() {
  const raw = phoneStorage();
  let keyHere = takeKey(raw);
  const storage = withKey(raw, () => keyHere);

  const connected = !!API_URL || typeof globalThis.MAT_FAKE_API === "function";
  let store;
  const api = createApi({
    url: API_URL,
    getKey: () => storage.getItem("mat.key"),
    getActor: () => (store && store.state.me) || storage.getItem("mat.me"),
  });
  store = createStore({ api, storage });

  // The one clock the Days screen reads, in the trip's time zone.
  const clock = createClock({ getTz: () => (store.state.trip && store.state.trip.tz) || "Asia/Tokyo" });
  const tabs = mountTabs(store, raw);

  const phone = document.getElementById("phone");
  const register = mountRegister(phone, store, { storage: raw });
  // One sheet at a time: opening one closes the others.
  const history = mountHistory(phone, store);
  const you = mountYou(phone, store, {
    getKey: () => storage.getItem("mat.key"),
    screen: () => (tabs.tab() === "days" ? "Days" : "Money"),
    onHistory: () => {
      you.close(false);
      history.open();
    },
  });
  const line = mountLine(phone, store, {
    onEdit: (id) => {
      line.close(false);
      register.edit(id);
    },
  });
  const ring = (day) => {
    if (!(store.state.trip && store.state.trip.start)) return;
    line.close(false);
    history.close(false);
    you.close(false);
    register.open(day);
  };
  mountDays(document.getElementById("vDays"), store, { clock });
  mountMoney(document.getElementById("vMoney"), store, {
    onRing: ring,
    onLine: (id) => {
      register.close();
      history.close(false);
      you.close(false);
      line.open(id);
    },
    onHistory: () => {
      register.close();
      line.close(false);
      you.close(false);
      history.open();
    },
  });
  mountUndoBar(phone, store);
  mountNet(phone, store);
  mountFirst(phone, store, {
    connected,
    storage,
    // A key pasted on the no-key screen: keep it and start, without a reload.
    onKey: (key) => {
      keyHere = key;
      try {
        raw.setItem("mat.key", key);
      } catch {
        // nowhere to keep it: it works for this visit only
      }
      store.boot();
    },
  });

  document.getElementById("ring").addEventListener("click", () => {
    if (store.state.trip && store.state.trip.start) ring(defaultRingDay(store.state.trip, Date.now()));
  });
  // Click-through tests reach the register and the store here; only when the
  // fake backend is in the page, never in the real app.
  if (typeof globalThis.MAT_FAKE_API === "function") globalThis.__matTest = { store, register };
  document.getElementById("youBtn").addEventListener("click", () => {
    register.close();
    line.close(false);
    history.close(false);
    you.open();
  });

  // Staying in step with the other phones: ask whether anything changed
  // every 20 seconds while the app is on screen, at once when it comes back
  // on screen, and when signal returns (after sending what was waiting).
  // One check at a time: on weak signal a slow check is not joined by more.
  let checking = null;
  let inFlight = null;
  const check = () => {
    if (inFlight) return inFlight;
    const st = store.state.status;
    if (st !== "ready" && st !== "error") return Promise.resolve();
    inFlight = store.checkRev().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  const startChecking = () => {
    if (connected && !checking) checking = setInterval(check, CHECK_MS);
  };
  const stopChecking = () => {
    clearInterval(checking);
    checking = null;
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      store.markSeen();
      stopChecking();
    } else {
      check();
      startChecking();
    }
  });
  window.addEventListener("online", () => {
    if (!connected) return;
    store.flush().then(check);
  });

  if (connected) store.boot();
  if (document.visibilityState !== "hidden") startChecking();
}

// The offline shell (sw.js). Quietly does nothing where service workers are
// missing or blocked. A new worker takes over at once, but this page is not
// reloaded for it (someone may be mid-entry): the next open gets the new shell.
// An app on the Home Screen often comes back without loading again, so the
// worker is also asked to look for a new version whenever the app comes back
// on screen. Registered before start(), so a broken start still gets fixed.
function registerWorker() {
  try {
    if (!("serviceWorker" in navigator)) return;
    let registration = null;
    Promise.resolve(navigator.serviceWorker.register("sw.js"))
      .then((r) => {
        registration = r || null;
      })
      .catch(() => {});
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" || !registration || typeof registration.update !== "function") return;
      try {
        Promise.resolve(registration.update()).catch(() => {});
      } catch {
        // nothing to do: the next open looks again
      }
    });
  } catch {
    // not allowed here
  }
}

registerWorker();
start();
