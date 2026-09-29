// A real BSI browser that stays logged in, and that Claude can drive.
//
// The first inspector could only watch: Playwright launches Chromium on a
// debugging pipe, so nothing outside that one process can attach. This opens
// the browser with a fixed profile directory and a CDP port instead, which
// means two things:
//
//   * The session survives. Log in once; the profile keeps the cookies, so
//     later runs come back already signed in.
//   * Claude can attach over CDP from a separate script and read the page,
//     rather than waiting to be shown things.
//
// It still never types, reads or stores a credential. The profile lives
// outside the repo so nothing session-shaped can be committed.
//
//   node tools/bsi-session.mjs            # open and hold the window
//
// Then, from anywhere:  chromium.connectOverCDP('http://127.0.0.1:9222')
import { chromium } from 'playwright';
import path from 'path';
import os from 'os';

const PROFILE = process.env.BSI_PROFILE
  || path.join(os.homedir(), '.lia-bsi-profile');
const PORT = Number(process.env.BSI_CDP_PORT || 9222);
const URL  = process.argv[2] || 'https://bsiwebapp.com';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: null,
  args: [`--remote-debugging-port=${PORT}`, '--window-size=1500,1000'],
});

const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(URL).catch(() => {});

console.log(`
  BSI is open, profile at ${PROFILE}
  Attachable on http://127.0.0.1:${PORT}

  Log in if it asks. It will not ask again — the profile keeps the session.
  Leave this window open while we work; close it to end the session.
`);

await new Promise(() => {});   // hold the window open
