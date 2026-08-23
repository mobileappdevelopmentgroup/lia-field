# Store data declarations — the exact answers

Both stores ask what the app collects, separately from the privacy policy URL.
**Both currently say "no data collected."** That was true; it stopped being true
when sync landed.

Shipping a syncing build against a stale declaration can pull a listing — it is
a policy violation, not a paperwork problem. Update both in the same submission
as the first syncing build.

Nothing below needs a judgement call. It is written so it can be followed
straight through.

Policy URL: <https://d1uwg2boqwq3l6.cloudfront.net/privacy.html>
(source `inspection-site/privacy.html` — deploy it with the command in README.md
**before** submitting, so the reviewer sees the rewritten version)

---

## What the app actually collects

Derived from the code, not from memory — every row corresponds to something the
app really sends.

| Data | Where it comes from | Why |
|---|---|---|
| Email address | sign-in (`sync.js`) | authentication |
| Name | `get_my_profile` | shown to the lead as who submitted what |
| Rep number | `account_members.rep_number` | responsible technician on a certificate |
| Inspection records | `record_inspection` / `record_fp_inspection` | the product |
| Photos of failed equipment | `inspection_photos` | required evidence for removal from service |
| User ID / device ID | batch attribution | merging several techs on one work order |

**Not collected:** location, contacts, advertising identifiers, usage analytics,
crash reporting, browsing history, financial info. Do not tick any of them.

---

## Google Play → Data safety

App → **Policy** → **App content** → **Data safety** → *Manage*.

**1. Data collection and security**
- Does your app collect or share any of the required user data types? → **Yes**
- Is all of the user data collected by your app encrypted in transit? → **Yes**
- Do you provide a way for users to request that their data is deleted? → **Yes**

**2. Data types** — tick exactly these:

- **Personal info** → Name, Email address, User IDs
- **Photos and videos** → Photos
- **App activity** → Other user-generated content
- **Device or other IDs** → Device or other IDs

Leave every other category unticked — especially Location, Contacts, Financial
info, and App info and performance.

**3. For each ticked item**, answer identically:
- Collected: **Yes** · Shared: **No**
- Processed ephemerally: **No**
- Required or optional: **Required**
- Purpose: **App functionality** *(only this one — not Analytics, not
  Personalisation, not Advertising)*

> Shared is **No** on purpose. Supabase is a processor acting on our
> instructions; Play does not count hosting as sharing. Ticking Shared implies
> onward disclosure to third parties, which does not happen.

**4. Save**, then **Submit for review** on the App content page.

---

## Apple → App Privacy

App Store Connect → the app → **App Privacy** → *Edit*.

**Do you or your third-party partners collect data from this app?** → **Yes**

Add these types, all **Linked to You**, all **App Functionality** only, and
**not** used for tracking:

| Category | Type |
|---|---|
| Contact Info | Name |
| Contact Info | Email Address |
| User Content | Photos or Videos |
| User Content | Other User Content |
| Identifiers | User ID |
| Identifiers | Device ID |

For each: *Used for App Functionality* · *Linked to the user* · **not** used to
track.

**Data Used to Track You:** none.
**Data Not Linked to You:** none.

Do not add Location, Usage Data, Diagnostics, or Purchases.

---

## Two other blockers for that same release

Both already fixed in the repo — listed so they are not re-broken.

1. **Android `versionCode` must be ≥ 2.** versionCode 1 is permanently consumed
   by the build already in internal testing.
   `field-app/capacitor/android/app/build.gradle` still reads `versionCode 1`
   — bump it as part of the release.
2. **iOS usage strings** — done. `NSCameraUsageDescription` used to say the
   camera was for scanning barcodes; the app now also photographs failed
   equipment, and the string says so. `NFCReaderUsageDescription` has been added
   ahead of the NFC plugin.

When NFC ships it also needs the **Near Field Communication Tag Reading**
capability on the App ID and the
`com.apple.developer.nfc.readersession.formats` entitlement — see
`docs/NFC-PLUGIN.md`.
