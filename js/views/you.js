// Settings (the "You 設定" sheet): who you are, your e-Transfer address, the
// stamp sound, History, when the figures were last fetched, how this works,
// the invite link, the Google Sheet and "Report a problem". One sheet, no
// sub-pages.
//
// mountYou(root, store, { onHistory(), getKey(), screen }) -> { open(), close(restoreFocus), isOpen() }
// root is the phone. getKey() gives the trip key for the invite link; the key
// is only ever put on the clipboard, never drawn, logged or put in the report.
// Text from people or the Sheet goes in with textContent / .value only.

import { APP_VERSION } from "../config.js";
import { soundOn, setSound } from "../sound.js";
import { clock, dayHead, localDay, freshText, historySentence } from "../format.js";
import { HOW_LINES, standalone } from "./first.js";
import { copyText } from "../clip.js";

const NOT_YET = "Not updated yet";
const HISTORY_UNAVAILABLE = "history unavailable";
const NO_KEY = "This phone has no trip key, so there is no link to copy.";
const COPY_FAILED = "Couldn’t copy. Try again.";
const REPORT_LINES = 5;

const MARKUP = `
<div class="sheet-top"><span>You<i>設定</i></span><button type="button" id="youDone">Done</button></div>
<div class="set">
  <div class="set-h">Which one are you?</div>
  <div class="set-who" id="setWho"></div>
  <div class="set-r set-col">
    <label for="setMail">Your e-Transfer address<small>The others see it when they owe you money</small></label>
    <div class="set-mail">
      <input id="setMail" type="email" inputmode="email" maxlength="80" autocapitalize="none" autocorrect="off" autocomplete="off" spellcheck="false" enterkeyhint="done" placeholder="name@example.com">
      <button type="button" id="setMailSave">Save</button>
    </div>
  </div>
  <button type="button" class="set-r" id="setSound"><span>Stamp sound</span><b id="setSoundV">On</b></button>
  <button type="button" class="set-r" id="setHist"><span>History<small>Every change, with undo</small></span><b>Open</b></button>
  <button type="button" class="set-r" id="setFreshRow"><span>Last updated<small>Tap to fetch the latest</small></span><b id="setFresh"></b></button>
  <button type="button" class="set-r" id="setHow" aria-expanded="false" aria-controls="setHowLines"><span>How this works</span><b id="setHowV">Show</b></button>
  <div class="how" id="setHowLines" hidden></div>
  <button type="button" class="set-r" id="setInstall" aria-expanded="false"><span>Add to Home Screen<small>Opens like an app, full screen</small><span class="set-steps" id="setInstallHow" hidden><span>1. Tap Share, then Add to Home Screen.</span><span>2. If it asks for your trip link, paste: it’s already copied.</span></span></span><b>Set up</b></button>
  <button type="button" class="set-r" id="setInvite"><span>Invite link<small>For the other two. Keep it between you.</small></span><b>Copy</b></button>
  <a class="set-r" id="setSheet" target="_blank" rel="noopener" hidden><span>Google Sheet<small>Where all of this is kept</small></span><b>Open ↗</b></a>
  <button type="button" class="set-r" id="setReport"><span>Report a problem<small>Copies a short note to paste to Mo or Claude</small></span><b>Copy</b></button>
</div>`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// The note "Report a problem" copies. Pure: the view gathers the inputs.
// sentences: the newest history sentences, newest first, or null when the
// history could not be fetched. setAside: the Sheet rows the app left out
// (store.state.setAside). The trip key is never part of it.
export function reportText({ me, screen, version, when, sentences, setAside = [] }) {
  const lines = ["MAT: a problem to look at", "Who: " + (me || "nobody chosen"), "Screen: " + screen, "App version: " + version, "Time: " + when];
  if (setAside.length) lines.push("Lines in the Sheet the app can’t read: " + setAside.map((x) => x.id).join(", "));
  if (sentences === null || sentences === undefined) lines.push("Latest changes: " + HISTORY_UNAVAILABLE);
  else if (!sentences.length) lines.push("Latest changes: none yet");
  else lines.push("Latest changes, newest first:", ...sentences.slice(0, REPORT_LINES).map((x) => "- " + x));
  lines.push("What went wrong: ");
  return lines.join("\n");
}

// "Sat Dec 12, 13:20", in the phone's own clock.
function whenText(ms) {
  return dayHead(localDay(ms), []).en + ", " + clock(ms);
}

