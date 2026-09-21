# The BSI form, as it actually is

Read off a live work order on 2026-09-21 — work order 97320 for the ladder
side, 98471 for fall protection. Everything here was observed, not inferred.
Where this contradicts a comment in the code, this is right and the comment is
the guess it replaces.

Re-read it with `tools/bsi-session.mjs` (holds a logged-in browser open, profile
at `~/.lia-bsi-profile`, outside the repo) and `tools/bsi-probe.mjs` (attaches
over CDP, read-only). Neither types, reads or stores a credential.

## The page

`https://bsiwebapp.com/order/<n>/` — jQuery **3.7.1**. Existing boxes are
`#box-1 … #box-N`, numbered with gaps where boxes were deleted, so never assume
the count matches the highest number.

Per-box fields, suffixed with the box number: `#boxserialnumberh-N`,
`#pladder-N` (Ladder Type), `#pladderdes-N` (Description), `#pladderi-N`
(Information).

## Adding a box

All of these live in the panel `#collapseLadder`.

| Control | What it is | How it is driven |
|---|---|---|
| `#LadderBrand` | Brand, 14 options | select + jQuery `change` |
| `#WoLadType` | Ladder Type, 13 options | select + jQuery `change`; **its change fires the AJAX that fills Length** |
| `#LadderLength` | Length — 1 option until Type is set | select; **no handler of its own** |
| `#WoLadDesc` | Description | select |
| `#ChckAddLeveler` | "L" | **click** |
| `#ChckAddClaw` | "C" | **click** |
| `#ChckAddVbar` | "V" — we call it V-Rung | **click** |
| `#ChckAddPropLube` | "P" | **click** |

**The selects and the checkboxes are driven differently, and it matters.**

The selects are bound to `change`, and Playwright's `selectOption()` does not
run jQuery's handler — hence `keyboardSelectDropdown()`, which sets
`selectedIndex` under `evaluate()` and fires both a native event and
`$(el).trigger('change')`.

The four checkboxes are bound to **`click`**. Doing the select trick to one of
them sets `.checked` and runs none of BSI's code: ticked on screen, nothing
saved. They have to be really clicked — `locator.check()`, which is also a
no-op when the box is already ticked. That last part is load-bearing: with a
click handler, "click it again to be sure" unticks the thing you meant to set.

Flags are **ticked and never unticked**. `null` means the tech did not assess
it, which is not "no"; and on a serial BSI already knows, unticking discards
what BSI holds because a field happened to be blank.

## Editing a box that is already there

There is a second set, hidden until a box is opened for editing, in the panel
`#BoxLaderInfoEdit`: `#UpBoxBrand`, `#ChckUpAddLeveler`, `#ChckUpAddClaw`,
`#ChckUpAddVbar`, `#ChckUpAddPropLube`.

**So BSI can be corrected through the UI.** Nothing drives this yet — the
importer only adds boxes BSI does not have — but a record corrected after it
was pushed is a not-yet-automated case, not an unfixable one. The office screen
calls that state `needs_bsi_edit`.

## Fall protection is the same form

Not a separate form, not a separate flow. **One box per work order, always**
(confirmed with the office). The items do not each get a box; they are
collapsed into parts by type, with the quantity carrying the count.

Work order 98471, in full:

| Field | Value |
|---|---|
| Serial Number | `111198471` — literal `1111` + the work order number |
| Ladder Type | `Other` |
| Description | `Fall Protection` |
| Information | `Other` |

| Part | Description | Unit mat. | Unit lab. | Qty |
|---|---|---|---|---|
| FP1 | Body harness inspection | 11.00 | 11.00 | 22 |
| FP2 | Lanyard inspection | 5.50 | 5.50 | 33 |
| FP3 | SRL inspection | 13.50 | 13.50 | 12 |
| FP4 | Climbing belt inspection | 7.00 | 7.00 | 18 |
| FP7 | Positioning strap | 5.50 | 5.50 | 14 |

### The whole fall protection price list

Pulled from the product catalogue, so this is all of them rather than the five
that happened to be on one work order:

