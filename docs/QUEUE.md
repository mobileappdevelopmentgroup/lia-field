# The queue

Everything agreed and not yet finished, in the order it is being done. Updated
as things land; delete a line when it ships rather than ticking it, so this
stays a list of work rather than a changelog. `STATUS.md` is the changelog.

Last reviewed 2026-09-21.

---

## Shipped today, not yet released

Committed on `fall-protection`, waiting on a build going out:

* Suggestion lists drop **down**, and flip up only when measured to not fit —
  against `visualViewport`, so the keyboard counts as taking up room.
* **Save CSV works on Android.** It did nothing at all before: the WebView has
  neither the Web Share API nor a download manager, so both routes the code
  relied on were silent no-ops.
* The **greeting is no longer sheared off** the top of Lia Office, on either
  platform.
* **The four ladder checkboxes are ticked in BSI** — `#ChckAddLeveler`,
  `#ChckAddClaw`, `#ChckAddVbar`, `#ChckAddPropLube`. They had never been
  wired up at all. In use from next week.

Version is **1.12.0**; Android **versionCode 10** is built and not uploaded.
iOS and the desktop builds are not cut yet.

---

## 1. The parts catalogue on the phone

1,936 distinct part numbers pulled from BSI, about 75 KB with descriptions.
Seeds the field app's library, merged into an existing install rather than
replacing it — a tech's own favourites and their order survive.

Descriptions are new to the app: the library and the autocomplete currently
show a bare part number.

**Prices stay out.** Materials and labor are Batavia's pricing; they are for
estimating in Lia Office and do not belong on a handset or in a git history.

## 2. Migration 26 — written, not tested, not applied

`supabase/migrations/26_field_work.sql`:

* `inspections.bsi_pushed_at` / `bsi_box_ref` — ladders had no record of having
  reached BSI, and `usage_log` is not a substitute because it is per work order
  and cannot see three ladders added after the import.
* `amend_inspection` / `delete_inspection` / `restore_inspection` +
  `inspection_audit` — the ladder correction path, which did not exist. Fall
  protection has had one since 15.
* `require_lead_account()` — lead check that follows an impersonation session,
  unlike `require_lead()`.
* `work_orders.archived_at` + `set_work_order_archived`.
* `field_work_orders(p_archived)` — one row per work order with the state
  **derived**, never stored.

Then: `npm run test:sql`, write `supabase/test/17_field_work_test.sql`,
`npm run schema`, apply, update `CLAUDE.md`'s migration state.

## 3. Lia Office — the home screen

| Was | Becomes |
|---|---|
| Office Mode | **Import CSVs Manually** |
| Merge Field Work + FP Records | **Field Work** |
| Job Board | **Work Order Assigning** |
| Fall Protection | **Catalog** |
| Log Inspections, Certificate Views, certificate lookup | under **Advanced** |

## 4. Field Work

One list of work orders carrying field records, processed and not.

* **Green** — every current record is in BSI. **Orange** — edits outstanding.
  Neutral — never processed. The label says which, with the date.
* Full edit rights: the lead can correct any record, with a typed reason.
* **Archive** files it away to Work History. Work History is **read-only** and
  can **unarchive** back, keeping its processed-on date.
* Start a BSI import from here, the same as from Import CSVs Manually.

A record corrected *after* it was pushed is its own state, `needs_bsi_edit`.
Re-running will not clear it, because the importer only adds boxes BSI does not
have. BSI does have an edit form (`#BoxLaderInfoEdit`), so this is automatable
later — see §7.

## 5. Sharing a catalogue

The lead builds their ladder-parts and fall-protection catalogue in Lia Office
and pushes it to their techs, replacing the seed shipped in the app.

A tech's own added parts and their favourites layer on top and survive an
update. Pushing a catalogue must not wipe the favourites a tech arranged for
their own hands.

## 6. Fall protection billing, rebuilt on the real model

**One box per work order, always.** Serial is `1111` + the work order number.
Ladder Type `Other`, Description `Fall Protection`, Information `Other`. Items
become parts by type with the quantity as the count.

`src/core/fp-bsi.ts` builds one box per item and is wrong at the premise; its
tests pass because they check it against itself. `FP_FORM` and the preflight in
`src/fp-automation.ts` are guesses against a form that does not exist. This
deletes more than it adds.

The derived serial means the existing diff catches the box on a re-run, so
double-billing is preventable — the open question in `CLAUDE.md` is answered.

**Blocked on the office:** nine part codes (FP1–FP9) against fourteen
equipment types. The mapping is a billing decision, not something to infer.

## 7. Later, and deliberately not now

* **Drive `#BoxLaderInfoEdit`** so a correction can be pushed to a box already
  in BSI, and `needs_bsi_edit` clears itself.
* **Estimating in Lia Office** from materials/labor, priced per customer type —
  a part number alone does not identify a price, the pair does.
* Windows code-signing certificate; installers stay unsigned until then.
* NFC hardware testing.
