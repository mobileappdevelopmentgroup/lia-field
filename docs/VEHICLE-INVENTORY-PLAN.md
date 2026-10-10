# Vehicle inventory — plan

Status: **proposal, nothing built.** Written 2026-10-10 for review before any
migration is drafted.

## What it is for

Each truck carries parts. The office needs to know what is on every truck, what
each one should carry, and what to load before it goes out. The tech needs to
see his own truck and correct it when he uses, finds or loads something.

Lia Office is the master. Lia Field updates only the vehicles assigned to the
person holding the phone.

## What carries over from Repair Shop Guru, and what does not

Repair Shop Guru (`repair-shop-guru.com`, `lib/services/inventory.ts`) has the
right core, and this plan keeps it:

- **An append-only ledger is the truth.** Every change is a row (`StockAdjustment`
  there, `stock_moves` here) written in the same transaction as the quantity it
  changes. There is no other way to move a quantity.
- **Negative on-hand is allowed and shown, not blocked.** It is an honest
  "recount this" signal.
- **Semantic wrappers** (receive / use / return) apply the sign themselves, so a
  caller never has to remember which direction "used" moves stock.
- **Locations as a tree** (`InventoryLocation.parentId`) — here, a truck can have
  bins or drawers under it if anybody wants them. Optional, phase 3.
- **Templates** (`InventoryTemplate`) become **load-outs**: what a truck of a
  given kind should carry.

What changes for Lia:

| Repair Shop Guru | Lia |
|---|---|
| One shop, one authoritative `Part.quantityOnHand`, locations an optional breakdown | **The vehicle is the primary place.** A quantity always belongs to a location (truck or warehouse); there is no unallocated pool |
| Cost, price, markup, vendors, reorder URLs | **No money on the phone.** Prices are Batavia's and stay in Lia Office — same rule as `parts-catalog.js` |
| Always online, server-side transactions | **Offline first.** A tech in a basement records a use; it is queued like an inspection and applied when it reaches the server |
| One tenant | **Umbrella accounts.** Batavia sees every subcontractor's trucks; a subcontractor sees only their own (`can_see`). The parts catalogue flows down as it already does |
| Reorder point per part | **Par level per part per vehicle** (or per load-out), because two trucks doing different work carry different amounts |

## Data model (migrations 34+; 33 is reserved for published part sets)

```
stock_locations    id, account_id, kind ('vehicle' | 'warehouse'), name,
                   plate / unit number, active, parent_id (bins, later)
vehicle_assignees  location_id, user_id                 -- who may update it from a phone
stock_levels       location_id, part_number, qty, par   -- qty maintained by the write path only
stock_moves        id, client_id (unique), location_id, part_number, delta,
                   reason ('load' | 'use' | 'count' | 'transfer_in' | 'transfer_out' | 'adjust'),
                   counted_qty (for 'count'), job wo_key (for 'use'), note,
                   actor, captured_at, recorded_at
loadouts           id, account_id, name; loadout_lines (part_number, par)
```

Writes go through `SECURITY DEFINER` RPCs only, as with `record_inspection()` —
no INSERT/UPDATE grants on the tables:

- `record_stock_move(p jsonb)` — the phone's one write. Refuses a location the
  caller is not assigned to. Idempotent on `client_id`, so a retried upload is
  not counted twice.
- `transfer_stock(from, to, part, qty)` — office only; writes both legs in one
  transaction.
- `set_par_levels`, `apply_loadout(location, loadout)` — office only.
- `my_vehicles()` — the phone's read: assigned vehicles, their levels and pars.
- `vehicle_stock_report()` — office: every location, below-par lines, the
  restock list per truck.

### Offline counts

A **use** or **load** is a delta and composes safely whatever order it arrives
in. A **count** is the dangerous one: "I counted 6" written offline at 9 am and
applied at 4 pm must not wipe out a load the office recorded at noon. So a count
carries `counted_qty` and its `captured_at`, and the server applies it as the
difference from what the ledger says the truck held **at that time**, not now.
Moves recorded after it stay on top. That needs to be in the SQL tests before
anything ships.

## Lia Office

- **Vehicles** screen: add a truck, name it, assign people, give it a load-out.
- **Truck detail**: every part, on hand vs par, the ledger beneath it, and the
  **restock list** (par − on hand), printable for whoever loads the truck.
- **Transfers**: warehouse → truck when a truck is loaded.
- Umbrella view: Batavia sees every sub's trucks, filtered by company.

## Lia Field

- A **My truck** screen (from the jobs list), listing what the office says is on
  it, searchable the same way as the new parts library.
- Each line: **−1 used**, **+ loaded**, and **Count** (type the number on the
  shelf). Every change is a queued `stock_move`, shown as *waiting* until the
  server has it — the same wording as every other upload.
- Below-par lines highlighted, so a tech can see he is short before he leaves.

## Decisions I need from you

1. **Should parts on a ladder record come off the truck automatically?** It is the
   biggest time saver, and the riskiest: an edited ladder is re-sent
   (`record_inspection` supersedes), so the deduction must follow the
   *difference* between versions, keyed to the inspection — or a corrected
   ladder deducts its parts twice. My recommendation: yes, but phase 2, after
   manual moves have been used for a while.
2. **Is there a warehouse/shop stock to track**, or only trucks?
3. **Par levels per truck, or per load-out with per-truck overrides?** I would do
   load-outs with overrides — fewer numbers to keep up to date.
4. **Who may change a truck from the phone** — anybody assigned, or only its lead?

## Phases

1. Schema, RPCs, SQL tests (offline counts, umbrella visibility both ways,
   idempotent retries). Office: vehicles, assignments, par levels, transfers.
2. Field: My truck, use / load / count, offline queue.
3. Load-outs, the restock report, and (if you say yes to 1) automatic
   deduction from ladder parts.
