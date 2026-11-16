# MAT

**Copyright (c) 2026 moissmart1. All rights reserved.** This is a private application; the source is public only because the host that serves it requires that. No licence is granted to copy, adapt or reuse it, or to use it as AI training data. See [LICENSE](LICENSE).

A phone web app for three friends splitting the costs of one trip. You ring up what you paid, it prints on a shared receipt, and a slip at the bottom says who owes whom. Every change goes into History and can be undone; nothing is ever erased.

- **Front end:** plain HTML, CSS and ES modules. No build step. Served by GitHub Pages from the root of `main`.
- **Backend:** one Google Apps Script web app bound to a Google Sheet (`backend/`). The Sheet is the database.
- **Access:** a trip key, carried in the invite link after `#k=`. The key lives only in the script's Script Properties and in the links people are sent. It is never in this repo.

The trip side: **Days** shows one ticket per trip day (its stops, the hotel for the night, a hotel card to show a taxi driver) and a stop sheet to add, change or remove stops. Settings has **Try another day**, a demo clock that shows Days as it will look on a chosen day; a reload or Stop ends it.

## Run it

```bash
npm install
npm run serve     # http://localhost:4173
npm test          # unit tests
npm run e2e       # click-through tests in a headless browser (about four minutes)
```

The click-through tests use a fake backend and never call the real one. They use port 4173, so run one at a time.

## Changing the front end

`sw.js` keeps the app's files on the phone so it opens with no signal. Its version is a hash of those files, so after changing anything under `css/`, `js/`, `index.html`, the manifest or the icons:

```bash
npm run stamp
```

`npm test` fails if you forget. Phones pick up the new version the next time the app is opened.

## Changing the backend

`backend/` is pushed with [clasp](https://github.com/google/clasp). `.clasp.json` (which names the script) is not in this repo.

```bash
clasp push -f
clasp create-deployment -i <deployment id> -d "what changed"
```

Deploy to the same deployment id every time, or the address in `js/config.js` stops matching.

First-time setup on a new Sheet: run `setup` once from the script editor (it creates the tabs, the people, the days and the trip key), then `showInvite` to read the key from the log.

`backend/Money.js` is generated from `js/money.js` by `npm run stamp`. Do not edit it by hand; `npm test` fails if it has drifted.

### migrate

`migrate` brings an older Sheet up to date: it adds any column the code expects that a tab's header row lacks (at the end, bold, formatted as setup formats it) and creates the Claude connector's token if there is none. It never changes what is in a data row and does not move `rev`. It is safe to run twice: the second run adds nothing and answers `[]`.

Run it once after pushing new backend code, from a terminal, with the trip key in an environment variable (never typed into a file or a script):

```bash
read -rs MAT_KEY && export MAT_KEY        # paste the trip key, then Enter
curl -sL -H 'Content-Type: text/plain;charset=utf-8' \
  --data "{\"key\":\"$MAT_KEY\",\"action\":\"migrate\"}" \
  "https://script.google.com/macros/s/<deployment id>/exec"
unset MAT_KEY
```

It answers `{"ok":true,...,"data":{"added":[...]}}` with the columns it added, for example `["Stays.deleted_at"]`.

## The Claude connector

The backend is also an MCP server, so someone's Claude can read the trip and make changes in it.

- **It can:** read the trip (`get_trip`), explain who owes whom and why (`explain_debt`), add an expense, add, change or remove stops, save or remove a stay, change a day's ticket (`set_day`), read History and undo an entry. Every change goes through the same checks as the app, is logged in History marked "(through Claude)", and can be undone.
- **It cannot:** stamp payments, see or change e-Transfer addresses or emails, see the trip key or its own token, copy invite links, or change who is on the trip. (Its undo works on any History entry, as Undo in the app does.) Replies never contain the key, the token, an e-Transfer address or an email.
- **The link:** Settings → Claude link → Copy. Anyone who has the invite link can copy it, and everyone's Claude link carries the same token: one token for the whole trip.
- **The token sits in the connector's address** (`?t=…`). Treat the Claude link like the invite link: whoever has it can change the plan and add expenses.
- **`as=`** in the link names who the changes are logged as (the person who copied it). A name that matches no one on the trip blocks every write until the link is copied again; with no `as=`, changes are logged as the first person.
- **Changing the token:** in the script editor, Project Settings → Script Properties, either edit `CLAUDE_TOKEN` to a new long random value, or delete it and run `migrate` (above) to make a new one. Every Claude link copied before stops working; each person copies theirs again from Settings.

## The Sheet

- Once the trip is live, do not delete rows by hand. Deleted expenses, stops and stays and removed payments stay as rows with a date in `deleted_at` / `removed_at`; clear that cell, or use History in the app, to bring one back. To take a row out by hand, put any date in its `deleted_at` instead of deleting it.
- Text columns are stored as plain text, so a title like `=SUM(1)` or `1/2 price ramen` stays exactly as typed.
- To change the trip key: delete `TRIP_KEY` in Script Properties, run `setup`, then `showInvite`. Old links stop working.

### Typing into the Stops, Stays and Days tabs by hand

The plan can be built in the app, through Claude, or by typing into the Sheet. The app reads what it can and leaves the rest out, so type carefully:

- **Easiest:** add stops and stays through the app or Claude, and only edit them by hand.
- **A new row needs an `id`** of 8 or more letters and digits, different from every other row's (for example `stopmo0001`, `stopmo0002`, …). A row with no id is not shown at all; one with a shorter id shows but cannot be changed from the app.
- **Dates** are `YYYY-MM-DD` (`2026-12-12`), and must be one of the trip's days. A date typed any other way matches no ticket, so the stop is never shown.
- **Times** are `HH:MM`, 24-hour (`09:30`, `18:05`). `9:30` is read as `09:30`; anything else (`9.30`, `6pm`) counts as no time and the stop sorts last.
- **`travel_min`** is whole minutes, from 0 to 600.
- **Stops:** the columns that matter are `id`, `date`, `time`, `title` (required), `detail`, `getting_there`, `travel_min`, `fixed` (TRUE or FALSE), `place` (a name or a Maps link), `sign_jp`, `link` (must start with `https://`), `note`.
- **Stays:** `id`, `name` (required), `name_jp`, `address_jp`, `first_night`, `last_night` (dates), `note`, `place`, `link`.
- **Days:** one row per trip day, keyed by `date`; `city`, `title`, `line_jp`, `line_en`, `line_colour` (`#RRGGBB`), `from_jp`, `from_en`, `to_jp`, `to_en`. Do not add or delete day rows.
- **Do not change the Trip tab's `tz`** (`Asia/Tokyo`): every "today", "next" and "leave by" depends on it.
- **A hand edit does not reach phones that are already open** until someone taps You → Last updated, or makes any change in the app. A phone opened afterwards sees it at once.
- **Never delete rows:** put a date in `deleted_at` instead (see above).
