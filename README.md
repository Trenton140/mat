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

- **It can:** read the trip (`get_trip`), explain who owes whom and why (`explain_debt`), add an expense, add, change or remove stops, save or remove a stay, change a day's ticket (`set_day`), read History and undo an entry, and bring in payments from the planner sheet (`sync_payments`, below). Every change goes through the same checks as the app, is logged in History marked "(through Claude)", and can be undone.
- **It cannot:** stamp payments, see or change e-Transfer addresses or emails, see or set anyone's picture (`get_trip` only says `has_picture` for each person), see the trip key or its own token, copy invite links, or change who is on the trip. (Its undo works on any History entry, as Undo in the app does, except a change to someone else's picture.) Replies never contain the key, the token, an e-Transfer address or an email.
- **The link:** Settings → Claude link → Copy. Anyone who has the invite link can copy it, and everyone's Claude link carries the same token: one token for the whole trip.
- **The token sits in the connector's address** (`?t=…`). Treat the Claude link like the invite link: whoever has it can change the plan and add expenses.
- **`as=`** in the link names who the changes are logged as (the person who copied it). A name that matches no one on the trip blocks every write until the link is copied again; with no `as=`, changes are logged as the first person.
- **Changing the token:** in the script editor, Project Settings → Script Properties, either edit `CLAUDE_TOKEN` to a new long random value, or delete it and run `migrate` (above) to make a new one. Every Claude link copied before stops working; each person copies theirs again from Settings.

## Payments from a planner sheet

The app can bring in payments kept in a separate Google Sheet (the "planner"), on request: Settings → Planner payments → Fetch, or Claude's `sync_payments`. Nothing runs on a timer. The backend reads the planner; the only thing it ever writes there is a "Before we go" tick (below).

**The tab.** The planner needs a tab named `Payments`, with column names in row 1 (any order): `payment_id, date_paid, payer, description, category, vendor, booking_ref, amount, currency, amount_cad, cad_is_exact, split_between, split_type, status, include_in_split, source, added_by, notes`. `split_between` is a comma list of names; `split_type` is `equal` or `personal`.

**The rule.** Only rows whose `include_in_split` is `yes` come in, and only equal splits between people on the trip. A new payment becomes an expense (in Canadian dollars when `amount_cad` is filled, otherwise in its own yen or dollars) whose note starts with the payment's id. The two are tied by the Expenses tab's `planner_id` column, which only a pull writes and the app never shows; editing the line's note does not untie it. A line rung up by hand whose note starts with a payment id that is in the planner (for example `X7 · North Rail · ref AB12`) is tied the first time a pull sees it. A payment id has at least one letter and one digit. The planner owns a payment's title, amount, currency, payer, split and note: a later pull brings those back in line with it. The app owns the day and kind. An expense deleted in the app is never brought back, a payment taken out of the split leaves its expense alone, and nothing is ever deleted by a pull. Every change is logged in History marked "(from the planner)" and can be undone. Undoing a change the planner made (not an add) only lasts until the next pull, which sets it back: to keep a different value, change it in the planner. Undoing an add removes the line, and the planner does not bring it back. A payment that can't be brought in (or is no longer in the planner, or is carried by two lines) is skipped and counted ("1 payment needs a look in the planner."). One pull adds or changes at most 10 expenses; when more remain it says so, and the next tap brings the next 10. Only the first 300 payment rows are read.

**Setting it up,** in this order:

1. Push this backend (`clasp push -f`).
2. In the script editor, run `checkPlanner` once. Google asks for the Sheets permission (`spreadsheets`, below) for the account the web app runs as, which must be able to open the planner; the log then says no planner is linked yet.
3. Update the deployment (`clasp create-deployment -i <deployment id> ...`, above).
4. Run `migrate` (above): it adds the `planner_id` column to the Expenses tab. Until then a pull is refused with "The trip sheet needs updating first."
5. Send `linkPlanner` from a terminal, with the trip key and the planner's spreadsheet id (the long part of its address between `/d/` and `/edit`) in environment variables, never typed into a file:

   ```bash
   read -rs MAT_KEY && export MAT_KEY          # paste the trip key, then Enter
   read -rs PLANNER_ID && export PLANNER_ID    # paste the planner's spreadsheet id, then Enter
   curl -sL -H 'Content-Type: text/plain;charset=utf-8' \
     --data "{\"key\":\"$MAT_KEY\",\"action\":\"linkPlanner\",\"args\":{\"id\":\"$PLANNER_ID\"}}" \
     "https://script.google.com/macros/s/<deployment id>/exec"
   unset MAT_KEY PLANNER_ID
   ```

   It answers `{"ok":true,...,"data":{"linked":true}}`. The id is kept only in the Script Property `PLANNER_ID`: never in a reply, the Log or History. `linkPlanner` works only while no planner is linked; it answers "A planner is already linked." otherwise.
6. Run `checkPlanner` again: the log says how many payment rows and Book Now items it found, or which column is missing, and whether the Change Log is there.

**Changing or unlinking it.** In the script editor, Project Settings → Script Properties, delete `PLANNER_ID` (then `linkPlanner` again to link another sheet). With none linked, the Settings row goes away on the next load; expenses already brought in stay.

## Before we go (bookings and prep from the planner)

The app's "Before we go" list is the planner's `Book Now` tab: bookings and prep to finish before the trip. Items are added and edited only in the planner. In the app someone can say "I'll do it" and tick an item off; a tick also marks it `Booked` in the planner.