| Part | Description | Materials | Labor |
|---|---|---|---|
| FP1 | Body harness inspection | 11.00 | 11.00 |
| FP2 | Lanyard inspection | 5.50 | 5.50 |
| FP3 | SRL inspection | 13.50 | 13.50 |
| FP4 | Climbing belt inspection | 7.00 | 7.00 |
| FP5 | Anchorage inspection | 5.50 | 5.50 |
| FP6 | Pole climbing device | 11.00 | 11.00 |
| FP7 | Positioning strap | 5.50 | 5.50 |
| FP8 | Self rescue device | 11.00 | 11.00 |
| FP9 | Self rescue device w bag | 16.00 | 16.00 |

### Which equipment type bills as which code

Eight match by name and were confirmed with the office. **Six are deliberately
unmapped** — the office does not yet know what they bill as, and a guessed code
bills a customer the wrong amount silently and consistently, which nobody
notices until an audit.

| Equipment type | Code |
|---|---|
| Body harness | FP1 |
| Lanyard | FP2 |
| SRL (self-retracting lifeline) | FP3 |
| Climbing belt | FP4 |
| Pole climbing device | FP6 |
| Positioning strap | FP7 |
| Self rescue device | FP8 |
| Self rescue with bag | FP9 |
| Crane lift sling | — |
| Tie off adaptor | — |
| Rescue device — R550 | — |
| Temporary horizontal lifeline | — |
| Vertical lifelines and fall arresters | — |
| Positioning lanyard | — |

FP5 (*Anchorage inspection*) is not yet claimed by any type.

**Unmapped does not mean uninspectable.** All fourteen stay in the catalogue
with their checklists. They are recorded, they appear on certificates, and they
simply do not become a BSI line until a code is known — the push must **name
them on screen** rather than drop them: *"3 items on this work order have no
billing code — they were inspected and are not on this invoice."* With nine
codes against fourteen types that case exists regardless, so it is handled
rather than designed around.

Taking the six out of the catalogue instead was considered and rejected: there
is no write path to `fp_equipment_types` for a field tech (the three that exist
are the seed, the lead-gated checklist fork at `schema.sql:3450`, and account
setup), and the field app's type field is a `<select>` with no free text. A tech
meeting a crane lift sling would have had nothing to pick and no way to record
it.

### Two consequences

**The serial is derived, so re-runs are safe.** `1111` + the work order number
is deterministic, which means the existing serial-based diff finds the box on a
second run and will not add a duplicate. This was the open question about
aggregate fall-protection boxes and double-billing; it is answered.

**`src/core/fp-bsi.ts` is wrong at the premise.** It builds one box per
inspected item, each carrying its own serial. Its unit tests pass and always
would have — they check that the mapping is internally consistent, never that
it matches BSI. `FP_FORM` in `src/fp-automation.ts` and the preflight that
refuses to run are guesses against a form that does not exist. Rebuilding this
deletes more than it adds.

## The product catalogue

`tools/bsi-products.mjs` pulls the whole price list through the table's own
server-side endpoint (`/modules/products/list/show-products.php`) rather than
scraping 444 pages of HTML. It is read-only.

**11,079 rows, but only 1,936 distinct part numbers.** The rest is the same
part priced per customer type — 23 of them, `CD5`, `PKG1`…`PKG5`, `BBB`, `RK5`
and so on. A part number alone does not identify a price; the pair does. Any
code that collapses on part number is silently picking one customer's price
for another customer's job.

The endpoint refuses some windows, answering a JSON request with a PHP warning.
The puller halves a failed window and retries, down to single rows, and records
whatever will genuinely not come back in `missingRows`. The last run got
**11,077 of 11,079**, with 2 rows the server would not return at any window
size. A file that quietly stopped at 8,000 and looked finished is the failure
mode being avoided.

### Where the data goes

Split on sensitivity, which also happens to be the split the office asked for:

* **Part number and description — 1,936 entries, about 75 KB of JSON** — is what
  the field app needs, and is small enough to ship to a phone without thinking
  about it. No prices.
* **Materials and labor** stay out of the repo and out of anything installed on
  a handset. They are for estimating in Lia Office, and they are Batavia's
  pricing, not something to commit to a git history or hand to a device that
  gets left in a van.

So the raw pull is **not committed**. Regenerate it with the tool when it is
needed; the catalogue the app ships is derived from it.
