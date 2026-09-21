# The queue

Everything agreed and not yet finished, in the order it is being done. Updated
as things land; delete a line when it ships rather than ticking it, so this
stays a list of work rather than a changelog. `STATUS.md` is the changelog.

Last reviewed 2026-09-21.

---

## Released as 1.12.0 — Android vc10, iOS build 11, all three desktop builds

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

Also in it: the phone carries all 1,936 BSI part numbers with descriptions,
merged behind whatever the tech already had; and Lia Office's home screen is
the new one, with Field Work and Advanced.

Deliverables are in `~/Desktop/Lia-Deliverables/`.

---

## 1. Migrations 26 and 27 — written and tested, NOT applied

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

`supabase/migrations/27_shared_parts_catalog.sql`:

* `account_parts` + `save_account_parts` + `account_parts_catalog(p_since)` —
  the lead's own parts list, flowing DOWN the umbrella like every other
  catalogue. Removals are tombstoned, because a phone that has been in a
  basement for a week has to be told a part went.

**Apply both, then update `CLAUDE.md`'s migration state.** Until then Field
Work and the shared catalogue do not work; everything else in 1.12.0 does.

## 2. Fall protection billing, rebuilt on the real model

**One box per work order, always.** Serial is `1111` + the work order number.
Ladder Type `Other`, Description `Fall Protection`, Information `Other`. Items
become parts by type with the quantity as the count.

`src/core/fp-bsi.ts` builds one box per item and is wrong at the premise; its
tests pass because they check it against itself. `FP_FORM` and the preflight in
`src/fp-automation.ts` are guesses against a form that does not exist. This
deletes more than it adds.

The derived serial means the existing diff catches the box on a re-run, so
double-billing is preventable — the open question in `CLAUDE.md` is answered.

Eight of the fourteen equipment types map by name; **six are deliberately
unmapped** and stay that way until the office knows what they bill as — see
`docs/BSI-FORM.md`. They remain fully inspectable. The push must **name** the
items it cannot bill rather than dropping them: *"3 items on this work order
have no billing code — they were inspected and are not on this invoice."*

## 3. Later, and deliberately not now

* **Drive `#BoxLaderInfoEdit`** so a correction can be pushed to a box already
  in BSI, and `needs_bsi_edit` clears itself.
* **Estimating in Lia Office** from materials/labor, priced per customer type —
  a part number alone does not identify a price, the pair does.
* Windows code-signing certificate; installers stay unsigned until then.
* NFC hardware testing.