**The planner's tabs.** `Book Now`: the header is the first row with cells named `#`, `Item`, `Book by` and `Status` (any case); `Notes` and `Booking link` are used when there. Rows above the header, rows with no `Item`, and rows whose `#` is not a whole number (a footnote line) are skipped; a `#` that appears twice keeps its first row. `Book by` is read as `2026-12-05`, `Dec 5`, `Dec 5, 2026`, `5 Dec` or a date cell (no year means the trip's year); anything else is no date. A link is kept only when it is a plain `https://` address. `Change Log`: the header is the first row with `#`, `Tab`, `Old value` and `New value`; a tick appends one row there and fills `#`, `Date / time` (Toronto time), `Agent / session`, `Tab`, `Cell(s)`, `Item`, `Old value`, `New value`, `Why`, `Proof / source` and `Verified?` where those columns exist.

**The Todos tab** in this Sheet holds the list: `id` (the planner's `#`), `item`, `book_by`, `status` (the planner's word as last read), `note`, `link`, `claimed_by`, `ticked_by`, `ticked_at`, `planner_written` (`yes` once the planner took a tick), `gone` (`yes` when the planner no longer lists it). All text. An item is done when its status starts with "booked" or someone ticked it. Rows are never deleted. Do not edit it by hand: a pull rewrites the planner's columns.

**The three actions.**

- `syncTodos` (`{ force }`): pulls the Book Now tab, at most once in 10 minutes unless `force` is true; updates changed items, adds new ones and marks missing ones gone, at most 15 rows per pull (it answers `more: true` when rows remain, and the next pull carries on). It writes no History. It then retries any tick the planner has not taken yet. It answers the list, when it last pulled, and any problems (a `#` used twice); a planner it can't read is refused as for payments, with the stored list still in the reply.
- `tickTodo` (`{ id }`): saves the tick in this Sheet first (one History entry, "Mo ticked off: …", undoable). Then, best effort, it re-reads the planner and, only if that row still has the same `#` and `Item` and is not already booked, writes `Booked` into its Status cell and appends one Change Log row (if the Change Log can't be found, nothing is written; if the log row fails, the old Status is put back). It answers `planner: "written"` or `"pending"`; a pending tick stands in the app and the next pull tries again. Once written it is never written again. Undoing a written tick puts the old status back in the planner (and logs it there) when the row still says Booked; if the planner can't be written then, the app's undo still happens and the item shows as done again at the next pull, because the planner still says Booked.
- `claimTodo` (`{ id, on }`): `on: true` puts the person on it (taking it from whoever had it); `on: false` hands it back, only if it is theirs. Each is a History entry ("Mo is on: …", "Mo took over: …, from Ajen", "Mo handed back: …") and can be undone. A done item can't be claimed.

`load` returns the list (`todos`, without gone items) and `todosPulledAt`; it never reads the planner. Claude's `get_trip` lists the open items and counts the done ones.

**On the phone** (Days tab, js/views/todos.js). Before the trip's first day the list sits under the day counter, titled 出発前 Before we go: open items first, earliest book-by date first (undated last), each with the seal of whoever is on it, and a due line counted on the Toronto calendar (`by Sat Dec 5 · in 19 days`, `tomorrow`, `today`, or in red `was due … · 2 days late`). Tapping a row opens it: the note, `Open the booking ↗` (when there is a link), `I’ll do it` / `Take it over` / `Hand it back`, and `Tick it off`, which lands the settle slip's 済 stamp with its thud and moves the item to the folded `済 Done (n)` group. From the first day on the list folds into one row (`3 things still open`) while anything is open, and is not shown once nothing is; with no planner linked, or no items, it is never shown. The phone fetches the list by itself when it starts and when Days is shown, if the last fetch is an hour old or more (quietly; it speaks up only when that fails twice in a row); `Fetch` at the foot of the list fetches it at once. A tick or claim is shown at once and rolled back with the usual notice when the backend refuses it or there is no signal; History lists each one with Undo.

**The permission, and why.** A tick writes to the planner, which is a different spreadsheet from this one. Google has no permission for writing one other spreadsheet: the script needs the full Sheets permission (`https://www.googleapis.com/auth/spreadsheets`, in place of `spreadsheets.readonly`). Only the owner can grant it, by running `checkPlanner` in the script editor. Even so, the code writes nothing to the planner but one Status cell and one Change Log row per tick or undone tick.

**Deploying it,** in this order (a deployment that needs a permission nobody has granted stops working for everyone):

1. Push this backend (`clasp push -f`).
2. The owner runs `checkPlanner` in the script editor and approves the Sheets permission; running it again logs the Book Now count and whether the Change Log was found.
3. Update the deployment on the same deployment id (`clasp create-deployment -i <deployment id> ...`).
4. Run `migrate` (above): it adds the `Todos` tab. Until then `syncTodos`, `tickTodo` and `claimTodo` are refused with "The trip sheet needs updating first."
5. Pull once: `syncTodos` with `{"force":true}` (the app's Fetch, or curl as for `migrate`, with an `actor`).

## You 設定

**Your picture.** In You, "Your picture" opens the phone's own picker. The phone crops the picture to a centred square, shrinks it to 128 × 128 and sends it as a small JPEG (at most 12,000 characters; one that will not fit is refused before anything is sent). It then shows inside your round seal, in place of your initials, on every seal on every phone; Change and Remove are on the same row. Each person sets only their own. Setting, changing or removing it is one History entry, which its owner can undo.

## The Sheet

- **Todos:** the "Before we go" list (above). A pull keeps it in step with the planner; do not type into it.
- **People:** `name`, `initials`, `order`, `etransfer`, `simplify`, `email`, `photo`. `photo` is the person's picture as a JPEG data address, or empty for none (then the seal shows `initials`). Set it from the app, not by hand; `migrate` adds the column to an older Sheet.

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
