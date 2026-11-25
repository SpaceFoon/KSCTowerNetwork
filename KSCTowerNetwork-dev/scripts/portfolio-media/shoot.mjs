// Screenshots the Flightwall preview's portfolio capture mode. capture.sh runs
// this inside the pinned Playwright image so every machine renders the same
// fonts and bytes.
//
//   node shoot.mjs <web-origin> <out-dir>
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [origin, outDir] = process.argv.slice(2);
if (!origin || !outDir) {
  console.error("usage: node shoot.mjs <web-origin> <out-dir>");
  process.exit(2);
}

// A fixed instant; the sweep angle in the shot follows from it and RUN_MS.
const START_MS = Date.UTC(2026, 0, 15, 18, 0, 0);
// Three full 2.8 s sweeps, so every return has been painted at least once,
// stopping with the beam just west of south, as in the original shot.
const RUN_MS = 3 * 2800 + 1610;

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "no-preference",
    locale: "en-US",
    timezoneId: "UTC"
  });
  const page = await context.newPage();
  // No backend runs here: every API call (the saved craft thumbnail) gets a
  // plain 404, which the card shows as its missing-photo state.
  await page.route("**/v1/**", (route) => route.fulfill({ status: 404, body: "" }));
  await page.clock.install({ time: START_MS });
  await page.clock.pauseAt(START_MS + 1);
  await page.goto(`${origin}/flightwall-preview.html?capture=portfolio`, { waitUntil: "networkidle" });
  await page.getByText("Waiting for craft photo").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.clock.runFor(RUN_MS);
  await page.screenshot({ path: join(outDir, "tower-flightwall.jpg"), type: "jpeg", quality: 90 });
} finally {
  await browser.close();
}
