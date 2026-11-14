// Starts the app: takes the trip key from the invite link, builds the api and
// the store, mounts the screens and boots. Money is the only screen for now.

import { API_URL } from "./config.js";
import { createApi } from "./api.js";
import { createStore } from "./store.js";
import { defaultRingDay } from "./time.js";
import { mountMoney } from "./views/money.js";
import { mountFirst } from "./views/first.js";

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
function takeKey(storage) {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return;
  const parts = hash.split("&");
  const found = parts.find((p) => p.startsWith("k="));
  if (found === undefined) return;
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
}

function start() {
  const storage = phoneStorage();
  takeKey(storage);

  const connected = !!API_URL || typeof globalThis.MAT_FAKE_API === "function";
  let store;
  const api = createApi({
    url: API_URL,
    getKey: () => storage.getItem("mat.key"),
    getActor: () => (store && store.state.me) || storage.getItem("mat.me"),
  });
  store = createStore({ api, storage });

  const phone = document.getElementById("phone");
  const ring = (day) => {
    // Task 8 opens the register here.
    void day;
  };
  mountMoney(document.getElementById("vMoney"), store, {
    onRing: ring,
    onLine: () => {}, // Task 9: the receipt line sheet
    onHistory: () => {}, // Task 11: History
  });
  mountFirst(phone, store, { connected, storage });

  document.getElementById("ring").addEventListener("click", () => {
    if (store.state.trip && store.state.trip.start) ring(defaultRingDay(store.state.trip, Date.now()));
  });
  // #youBtn: Task 12 opens Settings.

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") store.markSeen();
  });

  if (connected) store.boot();
}

start();
