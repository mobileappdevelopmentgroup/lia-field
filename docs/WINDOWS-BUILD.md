# Building Lia Office for Windows

The NSIS installer cannot be built or verified from macOS. This is the procedure
for building it on a real Windows machine — a physical PC, or a Windows 11 VM
under Parallels / VMware Fusion / UTM. On Apple Silicon an ARM Windows VM is
fine: electron-builder downloads prebuilt Electron binaries per architecture
rather than compiling, so it still emits the x64 installer.

> ⚠️ As of 2026-07-29 this build has **never been run**. Treat the first attempt
> as unproven and expect to debug.

## 1. Install prerequisites

Open **PowerShell as Administrator** and use winget:

```powershell
winget install -e --id Git.Git
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Google.Chrome
```

Close and reopen PowerShell so `PATH` picks up the new tools, then confirm:

```powershell
node --version    # expect v20.x or v22.x
npm --version
git --version
```

Chrome is needed to *run* Lia, not to build it — the automation launches system
Chrome via Playwright's `channel: 'chrome'` (`src/automation.ts:722`), so there
is no Playwright browser download step. Skip it if you are only building.

## 2. Clone

```powershell
cd $HOME
git clone https://github.com/mobileappdevelopmentgroup/lia-field.git
cd lia-field
```

Private repo — Git will prompt for GitHub credentials. Sign in as
**mobileappdevelopmentgroup**; the `hectorahinojosa1` account has pull-only
rights, which is enough to clone but not to push.

## 3. Install dependencies

```powershell
npm ci
```

Uses `package-lock.json` for an exact install. Takes a few minutes — Electron
and Playwright are large.

## 4. Create `config.json`

`config.json` is gitignored, so it is **not** in the clone. The build fails
without it. Create it in the repo root:

```powershell
@'
{
  "supabase": {
    "url": "https://bqoxpbjtqwicurmuxueq.supabase.co",
    "anonKey": "sb_publishable_WgGGcm9a-sJFt-9kpaWwAg_Rm-ft5Nj"
  }
}
'@ | Set-Content -Encoding utf8 config.json
```

That anon key is a publishable browser-side identifier already deployed on the
public inspection site — it is not a secret. See `CLAUDE.md` → Security TODOs.

Verify it parses:

```powershell
node -e "JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('config OK')"
```

## 5. Check before building

```powershell
npm run typecheck
npx tsx --test src/verify.test.ts
```

Do **not** use `npm test` here. It globs `src/*.test.ts`, and npm runs scripts
through `cmd.exe` on Windows, which does not expand globs — tsx would receive
the literal pattern and fail. The CI workflow works around this by running the
step under bash.

## 6. Build

```powershell
npm run electron:build:win
```

This runs esbuild on the runner (`build:runner`), then `electron-builder --win
nsis` for both x64 and arm64. Output lands in `dist\`:

- `Lia Setup <version>.exe` — the installer
- `latest.yml`, `*.blockmap` — updater metadata

## 7. Verify

Run the installer. It is a non-one-click NSIS installer, so you get a real
wizard with a choosable install directory, a desktop shortcut and a Start Menu
entry (`build.nsis` in `package.json`).

**Unsigned builds trip SmartScreen** — "Windows protected your PC." Click *More
info* → *Run anyway*. That is expected until a code-signing certificate exists,
and it is the single best reason to get one before shipping to anyone outside
the team.

Then smoke-test the app itself: sign in, confirm the credit count loads, load a
ladder CSV and check the preview renders. That exercises Supabase auth, the
`get_my_profile` RPC and the CSV path.

## Code signing

Once a certificate exists, electron-builder picks it up from environment
variables — no code change needed:

```powershell
$env:CSC_LINK = "C:\path\to\cert.pfx"
$env:CSC_KEY_PASSWORD = "<password>"
npm run electron:build:win
```

⚠️ Since June 2023 the CA/Browser Forum requires OV code-signing keys to live on
a hardware token or cloud HSM, so a plain `.pfx` may not be an option. If the
certificate arrives on a USB token, signing **must** happen on this machine with
the token attached — a GitHub-hosted runner cannot reach it, and the CI path
becomes unsigned-builds-only. If it is a cloud HSM (Azure Trusted Signing,
DigiCert KeyLocker), CI can sign and is the better long-term home.

## The CI alternative

`.github/workflows/build-windows.yml` does all of the above on a GitHub-hosted
Windows runner. It needs the `LIA_CONFIG_JSON` repo secret (the full body of
`config.json`) or it fails fast by design. Trigger it with **Actions → Build Lia
Office (Windows) → Run workflow**, or:

```bash
gh auth switch --user mobileappdevelopmentgroup
gh secret set LIA_CONFIG_JSON < config.json
gh workflow run build-windows.yml -f ref=master
gh auth switch --user hectorahinojosa1
```

CI gets you an installer without owning a Windows machine, but you still need
Windows to verify it. Local and CI are not exclusive — use whichever fits, and
let the certificate's delivery format decide the long-term answer.
