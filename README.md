# Lia — Ladder Import Assistant

Lia is an internal toolset for Batavia ladder repair operations. It has three parts:

- **Lia Office** — macOS Electron app for importing ladder CSVs into BSI and logging inspections
- **Lia Field** — Progressive Web App (PWA) for field techs to track parts and log jobs offline
- **Ladder Inspection Site** — Static website for looking up inspection certificates by serial number or work order

---

## Lia Office (Electron App)

### What it does
- **Office Mode**: Loads a ladder CSV, opens BSI in a browser, and automates the work order import. Deducts a credit per import from Supabase.
- **Log Inspections**: Imports a CSV of past inspection records into the Supabase database (upserts — re-importing updates existing records, won't duplicate).

### Setup

1. Copy `config.example.json` → `config.json` and fill in your Supabase URL and anon key:
   ```json
   {
     "supabase": {
       "url": "https://your-project.supabase.co",
       "anonKey": "your-anon-key"
     }
   }
   ```
2. Run the SQL migrations in `supabase/01_licensing.sql` then `supabase/02_inspections.sql` via the Supabase SQL editor (safe to re-run).
3. Install the DMG from `dist/Lia-x.x.x-arm64.dmg`.

### Building

```bash
npm install
npm run electron:build   # builds DMG → dist/
```

### Inspection CSV format

| Column | Required | Notes |
|--------|----------|-------|
| Serial # | ✅ | |
| Inspection Date | ✅ | YYYY-MM-DD |
| Tech Name | | Falls back to the UI input field |
| Work Order # | | |
| Next Due Date | | YYYY-MM-DD. Falls back to the UI date picker (default: 1 year from last inspection) |
| Notes | | |
| Brand | | e.g. LG |
| Type | | e.g. Ext |
| Length | | e.g. 28 |

---

## Lia Field (PWA)

Hosted on GitHub Pages: **https://mobileappdevelopmentgroup.github.io/lia-field/**

Field techs open this in their phone browser and tap "Add to Home Screen" for offline use. No login required. Data is stored locally on the device.

Source: `field-app/`

To deploy updates:
```bash
# Push field-app/ contents to the lia-field GitHub Pages repo
```

---

## Ladder Inspection Site

Hosted on AWS: **https://d1uwg2boqwq3l6.cloudfront.net** (HTTPS via CloudFront → S3)

Lookup by serial number or work order. Shows a color-coded inspection certificate with SVG seal. Works on phone — includes barcode scanner.

Source: `inspection-site/index.html`

To deploy updates:
```bash
aws s3 cp inspection-site/index.html s3://batavia-ladder-inspections/index.html \
  --content-type "text/html" --cache-control "no-cache"
```

---

## Supabase

- **`supabase/01_licensing.sql`** — User accounts, credits, `consume_credit` and `get_my_profile` RPC functions
- **`supabase/02_inspections.sql`** — Inspections table, RLS policies, `ladder_inspections_public` view

Both files are idempotent (safe to re-run).

The `inspections` table has a unique constraint on `(serial_num, inspection_date)`. Uploading the same record again updates the fields that have new data — it won't create duplicates.

---

## Project Structure

```
electron/          Lia Office renderer + main process + preload
field-app/         Lia Field PWA (HTML, service worker)
inspection-site/   Ladder Inspection static site
src/               Playwright automation (BSI importer, CSV parser)
supabase/          SQL migrations
scripts/           electron-builder afterPack script
build/             App icon (icon.icns)
config.json        Supabase credentials (not committed)
```
