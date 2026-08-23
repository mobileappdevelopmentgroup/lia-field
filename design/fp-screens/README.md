# Fall protection capture — screen mockups

Source for the design canvas at
<https://claude.ai/code/artifact/c07c621b-6767-42c0-8900-0d2f5c90f1c1>

Static mockups, light theme (the field app's default). Matched to
`field-app/index.html` — same tokens, 50px topbar, 9.5px uppercase labels, 7px
input radii, mono serials, 44px+ hit targets.

| File | Artboard |
|---|---|
| `Main.dc.html` | Inspect — the two-tap path |
| `FailState.dc.html` | One check failed |
| `Condemn.dc.html` | Removal from service: reason + photo |
| `NewItem.dc.html` | Tag with no record yet — the only screen with inputs |
| `ItemList.dc.html` | Fall-protection job, item list |
| `canvas.json` | Layout, sticky notes, launch view |

## The interaction this is built around

Tap the tag → last year's record comes up from the device's own copy, read-only →
every check already reads Pass → the tech confirms the part matches and taps
**Pass & Next**. Two taps, nothing typed.

The identity block is deliberately read-only rather than input fields: a stray
touch on a form field would edit last year's data on a part the tech is only
confirming.

A defective item is the only thing that costs more. Tapping Fail on any one check
flips the whole item to FAIL and turns the button into *Why?*, which requires a
reason and a photo — the same rule the database enforces.

To change anything: edit the `.dc.html` files here, re-seed, and republish to the
same URL. Do not hand-edit `lia-fall-protection-screens.html` — it is generated.

Not drawn yet: the NFC read/write sheet iOS forces (Core NFC only writes from a
foreground system sheet), and the desktop checklist-authoring screen.
