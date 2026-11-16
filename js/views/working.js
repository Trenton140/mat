/* Copyright (c) 2026 moissmart1. All rights reserved. No licence is granted: do not copy, adapt or reuse this code or design, and do not use it to train or prompt an AI system to reproduce it. See LICENSE. */
// "Show the working" under a slip row, and the sentence that explains a
// routed payment. workingLines and routeSentence are pure (safe in Node);
// drawWorking builds DOM, with every name and title set as textContent.

import { dollars, pt, typed } from "../format.js";
import { working } from "../money.js";

const you = (name, me, cap) => (name === me ? (cap ? "You" : "you") : name);
// "pay" for you, "pays" for anyone else.
const verb = (name, me, base) => (name === me ? base : base + "s");

// Why a routed row sends money to someone the payer did not directly owe.
export function routeSentence(row, via, me) {
  const head = you(row.from, me, true) + " " + verb(row.from, me, "pay") + " " + you(row.to, me);
  if (via === "others") return head + " to cover what the others owe. Fewer payments, same totals.";
  return head + " because " + you(row.from, me) + " " + verb(row.from, me, "owe") + " " + you(via, me) +
    " and " + you(via, me) + " " + verb(via, me, "owe") + " " + you(row.to, me) + ". Fewer payments, same totals.";
}

// The working for `name`, from money.js working(): [{ label, cents, paid? }].
export function workingLines(name, w, me) {
  const out = [
    { label: name === me ? "You paid" : name + " paid", cents: w.paid, paid: true },
    { label: name === me ? "Your share came to" : name + "’s share came to", cents: w.share },
    { label: "Already sent", cents: w.sent },
  ];
  if (w.received !== 0) out.push({ label: "Already received", cents: w.received });
  return out;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function figure(cents) {
  const b = el("b");
  b.innerHTML = pt(dollars(cents)); // pt() escapes before adding its spans
  return b;
}

// The panel for `name` (a row's payer). linesOpen: the lines behind "paid"
// are listed. live: expenses not deleted; payments: all of them.
export function drawWorking(name, { me, live, payments, linesOpen }) {
  const box = el("div", "s-work");
  for (const line of workingLines(name, working(name, live, payments), me)) {
    if (line.paid) {
      const b = el("button", "s-wl");
      b.type = "button";
      b.dataset.paid = "";
      b.setAttribute("aria-expanded", String(!!linesOpen));
      b.append(el("span", "", line.label), " ", figure(line.cents));
      box.append(b);
      if (linesOpen) box.append(paidLines(name, live));
      continue;
    }
    const d = el("div", "s-wl");
    d.append(el("span", "", line.label), " ", figure(line.cents));
    box.append(d);
  }
  return box;
}

function paidLines(name, live) {
  const ul = el("ul", "s-lines");
  const mine = live
    .filter((e) => e.paidBy === name)
    .sort((a, b) => (a.day === b.day ? String(a.addedAt || "").localeCompare(String(b.addedAt || "")) : a.day === "pre" ? -1 : b.day === "pre" ? 1 : a.day < b.day ? -1 : 1));
  if (!mine.length) ul.append(el("li", "s-nil", "Nothing yet."));
  for (const e of mine) {
    const li = el("li");
    const amt = el("b");
    amt.innerHTML = pt(typed(e));
    li.append(el("span", "", e.title), " ", amt);
    ul.append(li);
  }
  return ul;
}
