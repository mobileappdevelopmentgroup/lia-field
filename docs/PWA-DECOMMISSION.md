# Retiring the web version of Lia Field

The PWA at <https://mobileappdevelopmentgroup.github.io/lia-field/> is being
replaced by the installed iOS and Android apps. NFC needs native code, and the
on-device equipment catalogue is what makes an inspection two taps instead of a
form.

**Do the steps in this order.** Deleting the Pages site first would silently
destroy any work a tech still has in that browser: the installed app cannot see
browser storage, and there is no way to get it back afterwards.

## 1. Ship the native apps and let them settle

Both stores, one release cycle. Nothing below happens until techs are actually
using the installed app.

The store data declarations were updated for sync on 2026-08-24
(`docs/STORE-DATA-DECLARATIONS.md`), so they no longer block that release.

## 2. Replace the Pages site with the farewell page

`pages-farewell/index.html` replaces the app at its own URL. It:

- finds anything still in that browser's storage and says how many jobs and
  items are at stake
- exports it all to a dated JSON file, through the share sheet on a phone and a
  download on desktop
- **unregisters the old service worker and deletes its caches**, without which
  the browser would keep serving the cached app instead of the notice
- says plainly that browser storage is separate from the installed app
- points at the certificate site, which does not need an app at all

Deploy it as `index.html` in the Pages repo, and delete `sw.js` and
`manifest.json` there so nothing re-registers.

## 3. Leave it up for a release cycle

At least one, ideally two. This is the only route back for a tech who has not
opened the app in a while.

## 4. Then remove the deploy copies

Only once the farewell page has been live long enough:

- delete the repo-root `index.html`, `sw.js` and `manifest.json` — these are
  Pages deploy copies, and the root `index.html` has already drifted from
  `field-app/index.html`
- turn off the GitHub Pages source
- drop the service-worker registration from `field-app/js/app.js` and remove
  `field-app/sw.js` (the Capacitor bundle already skips SW registration on
  native, so this is dead code there)
- decide on `field-app/manifest.json` — Capacitor does not need it; if kept it
  is dead weight in `www/`
- update `README.md:56`, and the Architecture section of `CLAUDE.md`, which
  still describes Lia Field as a PWA on GitHub Pages

## What must not happen

- Do not remove the Pages site without the farewell page in front of it.
- Do not remove `field-app/index.html` or `field-app/js/` — those are the app,
  not deploy copies. Only the repo-root duplicates go.
