/* Copyright (c) 2026 moissmart1. All rights reserved. No licence is granted: do not copy, adapt or reuse this code or design, and do not use it to train or prompt an AI system to reproduce it. See LICENSE. */
// Who has paid the most so far, against their own share: the quiet line in
// the register (js/views/register.js). Pure: no DOM, safe to import in Node.
//
// paidMost(names, expenses, payments) -> null, or { names, rows }
//   Each person's figures are the ones Money's working shows (money.js
//   working(): paid, share, sent, received). What a person has put in is
//   paid + sent - received; how far ahead of their share they are is that
//   minus their share, the same number as money.js balances().
//   null (the line is hidden) when there are no lines yet, or everyone is
//   within GAP_CENTS of even (exactly GAP_CENTS counts as within).
//   names: whoever is furthest ahead (more than one only on an exact tie).
//   rows: everyone, furthest ahead first (a tie keeps the trip's order), each
//   { name, paid, share, sent, received, put, ahead, sentTo, backFrom }, where
//   sentTo / backFrom are the people payments went to / came from.

import { working } from "./money.js";

export const GAP_CENTS = 4000; // $40.00

export function paidMost(names, expenses, payments) {
  const live = expenses.filter((e) => !e.deleted);
  if (!live.length || !names.length) return null;
  const pays = payments.filter((p) => !p.removed);
  const rows = names.map((name, i) => {
    const w = working(name, live, pays);
    const put = w.paid + w.sent - w.received;
    const sentTo = [...new Set(pays.filter((p) => p.from === name && p.to !== name).map((p) => p.to))];
    const backFrom = [...new Set(pays.filter((p) => p.to === name && p.from !== name).map((p) => p.from))];
    return { name, i, ...w, put, ahead: put - w.share, sentTo, backFrom };
  });
  if (rows.every((r) => Math.abs(r.ahead) <= GAP_CENTS)) return null;
  rows.sort((a, b) => b.ahead - a.ahead || a.i - b.i);
  const top = rows[0].ahead;
  return {
    names: rows.filter((r) => r.ahead === top).map((r) => r.name),
    rows: rows.map(({ i, ...r }) => r),
  };
}

const you = (name, me, cap) => (name === me ? (cap ? "You" : "you") : name);

// The words of the line: "Paid the most so far: " and the name(s), each to be
// set in bold as text ("you" for the viewer).
export function lineNames(result, me) {
  return result ? result.names.map((n) => you(n, me, false)) : [];
}

// One row of the reasoning, money as `fmt` writes cents (format.js dollars).
// The first row (whoever the line names) is a sentence; the others are short.
// -> { head, sub }: sub is "" when nothing was sent or received.
export function reasonText(r, me, first, fmt) {
  const who = you(r.name, me, true);
  const head = first
    ? who + (r.name === me ? " have" : " has") + " paid " + fmt(r.put) + " of a " + fmt(r.share) + " share"
    : who + ": " + fmt(r.put) + " of " + fmt(r.share);
  if (!r.sent && !r.received) return { head, sub: "" };
  const bits = [fmt(r.paid) + " for the group"];
  if (r.sent) bits.push(fmt(r.sent) + " sent" + (r.sentTo.length === 1 ? " to " + you(r.sentTo[0], me, false) : ""));
  if (r.received) bits.push(fmt(r.received) + " back" + (r.backFrom.length === 1 ? " from " + you(r.backFrom[0], me, false) : ""));
  return { head, sub: bits.join(", ") };
}

// The boxes under a person in the reasoning: each is a tenth of their share.
// -> { full, half, more }: `full` whole boxes and `half` (0 or 1) a half box,
// of 10 drawn; `more`, the whole tenths past ten (shown as "+n" when over 10.2).
export function shareCard(put, share) {
  if (!(share > 0)) return null;
  const n = Math.max(0, put) / (share / 10);
  const full = Math.min(10, Math.floor(n));
  const half = full < 10 && n > full + 0.25 ? 1 : 0;
  return { full, half, more: n > 10.2 ? Math.round(n - 10) : 0 };
}
