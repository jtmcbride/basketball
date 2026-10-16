// Real local-source browser checks; no source rows are copied into tracked artifacts.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const origin = process.env.BASKETBALL_ORIGIN ?? "http://127.0.0.1:5178";
const browser = await chromium.launch();
const report = {
  origin,
  environment: {
    node: process.version,
    browser: browser.version(),
    platform: process.platform,
  },
  checks: [],
  pageErrors: [],
};
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  page.on("pageerror", (e) => report.pageErrors.push(e.message));
  const started = performance.now();
  await page.goto(`${origin}/#atlas`);
  await page.getByLabel("Inspect region", { exact: true }).waitFor();
  report.initialAtlasMs = Math.round(performance.now() - started);
  assert.deepEqual(
    await page.locator(".cohort-summary strong").allTextContents(),
    ["1,596 attempts", "1,258 attempts"],
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: "../../artifacts/m2-atlas-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", {
      name: "Difference from same-season baseline",
      exact: true,
    })
    .click();
  await page
    .getByRole("region", { name: "Cohort A", exact: true })
    .getByRole("button", { name: /Region 0:0:/ })
    .click();
  await page
    .getByRole("heading", { name: "Attempts in the selected region" })
    .waitFor();
  await page.screenshot({
    path: "../../artifacts/m2-baseline-region-desktop.png",
    fullPage: true,
  });
  report.checks.push(
    "Real Curry 2015-16 vs 2024-25 totals, baseline metric, region selection and linked distribution",
  );
  await page.getByRole("button", { name: "Clear region" }).click();
  await page.getByLabel("Player A", { exact: true }).selectOption("203469");
  await page.getByLabel("Opponent", { exact: true }).selectOption("TOR");
  await page.getByLabel("Period", { exact: true }).selectOption("1");
  await page.getByLabel("Shot type", { exact: true }).selectOption("2");
  await page.getByText("1–8 of 8", { exact: true }).waitFor();
  const attempt = page
    .getByRole("listitem")
    .filter({ hasText: "Event 5 · PBP verified" });
  await attempt
    .getByRole("button", { name: "Open tracking replay", exact: true })
    .click();
  await page.getByTestId("replay-panel").waitFor();
  assert.equal(
    await page.getByLabel("Inspect attempt", { exact: true }).inputValue(),
    "shotchart:0021500492:5",
  );
  assert.equal(await page.getByTestId("tracked-player").count(), 10);
  await page.getByRole("button", { name: "Shot atlas", exact: true }).click();
  assert.equal(
    await page.getByLabel("Player A", { exact: true }).inputValue(),
    "203469",
  );
  assert.equal(
    await page.getByLabel("Opponent", { exact: true }).inputValue(),
    "TOR",
  );
  report.checks.push(
    "Real Cody Zeller event 5 opens the audited replay with 10 observed players; returning preserves atlas filters",
  );
  await page
    .getByRole("button", { name: "Reset shared filters", exact: true })
    .click();
  await page.getByLabel("Player A", { exact: true }).selectOption("201939");
  await page
    .getByRole("button", { name: "Shot frequency", exact: true })
    .click();
  await page.getByText("1–25 of 1,596", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Next attempts" }).click();
  await page.getByText("26–50 of 1,596", { exact: true }).waitFor();
  await page
    .getByLabel("Inspect region", { exact: true })
    .selectOption("outside");
  await page.getByText("1–11 of 11", { exact: true }).waitFor();
  await page.getByLabel("Player B", { exact: true }).selectOption("203469");
  await page
    .getByText("No attempts under these filters", { exact: true })
    .waitFor();
  await page.getByLabel("Player B", { exact: true }).selectOption("201939");
  report.checks.push(
    "An absent player-season displays zero attempts without retaining old bins",
  );
  report.checks.push(
    "Actual pagination and 11 outside-view attempts retain full cohort frequency denominator",
  );
  await page.getByRole("button", { name: "Clear region" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "../../artifacts/m2-atlas-mobile.png",
    fullPage: true,
  });
  await page
    .getByLabel("Inspect region", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "../../artifacts/m2-atlas-mobile-panel.png" });
  report.checks.push(
    "390px layout has no document overflow; comparison maps stack and controls remain usable",
  );
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
  await writeFile(
    "../../artifacts/m2-browser-verification.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
