// First open: the gate (no key, or no backend yet), "Which one are you?" and
// the three "how this works" lines. mountFirst(root, store, opts) adds them to
// root and keeps them in step with the store.
// opts: connected (false: say the app is not connected yet; the store is never
// booted), storage (where mat.how is kept; default localStorage).

export const HOW_LINES = ["Ring up what you paid.", "The slip says who pays whom.", "Stamp it the moment you send."];
const NO_KEY = "This link is missing its key. Ask Mo to send you the trip link again.";
const NOT_CONNECTED = "This app isn't connected yet.";

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

export function mountFirst(root, store, { connected = true, storage = defaultStorage() } = {}) {
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
  gate.append(gateText);

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
    const needMe = !blocked && s.status === "ready" && !s.me && s.people.length > 0;
    if (needMe) drawPeople(s.people);
    setOpen(first, needMe);
    setOpen(how, !blocked && !needMe && !!s.me && get("mat.how") !== "1");
  }

  render(store.state);
  store.subscribe(render);
}