export function mountYou(root, store, { onHistory = () => {}, getKey = () => null, screen = "Money" } = {}) {
  const scrim = el("div", "scrim");
  scrim.id = "youScrim";
  scrim.hidden = true;
  const sheet = el("div", "sheet");
  sheet.id = "you";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Settings");
  sheet.inert = true;
  sheet.innerHTML = MARKUP;
  root.append(scrim, sheet);

  const $ = (id) => sheet.querySelector("#" + id);
  const who = $("setWho");
  const mail = $("setMail");
  const mailSave = $("setMailSave");
  const soundV = $("setSoundV");
  const fresh = $("setFresh");
  const how = $("setHow");
  const howV = $("setHowV");
  const howLines = $("setHowLines");
  const sheetLink = $("setSheet");
  const report = $("setReport");
  const install = $("setInstall");
  const installHow = $("setInstallHow");
  install.hidden = standalone();
  for (const text of HOW_LINES) howLines.append(el("div", "how-l", text)); // numbered by CSS

  let opened = false;
  let shownWho = ""; // the seals as last built
  let shownMe = null; // whose address the field is following
  let shownMail = ""; // the address as last drawn; the field follows it until it is typed in
  let sentMail = null; // the text last sent with Save, kept in the field if the save fails
  let reporting = false;

  const mePerson = (s) => s.people.find((p) => p.name === s.me) || null;
  const addressOf = (s) => {
    const p = mePerson(s);
    return p && p.etransfer ? String(p.etransfer).trim() : "";
  };

  function drawWho(s) {
    const sig = JSON.stringify(s.people.map((p) => [p.name, p.initials]));
    if (sig !== shownWho) {
      shownWho = sig;
      who.replaceChildren(
        ...s.people.map((p) => {
          const b = el("button");
          b.type = "button";
          b.dataset.me = p.name;
          b.append(el("span", "seal", p.initials || p.name.slice(0, 2).toUpperCase()), document.createTextNode(p.name));
          return b;
        }),
      );
    }
    for (const b of who.children) {
      const on = b.dataset.me === s.me;
      b.classList.toggle("is-on", on);
      b.firstChild.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function drawMail(s) {
    const addr = addressOf(s);
    // Another person: their own address, and whatever was half typed is dropped.
    if (s.me !== shownMe) {
      shownMe = s.me;
      sentMail = null;
      mail.value = addr;
      shownMail = addr;
    }
    // Saved: the field follows the address again. A save that failed keeps what was typed.
    const holdsSent = sentMail !== null && mail.value === sentMail;
    if (mail.value === shownMail && !holdsSent) mail.value = addr;
    shownMail = addr;
    mail.disabled = !s.me;
    mailSave.disabled = !s.me || mail.value.trim() === shownMail;
  }

  function render(s) {
    drawWho(s);
    drawMail(s);
    soundV.textContent = soundOn() ? "On" : "Off";
    fresh.textContent = s.loadedAt === null ? NOT_YET : freshText(s.loadedAt);
    const url = typeof s.sheetUrl === "string" && /^https?:\/\//i.test(s.sheetUrl) ? s.sheetUrl : "";
    sheetLink.hidden = !url;
    if (url) sheetLink.href = url;
    else sheetLink.removeAttribute("href");
  }

  function setHow(show) {
    howLines.hidden = !show;
    how.setAttribute("aria-expanded", show ? "true" : "false");
    howV.textContent = show ? "Hide" : "Show";
  }

  function open() {
    if (opened) return;
    opened = true;
    // A fresh look: the field shows what is saved, the lines are folded away.
    sentMail = null;
    mail.value = addressOf(store.state);
    shownMail = mail.value;
    setHow(false);
    render(store.state);
    sheet.classList.add("is-open");
    sheet.inert = false;
    scrim.hidden = false;
    root.classList.add("you-open");
    sheet.scrollTop = 0;
    $("youDone").focus({ preventScroll: true });
  }

  // restoreFocus: give focus back to the You button.
  function close(restoreFocus = true) {
    if (!opened) return;
    opened = false;
    sheet.classList.remove("is-open");
    sheet.inert = true;
    scrim.hidden = true;
    root.classList.remove("you-open");
    endInstall();
    if (sheet.contains(document.activeElement)) document.activeElement.blur();
    if (restoreFocus === true) {
      const btn = document.getElementById("youBtn");
      if (btn) btn.focus({ preventScroll: true });
    }
  }

  // ---- taps ----

  $("youDone").addEventListener("click", () => close());
  scrim.addEventListener("click", () => close());
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") close();
  });

  who.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-me]");
    if (b) store.setMe(b.dataset.me);
  });

  async function saveMail() {
    const me = store.state.me;
    if (!me) return;
    const text = mail.value.trim();
    if (text === addressOf(store.state)) return; // unchanged: nothing is sent
    sentMail = text;
    mailSave.disabled = true;
    const ok = await store.setPerson(me, { etransfer: text });
    if (ok && store.state.me === me) sentMail = null;
    render(store.state);
  }
  mailSave.addEventListener("click", saveMail);
  mail.addEventListener("input", () => {
    mailSave.disabled = mail.value.trim() === shownMail;
  });
  mail.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      saveMail();
      mail.blur();
    }
  });

  $("setSound").addEventListener("click", () => {
    setSound(!soundOn());
    soundV.textContent = soundOn() ? "On" : "Off";
  });

  $("setHist").addEventListener("click", () => onHistory());
  $("setFreshRow").addEventListener("click", () => store.refresh());
  how.addEventListener("click", () => setHow(howLines.hidden));

  const inviteLink = (key) => location.origin + location.pathname + "#k=" + encodeURIComponent(key);

  // Copies the invite link and says so; false when there is no key.
  async function copyInvite() {
    const key = getKey();
    if (!key) {
      store.notify(NO_KEY);
      return false;
    }
    store.notify((await copyText(inviteLink(key))) ? "Link copied." : COPY_FAILED);
    return true;
  }
  $("setInvite").addEventListener("click", copyInvite);

  // ---- Add to Home Screen ----
  // An app on the iPhone Home Screen keeps storage of its own, without the key
  // Safari kept. So while the steps show, the key is back in the address bar
  // and the manifest's start_url carries it; closing Settings takes both away
  // again (and so does the next load). The key is never drawn.
  let shownManifest = null; // the page's own <link rel="manifest">, while a keyed one stands in
  let keyedManifestUrl = null;

  function stripKeyFromAddress() {
    const parts = location.hash.replace(/^#/, "").split("&").filter(Boolean);
    const rest = parts.filter((p) => !p.startsWith("k="));
    if (rest.length === parts.length) return;
    history.replaceState(history.state, "", location.pathname + location.search + (rest.length ? "#" + rest.join("&") : ""));
  }

  function endInstall() {
    installHow.hidden = true;
    install.setAttribute("aria-expanded", "false");
    stripKeyFromAddress();
    const keyed = document.querySelector('link[rel="manifest"][data-keyed]');
    if (shownManifest && keyed) keyed.replaceWith(shownManifest);
    shownManifest = null;
    if (keyedManifestUrl) URL.revokeObjectURL(keyedManifestUrl);
    keyedManifestUrl = null;
  }

  // A blob: manifest built from the real one, with absolute URLs and a
  // start_url that opens with the key.
  async function useKeyedManifest(key) {
    const own = shownManifest || document.querySelector('link[rel="manifest"]:not([data-keyed])');
    if (!own) return;
    const base = new URL(own.getAttribute("href"), location.href).href;
    let m;
    try {
      const res = await fetch(base);
      m = await res.json();
    } catch {
      return; // the address bar still carries the key
    }
    if (!opened || installHow.hidden) return; // closed meanwhile
    const abs = (u) => new URL(u, base).href;
    const keyed = {
      ...m,
      id: abs(m.id || m.start_url || "./"),
      start_url: inviteLink(key),
      scope: abs(m.scope || "./"),
      icons: (m.icons || []).map((i) => ({ ...i, src: abs(i.src) })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(keyed)], { type: "application/manifest+json" }));
    const link = document.createElement("link");
    link.rel = "manifest";
    link.href = url;
    link.dataset.keyed = "1";
    const current = document.querySelector('link[rel="manifest"][data-keyed]') || own;
    if (!shownManifest) shownManifest = own;
    current.replaceWith(link);
    if (keyedManifestUrl) URL.revokeObjectURL(keyedManifestUrl);
    keyedManifestUrl = url;
  }

  install.addEventListener("click", async () => {
    const key = getKey();
    const copying = copyInvite(); // first, while the tap still counts for the clipboard
    if (!key) return;
    history.replaceState(history.state, "", location.pathname + location.search + "#k=" + encodeURIComponent(key));
    installHow.hidden = false;
    install.setAttribute("aria-expanded", "true");
    await Promise.all([copying, useKeyedManifest(key)]);
  });

  // The note needs the latest history, so it is built while the copy waits.
  // It uses what its own load fetched: another load may replace the tape.
  async function reportNote() {
    const h = await store.loadHistory();
    const sentences = !h || h.error ? null : h.entries.slice(0, REPORT_LINES).map(historySentence);
    return reportText({ me: store.state.me, screen, version: APP_VERSION, when: whenText(Date.now()), sentences, setAside: store.state.setAside || [] });
  }
  report.addEventListener("click", async () => {
    if (reporting) return;
    reporting = true;
    report.disabled = true;
    try {
      store.notify((await copyText(reportNote())) ? "Copied. Paste it to Mo or Claude." : COPY_FAILED);
    } finally {
      reporting = false;
      report.disabled = false;
    }
  });

  store.subscribe(render);
  render(store.state);

  return { open, close: (restoreFocus) => close(restoreFocus), isOpen: () => opened };
}
