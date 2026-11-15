# MAT

A phone web app for three friends splitting the costs of one trip. You ring up what you paid, it prints on a shared receipt, and a slip at the bottom says who owes whom. Every change goes into History and can be undone; nothing is ever erased.

- **Front end:** plain HTML, CSS and ES modules. No build step. Served by GitHub Pages from the root of `main`.
- **Backend:** one Google Apps Script web app bound to a Google Sheet (`backend/`). The Sheet is the database.
- **Access:** a trip key, carried in the invite link after `#k=`. The key lives only in the script's Script Properties and in the links people are sent. It is never in this repo.

## Run it

```bash
npm install
npm run serve     # http://localhost:4173
npm test          # unit tests
npm run e2e       # click-through tests in a headless browser (about two minutes)
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

## The Sheet

- Once the trip is live, do not delete rows by hand. Deleted expenses and removed payments stay as rows with a date in `deleted_at` / `removed_at`; clear that cell, or use History in the app, to bring one back.
- Text columns are stored as plain text, so a title like `=SUM(1)` or `1/2 price ramen` stays exactly as typed.
- To change the trip key: delete `TRIP_KEY` in Script Properties, run `setup`, then `showInvite`. Old links stop working.
