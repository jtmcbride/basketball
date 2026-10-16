import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import { chromium } from "playwright";
const origin = process.env.BASKETBALL_ORIGIN ?? "http://127.0.0.1:5178";
const devOrigin = process.env.BASKETBALL_DEV_ORIGIN ?? "http://127.0.0.1:5177";
const dataReference = JSON.parse(
  await readFile("../../artifacts/m4-data-verification.json", "utf8"),
);
const browser = await chromium.launch();
const report = {
  origin,
  environment: {
    node: process.version,
    browser: browser.version(),
    platform: process.platform,
    cpu: os.cpus()[0]?.model,
  },
  checks: [],
  pageErrors: [],
};
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  page.on("pageerror", (e) => report.pageErrors.push(e.message));
  await page.goto(`${devOrigin}/#actions`);
  await page
    .getByRole("heading", { name: "Replay the two paths.", exact: true })
    .waitFor();
  report.numerical = await page.evaluate(async (reference) => {
    const { rms, parseFeature } = await import("/src/actions/model.ts");
    const { bindPath } = await import("/src/actions/PathReplay.tsx");
    let compared = 0,
      maxError = 0,
      sourceBindings = 0;
    for (const seed of ["batum-corner", "harris-middle"])
      for (const profile of ["start_relative", "court_location"]) {
        const data = await (
          await fetch(
            `/api/actions/search?seed_id=${seed}&profile=${profile}&limit=8`,
          )
        ).json();
        if (data.metadata.index_fingerprint !== reference.index_fingerprint)
          throw new Error("Index reference mismatch");
        const query = parseFeature(data.query);
        for (const hit of data.matches) {
          parseFeature(hit);
          const delta = Math.abs(rms(query, hit, profile) - hit.rms_ft);
          maxError = Math.max(maxError, delta);
          if (delta > 1e-8) throw new Error("Browser RMS mismatch");
          compared++;
        }
        for (const feature of [query, ...data.matches.slice(0, 2)]) {
          const bundle = await (
            await fetch(
              `/api/games/${feature.game_id}/segments/${encodeURIComponent(feature.segment_id)}`,
            )
          ).json();
          bindPath(feature, bundle);
          sourceBindings++;
        }
      }
    return {
      scoreComparisons: compared,
      maxErrorFt: maxError,
      toleranceFt: 1e-8,
      sourceBindings,
    };
  }, dataReference);
  const started = performance.now();
  await page.goto(`${origin}/#actions`);
  await page
    .getByRole("heading", { name: "Replay the two paths.", exact: true })
    .waitFor();
  report.initialAtlasMs = Math.round(performance.now() - started);
  assert.equal(await page.getByTestId("tracked-player").count(), 20);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: "../../artifacts/m4-action-atlas-desktop.png",
    fullPage: true,
  });
  const shapeScore = await page.locator(".rms-readout strong").innerText();
  await page
    .getByRole("button", { name: "Path + court location", exact: true })
    .click();
  await page
    .getByRole("heading", {
      name: "Locations retained in source court feet.",
      exact: true,
    })
    .waitFor();
  assert.notEqual(
    await page.locator(".rms-readout strong").innerText(),
    shapeScore,
  );
  await page
    .getByText("Inspect all 21 paired samples & score calculation", {
      exact: true,
    })
    .click();
  assert.equal(
    await page
      .getByRole("region", { name: "Paired sample coordinates and timing" })
      .getByRole("row")
      .count(),
    22,
  );
  await page.getByText(/agree within 1e-8 ft/).waitFor();
  report.checks.push(
    "Both coordinate profiles change real ranking; 21 paired samples reproduce the selected API score",
  );
  await page
    .getByRole("button", { name: "Path shape · align starts", exact: true })
    .click();
  await page
    .getByRole("heading", {
      name: "Starts aligned. Source axes preserved.",
      exact: true,
    })
    .waitFor();
  await page
    .getByRole("button", { name: "Next path observation", exact: true })
    .click();
  assert.ok(
    Number(
      await page.getByTestId("action-replay").getAttribute("data-time-ms"),
    ) > 0,
  );
  await page
    .getByRole("button", { name: "Use matched path as query", exact: true })
    .click();
  await page
    .getByText("An indexed match is now the query.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Return to curated query", exact: true })
    .click();
  await page
    .getByLabel("Query reference", { exact: true })
    .selectOption("williams-missing-ball");
  await page
    .getByRole("heading", { name: "Query path unavailable", exact: true })
    .waitFor();
  assert.equal(await page.getByTestId("tracked-player").count(), 0);
  report.checks.push(
    "Source stepping and query-from-match work; insufficient curated history clears prior geometry and replay",
  );
  await page
    .getByLabel("Query reference", { exact: true })
    .selectOption("batum-corner");
  await page
    .getByRole("heading", { name: "Replay the two paths.", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Play path comparison", exact: true })
    .click();
  await page.getByRole("button", { name: "Tracking lab", exact: true }).click();
  await page.getByRole("button", { name: "Action atlas", exact: true }).click();
  await page
    .getByRole("button", { name: "Play path comparison", exact: true })
    .waitFor();
  report.checks.push(
    "Leaving the action atlas pauses its replay and returning preserves the query state",
  );
  await page
    .getByRole("button", { name: "Off-ball explorer", exact: true })
    .click();
  await page.getByTestId("movement-comparison").waitFor();
  await page
    .getByTestId("movement-pane-B")
    .getByRole("link", {
      name: "Find geometrically similar paths →",
      exact: true,
    })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="Query player"]')?.value ===
      "203914",
  );
  assert.equal(
    await page.getByLabel("Query player", { exact: true }).inputValue(),
    "203914",
  );
  await page
    .getByRole("heading", { name: "Replay the two paths.", exact: true })
    .waitFor();
  report.checks.push(
    "The Harris annotation link opens the matching player/reference in the action atlas",
  );
  await page
    .getByLabel("Query reference", { exact: true })
    .selectOption("batum-corner");
  await page
    .getByRole("heading", { name: "Replay the two paths.", exact: true })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "../../artifacts/m4-action-atlas-mobile.png",
    fullPage: true,
  });
  await page.locator(".path-comparison").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "../../artifacts/m4-path-overlay-mobile.png" });
  await page.locator(".action-observed").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "../../artifacts/m4-path-replay-mobile.png" });
  report.checks.push(
    "390px source thumbnails, overlay and observed replays have no document overflow",
  );
  assert.deepEqual(report.pageErrors, []);
  report.indexFingerprint = dataReference.index_fingerprint;
  report.sourceFingerprint = dataReference.source_fingerprint;
  report.files = {};
  for (const path of [
    "src/actions/model.ts",
    "src/actions/PathReplay.tsx",
    "../../config/path-similarity-v1.json",
    "package-lock.json",
  ])
    report.files[path] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  report.passed = true;
  await writeFile(
    "../../artifacts/m4-browser-verification.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
