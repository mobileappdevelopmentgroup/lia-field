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

Tap the tag — or scan, or type — and last year's record comes up from the
device's own copy. Every check already reads Pass. The tech confirms the part
matches and taps **Pass & Next**. Two taps, nothing typed.

The record is read-only **by default, not permanently**: a stray touch cannot
rewrite last year's data on a part the tech is only confirming, but the Edit
button unlocks every field when something has genuinely changed.

A defective item is the only thing that costs more. One Fail flips the whole item
and the button becomes *Add Photo & Remove*. The tech does not type why — the
check he failed is the reason, composed server-side in
`record_fp_inspection()`. A photo is required; a note is optional.

To change anything: edit the `.dc.html` files here, re-seed, and republish to the
same URL. Do not hand-edit `lia-fall-protection-screens.html` — it is generated.

Not drawn yet: the NFC read/write sheet iOS forces (Core NFC only writes from a
foreground system sheet), and the desktop checklist-authoring screen.
