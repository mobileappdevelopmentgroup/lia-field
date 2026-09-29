# Deviations from the approved plan

Everything here is a place I did something other than what the plan said, or
made a call the plan did not cover. Nothing was skipped silently.

Ordered by how much they matter.

---

## 1. A safety decision was removed from the merge UI

**Plan:** conflicts are surfaced with both values, "pre-selected to the
rule-based winner", for the lead to choose.

**Built:** the same — except the overall **pass/fail is not offered as a
choice at all**.

**Why:** building it as specified put "pass" in front of the lead as a one-click
option on an item another tech had condemned. A FAIL beating a PASS is a safety
rule, not a default. It is still reported on the row and in the warnings; it is
just not something to pick. `merge.ts` excludes `overallPass` from conflicts and
a test asserts no true/false option is ever rendered.

**Decided 2026-08-24 — kept as built.** You asked me to call it, so: the merge
UI does not offer overall pass/fail as a choice, and should not.

A conflict picker exists to resolve disagreements of *fact* — two techs typing
different lengths, different manufacture dates. Pass/fail is not a disagreement
of fact. One tech looked at the equipment and condemned it. Rendering that as a
two-option toggle beside "pass" invites a lead under schedule pressure to click
the convenient one, and the whole point of the condemn flow — photo required,
reason composed from the failed checks rather than typed — is that the failure
is evidence, not opinion. A UI that lets one click overturn it makes the rest
of that ceremony decorative.

The FAIL still surfaces: on the row, in the warnings, and in the composed
reason. What is missing is only the ability to silently flip it, and that
absence is the feature. If a condemnation is genuinely wrong, the fix is a new
inspection with its own evidence and its own author — which the versioned
schema already supports and which leaves an audit trail. Overriding in the
merge screen would leave none.

`merge.ts` excludes `overallPass` from conflicts and a test asserts no
true/false option is ever rendered. Reversible in one line if a real job ever
demands it — but it should take a deliberate decision, not a default.

## 2. The condemn screen asks for a photo, not a reason

**Plan:** "a photo plus a reason are required".

**Built:** a photo is required. The reason is **composed from the checks that
failed**, server-side, and a client cannot override it. A free-text note is
offered and never demanded.

**Why:** your instruction during the work — the failed check already answers
"why", so retyping it is friction that also lets the certificate disagree with
the checks.

## 3. Fall protection status is stored and derived

**Plan:** a `status` column.

**Built:** `status` holds what the tech asserted (`pass` / `fail` /
`inspection overdue`), and `fp_effective_status()` derives what is true *today*.
The certificate shows the derived one.

**Why:** "inspection overdue" is a function of the calendar. A stored value goes
stale on its own — an item recorded as `pass` becomes overdue with nobody
touching it. Storing only the assertion would make certificates wrong; storing
only the derivation would lose what the tech actually found.

## 4. The certificate URL is derived, never entered

**Plan:** `url` listed as a per-item field the tech captures.

**Built:** generated from `public_ref` by `certificate_url()`.

**Why:** you confirmed it is the address written onto the tag. Deriving it means
a tag can never point at something that does not resolve, and removes a field
from the form.

## 5. Rep number is an account attribute, not a per-item field

**Plan:** listed among the per-item fields.

**Built:** stored on the lead's membership, resolved server-side, and snapshotted
onto each inspection. A device cannot claim a different one.

**Why:** you confirmed it identifies the responsible lead. Entering it per item
would be fifty chances to typo one number, and would let a device assert
somebody else's.

## 6. The field app is not one file

**Plan:** split `field-app/index.html` into modules as part of the sync phase.

**Built:** done, and earlier than planned — before the capture UI rather than
alongside sync. 2,632 lines to 692, plus twelve modules.

**Why:** capture, sync, NFC and photos all land in that file. Splitting first
meant writing them into a structure rather than into a wall.

## 7. Sync config is fetched, not baked in

**Plan:** did not say.

**Built:** `config.json` fetched at runtime; a build without one is local-only
rather than broken.

**Why:** the same bundle then works configured or not, and no key is baked into
a committed file.

## 8. The CSP origin comes from config, not a hardcoded literal

**Plan:** "add the project origin explicitly".

**Built:** `sync-www.sh` reads it from `config.json` (or `LIA_SUPABASE_URL`) and
prints which origin it allowed.

**Why:** a hardcoded origin silently ships the wrong CSP the moment a staging
build is made. A test asserts all three bundles name a supabase.co origin.

## 9. `showScreen` is DOM-derived

**Plan:** flagged as a "cheap exception" worth doing.

**Built:** done — it was two places that could drift, and I added two screens.

## 10. Tests exist that the plan did not ask for

**Plan:** "no automated tests… every phase is verified by hand".

**Built:** 30 unit, 113 field-browser, 34 desktop-browser, 170 SQL.

**Why:** the SQL suite in particular. Migrations that restructure live credit
balances and inspection history are not something to hand-verify once. It has
already caught four bugs that would have shipped — the `now()` delta bug, the
non-deterministic ownership backfill, the truthy-`{}` cache miss, and the
checklist wipe.

Hand verification is still required for everything touching BSI or real
hardware, and those are listed in STATUS.md.
