# Store data declarations — must match the privacy policy

Both stores ask what the app collects, separately from the privacy policy URL.
Right now **both say "no data collected"**, which was true and is not any more.

Shipping a syncing build against a "no data collected" declaration is a policy
violation that can pull a listing — it is not a stale-document problem. Update
both in the same submission as the first syncing build.

Policy: <https://d1uwg2boqwq3l6.cloudfront.net/privacy.html>
(source `inspection-site/privacy.html`; deploy with the command in README.md)

## What Lia Field actually collects

| Data | Why | Linked to identity? | Tracking? |
|---|---|---|---|
| Email address | Sign-in | Yes | No |
| Name | Shown to the lead tech as who submitted what | Yes | No |
| Rep number | Identifies the responsible technician on a certificate | Yes | No |
| Photos of condemned equipment | Required evidence for removal from service | Yes | No |
| Inspection records (serials, WO numbers, dates, results, notes) | The product | Yes | No |
| Device identifier | Merging several techs' captures on one work order | Yes | No |

Not collected: location/GPS, contacts, advertising identifiers, usage analytics,
crash reporting, browsing history.

## Google Play → Data safety

- Data is collected: **Yes**. Data is shared with third parties: **No**
  (Supabase is a processor, not a recipient — Play does not count hosting as sharing).
- Encrypted in transit: **Yes**. Users can request deletion: **Yes**.
- Categories to declare:
  - Personal info → **Name**, **Email address**, **User IDs** — App functionality, Required
  - Photos and videos → **Photos** — App functionality, Required
  - App activity → **Other user-generated content** (inspection records) — App functionality, Required
- Do **not** tick Location, Contacts, or Financial info.

## Apple → App Privacy

- Data Used to Track You: **None**.
- Data Linked to You: **Contact Info** (name, email), **User Content** (photos,
  inspection records), **Identifiers** (user ID, device ID) — all for
  *App Functionality*.
- Data Not Linked to You: none.
- Do **not** declare Location or Usage Data.

## Also needed for the first syncing build

- Android `versionCode` must be **2 or higher** — 1 is permanently consumed
  (`field-app/capacitor/android/app/build.gradle`).
- iOS needs `NSCameraUsageDescription` broadened: it currently says the camera is
  for scanning barcodes, and the app now also takes evidence photographs.
- NFC, when it ships, needs `NFCReaderUsageDescription` on iOS and the
  `com.apple.developer.nfc.readersession.formats` entitlement.
