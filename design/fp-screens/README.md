# Fall protection capture — screen mockups

Source for the design canvas at
<https://claude.ai/code/artifact/c07c621b-6767-42c0-8900-0d2f5c90f1c1>

Static mockups, light theme (the field app's default). Matched to
`field-app/index.html` — same tokens, 50px topbar, 9.5px uppercase labels, 7px
input radii, mono serials, 44px+ hit targets.

| File | Artboard |
|---|---|
| `ItemList.dc.html` | Fall-protection job, item list |
| `Main.dc.html` | Direction A — form first |
| `VariantB.dc.html` | Direction B — checks first |
| `FailState.dc.html` | A failed check condemns the item |
| `Condemn.dc.html` | Removal from service: reason + photo |
| `canvas.json` | Layout, sticky notes, launch view |

To change anything: edit the `.dc.html` files here, re-seed, and republish to the
same URL. Do not hand-edit `lia-fall-protection-screens.html` — it is generated.

Not drawn yet: the manufacturer/model picker (mirrors the existing parts library)
and the NFC write flow, which needs its own screens.
