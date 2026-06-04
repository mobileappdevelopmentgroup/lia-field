# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run typecheck          # TypeScript type-check (no emit)
npm run electron:dev       # Build runner then launch the Electron app in dev mode
npm run electron:build     # Build runner + package macOS DMG → dist/
npm run build:runner       # Build src/electron-runner.ts → dist/electron-runner.cjs only
npm run start              # Run the CLI entry point directly (tsx, bypasses Electron)
npm run codegen            # Launch Playwright codegen against bsiwebapp.com
```

There are no automated tests. The primary "test" is running `npm run electron:dev` and verifying behavior in the app.

## Architecture

This project ships three separate products from one repo:

- **Lia Office** — macOS Electron app (`electron/`, `src/`). Automates importing ladder CSVs into the BSI work-order web app using Playwright.
- **Lia Field** — PWA (`field-app/`). Hosted on GitHub Pages. Purely static; no build step.
- **Ladder Inspection Site** — static site (`inspection-site/index.html`). Deployed to S3/CloudFront.

### Lia Office process model

Electron's main process (`electron/main.cjs`, CommonJS) forks a child process running `dist/electron-runner.cjs` for every automation run. The child is the compiled output of `src/electron-runner.ts`, which is bundled by esbuild (`npm run build:runner`). Communication is over stdio: the child writes newline-delimited JSON events (`log`, `diff`, `complete`, `error`, `paused`, `resumed`, `waiting-for-ready`) to stdout; the parent sends control signals (`ready`, `choice`, `pause`, `resume`) to the child's stdin. The renderer talks to main over Electron IPC (`ipcMain.handle` / `ipcMain.on`), and main relays child events to the renderer via `webContents.send`.

```
Renderer (index.html)
  ↕ contextBridge / IPC
electron/main.cjs          ← Supabase auth, credits, file dialogs, CSV parse
  ↕ fork + stdio JSON
dist/electron-runner.cjs   ← built from src/electron-runner.ts
  ↕ function calls
src/runner.ts              ← orchestrates the full import flow
src/automation.ts          ← Playwright page interactions with bsiwebapp.com
src/csv-parser.ts          ← PapaParse wrapper
src/reporter.ts            ← RunSummary builder + JSON log writer
```

### BSI automation quirks

BSI uses jQuery event handlers, so standard Playwright `selectOption()` bypasses them. All `<select>` fields must be driven via `evaluate()` — set `selectedIndex` in JS, then fire both a native `change` event and a jQuery `$(el).trigger('change')`. See `keyboardSelectDropdown()` in `src/automation.ts`.

Serial number lookup has two paths: **existing** (BSI auto-populates from its DB — only fill empty fields) and **new/not-found** (all fields blank — must be filled via `fillNewSerialFields()`). The "Type" dropdown triggers an AJAX call that populates the "Length" options, so the code waits for `#LadderLength` to have more than one option before proceeding.

### Idempotent re-runs (diff mode)

Before importing, the runner scrapes all existing `#box-N` elements from the work order (`scrapeWorkOrderBoxes`), diffs them against the CSV (`diffCsvVsWorkOrder`), then presents the user with a choice: add everything, add missing boxes only, or cancel. Part-level deduplication also runs inside `addPartsToBox` — it reads the box's existing part rows and skips any CSV part that fuzzy-matches a part already there.

### Supabase

`config.json` (not committed; see `config.example.json`) holds the Supabase URL and anon key. The main process lazily creates a single `createClient` instance. Credits are consumed via the `consume_credit` RPC before the automation child is forked. After a successful run, inspections are auto-inserted into the `inspections` table (upsert on `serial_num, inspection_date`). Sessions are persisted to `~/Library/Application Support/Lia/lia-auth.json`.

SQL migrations live in `supabase/` and are safe to re-run (idempotent). Run `01_licensing.sql` first, then `02_inspections.sql`.

### CSV format

Part columns are every column that is not in the metadata set: `Row#`, `Serial #`, `Location ID`, `Brand`, `Type`, `Length`, `Description`. Quantity is encoded inline: `"(2) G13"` or `"W44 (2)"`. Brand and Type abbreviations are expanded via lookup maps in `src/automation.ts` (`BRAND_ABBREV`, `TYPE_ABBREV`).

### Cost flags

After import, `src/runner.ts` re-scrapes all boxes and flags: boxes containing PM36 with total > $90, and any box with total > $250. Thresholds are `PM36_FLAG_THRESHOLD` and `HIGH_COST_THRESHOLD` constants at the top of `runner.ts`.

### Packaging notes

`electron-builder` asarUnpacks Playwright into `app.asar.unpacked/node_modules`. The runner lives in `Resources/` (extraResources). Main sets `NODE_PATH` to the unpacked modules dir so the runner can resolve `playwright` at runtime. `config.json` is also an extraResource so it's accessible to both main and the runner.

Logs are written to `~/Documents/Lia Logs/` in the packaged app (set via `BATAVIA_LOGS_DIR` env var) and to a temp dir in dev mode.
