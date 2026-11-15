// Starts the app: takes the trip key from the invite link, builds the api and
// the store, mounts the screens and boots. Money is the only screen for now.

import { API_URL } from "./config.js";
import { createApi } from "./api.js";
import { createStore } from "./store.js";
import { defaultRingDay } from "./time.js";
import { mountMoney } from "./views/money.js";
import { mountFirst } from "./views/first.js";
import { mountRegister } from "./views/register.js";
import { mountLine } from "./views/line.js";
import { mountUndoBar } from "./views/ubar.js";

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
// visit's link when the phone could not keep it.
function withKey(storage, keyHere) {
  return {
    getItem(k) {
      let v = null;
      try {
        v = storage.getItem(k);
      } catch {
        v = null;
      }
      return v === null && k === "mat.key" ? keyHere : v;
    },
    setItem: (k, v) => storage.setItem(k, v),
  };
}

function start() {
  const raw = phoneStorage();
  const storage = withKey(raw, takeKey(raw));

  const connected = !!API_URL || typeof globalThis.MAT_FAKE_API === "function";
  let store;
  const api = createApi({
    url: API_URL,
    getKey: () => storage.getItem("mat.key"),
    getActor: () => (store && store.state.me) || storage.getItem("mat.me"),
  });
  store = createStore({ api, storage });

  const phone = document.getElementById("phone");
  const register = mountRegister(phone, store, { storage: raw });
  // One sheet at a time: opening one closes the other.
  const line = mountLine(phone, store, {
    onEdit: (id) => {
      line.close(false);
      register.edit(id);
    },
  });
  const ring = (day) => {
    if (!(store.state.trip && store.state.trip.start)) return;
    line.close(false);
    register.open(day);
  };
  mountMoney(document.getElementById("vMoney"), store, {
    onRing: ring,
    onLine: (id) => {
      register.close();
      line.open(id);
    },
    onHistory: () => {}, // Task 11: History
  });
  mountUndoBar(phone, store);
  mountFirst(phone, store, { connected, storage });

  document.getElementById("ring").addEventListener("click", () => {
    if (store.state.trip && store.state.trip.start) ring(defaultRingDay(store.state.trip, Date.now()));
  });
  // Click-through tests reach the register and the store here; only when the
  // fake backend is in the page, never in the real app.
  if (typeof globalThis.MAT_FAKE_API === "function") globalThis.__matTest = { store, register };
  // #youBtn: Task 12 opens Settings.

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") store.markSeen();
  });

  if (connected) store.boot();
}

start();
