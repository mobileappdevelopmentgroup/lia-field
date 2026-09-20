# Releasing Lia — the commands that actually work

Written on 2026-08-30 while shipping **1.7.0 / iOS build 5 / Android
versionCode 4**, immediately after running them. Every command below was run and
its result checked; the traps are ones that were actually hit, not anticipated.

`docs/SHIP-RUNBOOK.md` is the migration story. This is the app story.

---

## 0. Before anything

```bash
npm run typecheck && npm test && npm run test:field && npm run test:desktop
npm run test:sql          # needs a local Postgres
npm run sync:www          # MUST run after any field-app/ change
npm run check:www         # fails if a bundle is behind
```

`check:www` is not optional. The three Capacitor bundles are what the store
builds actually ship, they are gitignored (Capacitor's own `.gitignore`s), and
they had previously drifted by weeks without anyone noticing.

## 1. Get the next build number from Apple — do not guess

CLAUDE.md says not to increment blindly, and it is right: the iOS project's
`CURRENT_PROJECT_VERSION` was already at 4 while build 4 was live, so a blind
bump would have collided.

```bash
node - <<'JS'
import crypto from 'crypto'; import fs from 'fs';
const KEY_ID='PZ4S957TFC', ISS='bb930b75-3879-4b39-94d1-5352ffad59d8', APP='6778643426';
const key=fs.readFileSync(process.env.HOME+'/.appstoreconnect/private_keys/AuthKey_'+KEY_ID+'.p8','utf8');
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url'); const now=Math.floor(Date.now()/1e3);
const h=b64({alg:'ES256',kid:KEY_ID,typ:'JWT'}), p=b64({iss:ISS,iat:now,exp:now+600,aud:'appstoreconnect-v1'});
const s=crypto.sign('sha256',Buffer.from(h+'.'+p),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
const r=await fetch(`https://api.appstoreconnect.apple.com/v1/builds?filter[app]=${APP}&sort=-version&limit=5`,
  {headers:{Authorization:`Bearer ${h}.${p}.${s}`}});
const d=await r.json();
console.log('next free build:', Math.max(...d.data.map(b=>+b.attributes.version))+1);
JS
```

## 2. Bump every version string — there are five

Missing one is silent. A support ticket then reports a version that was never
shipped.

| File | Field |
|---|---|
| `package.json` | `"version"` |
| `field-app/js/storage.js` | `LIA_APP_VERSION` |
| `field-app/sw.js` | `CACHE` — bump or browsers serve stale assets |
| `field-app/capacitor/android/app/build.gradle` | `versionCode` **and** `versionName` |
| `.../ios/App/App.xcodeproj/project.pbxproj` | `CURRENT_PROJECT_VERSION` and `MARKETING_VERSION` — **two sites each**, Debug and Release |

Then `npm run sync:www` again, because `storage.js` and `sw.js` just changed.

**A desktop-only build moves one string.** If nothing under `field-app/` has
changed, bump `package.json` alone: the phone app's version is what the stores
show, and moving it without shipping claims a release that never happened. The
table above is for a release that includes the phone.

## 3. Commit and push

Pushing needs the **org** account; `hectorahinojosa1` is pull-only on this repo.

```bash
gh auth switch --user mobileappdevelopmentgroup
git push -u origin <branch>
```

## 4. iOS → TestFlight

**The trap.** The project carries `CODE_SIGN_STYLE = Automatic`. Archiving with
`-allowProvisioningUpdates` makes Xcode try to create a *development* profile
and fail with:

> Your team has no devices from which to generate a provisioning profile

which reads like a certificate problem and is not. Override to manual signing on
the command line — do not edit the project, the Capacitor tooling rewrites it.

The second trap: the distribution profile carries the **`iPhone Distribution`**
identity, not `Apple Distribution`. Both are installed; using the wrong one
fails with "doesn't include signing certificate".

```bash
cd field-app/capacitor/ios/App
rm -rf build/Lia.xcarchive
xcodebuild archive \
  -project App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/Lia.xcarchive \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=9V4CNA98BB \
  PROVISIONING_PROFILE_SPECIFIER="Lia Field App Store NFC" \
  CODE_SIGN_IDENTITY="iPhone Distribution: Hector Hinojosa (9V4CNA98BB)"

xcodebuild -exportArchive -archivePath build/Lia.xcarchive \
  -exportPath build/export -exportOptionsPlist ExportOptions.plist

xcrun altool --upload-app -f build/export/App.ipa -t ios \
  --apiKey PZ4S957TFC --apiIssuer bb930b75-3879-4b39-94d1-5352ffad59d8
```

`altool` with `--apiKey` works fine. It is only the *username/password* form
that is broken in Xcode 26 — CLAUDE.md's warning is about that, not about
altool as such.

Confirm afterwards with the script in step 1; the build should read VALID.

## 5. Android → Play internal testing

```bash
cd field-app/capacitor/android
JAVA_HOME=/opt/homebrew/opt/openjdk@21 \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
./gradlew bundleRelease
# → app/build/outputs/bundle/release/app-release.aab
```

Check it is signed with the release key, not the debug one:

```bash
$JAVA_HOME/bin/jarsigner -verify -verbose:summary -certs app-release.aab | grep CN=
# CN=Hector Hinojosa, OU=Mobile App Development Group, ...
```

Then upload it:

```bash
PLAY_KEY=~/.play-keys/lia-play-publisher.json npm run play:upload -- --check
PLAY_KEY=~/.play-keys/lia-play-publisher.json npm run play:upload -- --notes "What changed"
```

`--check` proves the credential and the app permission without touching
anything: it opens a draft edit, reads the track back, and discards it. Run it
first after any permission change — a fresh grant needs a few minutes and fails
with 403 until it lands.

The tool ships to `internal` (default), `alpha` and `beta`. It refuses
`production`; that release is made in the console with the listing in view.
`--draft` uploads without rolling out. If anything fails before the commit, the
edit is discarded and nothing reaches testers.

Creating the key: Play Console → Setup → API access. `CLAUDE.md` has the
permissions to grant. Without a key, upload by hand in the Play Console.

## 6. macOS → DMG

```bash
npm run electron:build            # arm64 ONLY, despite the config listing both
npx electron-builder --mac dmg --x64   # Intel, needs its own invocation
```

`electron:build` builds only the host architecture. Both are needed, or Intel
Macs get nothing.

**The DMG is signed but NOT notarized** — "skipped macOS notarization, `notarize`
options were unable to be generated". Gatekeeper will warn on first open until
notarization credentials are configured.

---

## What a release still cannot do from here

- **Play upload** — no service-account key. By hand in the Play Console.
- **Store data declarations** — web forms in both consoles. Updated for sync on
  2026-08-24; `docs/STORE-DATA-DECLARATIONS.md` has the answers. Only needs
  touching again if a release starts sending something new.
- **macOS notarization** — needs an app-specific password or API key wired into
  electron-builder's `notarize` options.
