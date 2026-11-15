// First open: the gate (no key, or no backend yet), "Which one are you?" and
// the three "how this works" lines. mountFirst(root, store, opts) adds them to
// root and keeps them in step with the store.
// opts: connected (false: say the app is not connected yet; the store is never
// booted), storage (where mat.how is kept; default localStorage), onKey(key)
// (a trip key pasted on the no-key screen: keep it and start again).
//
// The no-key screen also takes a pasted trip link (or the bare key): an app
// opened from the Home Screen has storage of its own, without the key Safari
// kept. The pasted key is never drawn anywhere else and never logged.

export const HOW_LINES = ["Ring up what you paid.", "The slip says who pays whom.", "Stamp it the moment you send."];
const NO_KEY = "This link is missing its key. Ask Mo to send you the trip link again.";
const NOT_CONNECTED = "This app isn’t connected yet.";
const BAD_PASTE = "That doesn’t look like a trip link.";
const KEY_SHAPE = /^[A-Za-z0-9_-]{6,200}$/;

// The trip key in a pasted invite link (its #k= value) or a bare key; null
// when there is none that could be one.
export function keyFromPaste(text) {
  const t = String(text === undefined || text === null ? "" : text).trim();
  if (!t) return null;
  let key = t;
  const hash = t.indexOf("#");
  if (hash >= 0) {
    const found = t.slice(hash + 1).split("&").find((p) => p.startsWith("k="));
    if (found === undefined) return null;
    try {
      key = decodeURIComponent(found.slice(2)).trim();
    } catch {
      return null;
    }
  }
  return KEY_SHAPE.test(key) ? key : null;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

// A dimmed layer with a sheet that rises from the bottom.
function veil(id, label, title) {
  const layer = el("div", "veil");
  layer.id = id;
  layer.hidden = true;
  const sheet = el("div", "sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", label);
  const top = el("div", "sheet-top");
  top.append(el("span", "", title));
  sheet.append(top);
  layer.append(sheet);
  return { layer, sheet };
}

function setOpen(v, open) {
  if (open === !v.layer.hidden) return;
  v.layer.hidden = !open;
  if (!open) {
    v.sheet.classList.remove("is-open");
    return;
  }
  void v.sheet.offsetWidth; // start from below, so the sheet rises
  v.sheet.classList.add("is-open");
}

export function mountFirst(root, store, { connected = true, storage = defaultStorage(), onKey = () => {} } = {}) {
  const get = (k) => {
    try {
      return storage ? storage.getItem(k) : null;
    } catch {
      return null;
    }
  };
  const set = (k, v) => {
    try {
      if (storage) storage.setItem(k, v);
    } catch {
      // private mode: it will just ask again
    }
  };

  const gate = el("div", "gate");
  gate.id = "gate";
  gate.hidden = true;
  const gateText = el("p");
  // A way in when the key is missing: paste the trip link.
  const paste = el("div", "gate-key");
  const pasteLabel = el("label", "", "Or paste your trip link here");
  pasteLabel.htmlFor = "keyPaste";
  const pasteRow = el("div", "gate-key-r");
  const pasteField = el("input");
  pasteField.id = "keyPaste";
  pasteField.type = "text";
  for (const [k, v] of Object.entries({ autocapitalize: "none", autocorrect: "off", autocomplete: "off", spellcheck: "false", enterkeyhint: "go", inputmode: "url" })) {
    pasteField.setAttribute(k, v);
  }
  const pasteGo = el("button", "", "Open");
  pasteGo.type = "button";
  pasteGo.id = "keyGo";
  const pasteMsg = el("div", "gate-key-m");
  pasteMsg.id = "keyMsg";
  pasteMsg.setAttribute("role", "alert");
  pasteRow.append(pasteField, pasteGo);
  paste.append(pasteLabel, pasteRow, pasteMsg);
  gate.append(gateText, paste);

  function usePaste() {
    const key = keyFromPaste(pasteField.value);
    if (!key) {
      pasteMsg.textContent = BAD_PASTE;
      return;
    }
    pasteField.value = ""; // the key is not left on screen
    pasteMsg.textContent = "";
    pasteField.blur();
    onKey(key);
  }
  pasteGo.addEventListener("click", usePaste);
  pasteField.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      usePaste();
    }
  });
  pasteField.addEventListener("input", () => {
    pasteMsg.textContent = "";
  });

  const first = veil("first", "Which one are you?", "Which one are you?");
  const pick = el("div", "who-pick");
  first.sheet.append(pick);

  const how = veil("how", "How this works", "How this works");
  const lines = el("div", "how");
  for (const text of HOW_LINES) lines.append(el("div", "how-l", text)); // numbered by CSS
  const ok = el("button", "go-btn", "Got it");
  ok.type = "button";
  ok.id = "howOk";
  how.sheet.append(lines, ok);

  root.append(first.layer, how.layer, gate);

  // "How this works" shows once you are someone, until you tap "Got it" (R19).
  let shownPeople = "";

  pick.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-me]");
    if (!b) return;
    store.setMe(b.dataset.me);
  });
  ok.addEventListener("click", () => {
    set("mat.how", "1");
    render(store.state);
  });

  function drawPeople(people) {
    const sig = JSON.stringify(people.map((p) => [p.name, p.initials]));
    if (sig === shownPeople) return;
    shownPeople = sig;
    pick.replaceChildren(
      ...people.map((p) => {
        const b = el("button");
        b.type = "button";
        b.dataset.me = p.name;
        b.append(el("span", "seal", p.initials || p.name.slice(0, 2).toUpperCase()), document.createTextNode(p.name));
        return b;
      }),
    );
  }

  function render(s) {
    const blocked = !connected ? NOT_CONNECTED : s.status === "nokey" ? NO_KEY : null;
    gate.hidden = !blocked;
    if (blocked) gateText.textContent = blocked;
    paste.hidden = blocked !== NO_KEY;
    const needMe = !blocked && s.status === "ready" && !s.me && s.people.length > 0;
    if (needMe) drawPeople(s.people);
    setOpen(first, needMe);
    setOpen(how, !blocked && !needMe && !!s.me && get("mat.how") !== "1");
  }

  render(store.state);
  store.subscribe(render);
}
