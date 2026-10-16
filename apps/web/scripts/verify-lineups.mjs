import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { chromium, expect } from "@playwright/test";

const origin = process.env.BASKETBALL_ORIGIN ?? "http://127.0.0.1:5178";
const reference = JSON.parse(
  await readFile("../../artifacts/m5-data-verification.json", "utf8"),
);
const browser = await chromium.launch();
const report = {
  origin,
  environment: {
    node: process.version,
    browser: browser.version(),
    cpu: os.cpus()[0]?.model,
  },
  checks: [],
  pageErrors: [],
  sampleCountsChecked: 0,
};
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  page.on("pageerror", (e) => report.pageErrors.push(e.message));
  const start = performance.now();
  await page.goto(`${origin}/#lineups`);
  await expect(page.getByTestId("stint-comparison")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What location alone can predict." }),
  ).toBeVisible();
  report.initialLoadMs = Math.round(performance.now() - start);
  const data = await page.evaluate(async () => {
    const read = async (p) => {
      const r = await fetch(`/api${p}`);
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      return r.json();
    };
    const [options, model] = await Promise.all([
      read("/lineups/options"),
      read("/models/location"),
    ]);
    const games = await Promise.all(
      options.games.map((g) => read(`/lineups/games/${g.game_id}`)),
    );
    return { options, model, games };
  });
  assert.equal(data.options.index_fingerprint, reference.lineup_fingerprint);
  assert.equal(
    data.model.provenance.model_fingerprint,
    reference.model.model_fingerprint,
  );
  assert.equal(data.model.metrics.n, reference.model.metrics.n);
  for (const { bundle } of data.games) {
    const game = bundle.game;
    await page
      .getByRole("navigation", { name: "Lineup games" })
      .getByRole("button")
      .filter({ hasText: `${game.away_team} at ${game.home_team}` })
      .click();
    await expect(page.getByLabel("Stint A", { exact: true })).toHaveValue(
      bundle.stints[0].stint_id,
    );
    for (const s of [
      bundle.stints[0],
      bundle.stints[Math.floor(bundle.stints.length / 2)],
      bundle.stints.at(-1),
    ]) {
      await page
        .getByLabel("Stint A", { exact: true })
        .selectOption(s.stint_id);
      for (const [tid, abbreviation] of [
        [game.away_team_id, game.away_team],
        [game.home_team_id, game.home_team],
      ]) {
        await page
          .getByRole("button", {
            name: `${abbreviation} attempts`,
            exact: true,
          })
          .click();
        const expected = bundle.shots.filter(
          (shot) => s.shot_ids.includes(shot.shot_id) && shot.team_id === tid,
        );
        await expect(
          page.getByTestId("stint-A").getByTestId("stint-attempt-count"),
        ).toHaveText(String(expected.length));
        await expect(
          page.getByTestId("stint-A").locator(".quintets li"),
        ).toHaveCount(10);
        if (!expected.length)
          await expect(
            page.getByTestId("stint-A").locator(".court"),
          ).toHaveCount(0);
        report.sampleCountsChecked++;
      }
    }
    await page
      .getByLabel("Stint A", { exact: true })
      .selectOption(bundle.stints[0].stint_id);
    await page
      .getByRole("button", { name: `${game.away_team} attempts`, exact: true })
      .click();
  }
  report.checks.push(
    "Both games: first, middle and final stint counts reconcile for both team filters; five-player identities render and empty shots clear",
  );
  const first = data.games[0].bundle;
  await page
    .getByRole("navigation", { name: "Lineup games" })
    .getByRole("button")
    .first()
    .click();
  const shot = first.shots.find((s) => s.tracking_join.status === "matched");
  const stint = first.stints.find((s) => s.shot_ids.includes(shot.shot_id));
  await page
    .getByLabel("Stint A", { exact: true })
    .selectOption(stint.stint_id);
  await page
    .getByRole("button", {
      name: `${shot.team_id === first.game.home_team_id ? first.game.home_team : first.game.away_team} attempts`,
      exact: true,
    })
    .click();
  await page
    .getByLabel("Stint A attempt", { exact: true })
    .selectOption(shot.shot_id);
  await page
    .getByRole("button", {
      name: "Open tracking replay for stint A",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Inspect attempt", { exact: true })).toHaveValue(
    shot.shot_id,
  );
  await expect(page.getByTestId("replay-panel")).toBeVisible();
  await page
    .getByRole("button", { name: "Lineup context", exact: true })
    .click();
  await expect(page.getByLabel("Stint A", { exact: true })).toHaveValue(
    stint.stint_id,
  );
  report.checks.push(
    "A real stint attempt opens its audited tracking replay; returning preserves lineup selection",
  );
  await page
    .getByText("Inspect gamebook constraints & possession coverage", {
      exact: true,
    })
    .click();
  await expect(page.getByRole("table").first().getByRole("row")).toHaveCount(
    first.box_players.length + 1,
  );
  await expect(
    page.getByText(/Provider possession field-goal totals do not reconcile/),
  ).toBeVisible();
  await page
    .getByText("Inspect gamebook constraints & possession coverage", {
      exact: true,
    })
    .click();
  await page.getByText(/Inspect player rotation bars/).click();
  await expect(
    page.getByRole("img", {
      name: "Player rotations with selected A and B intervals highlighted",
    }),
  ).toBeVisible();
  await page.getByText(/Inspect player rotation bars/).click();
  report.checks.push(
    "Official gamebook constraints, partial possession coverage and rotation bars are inspectable",
  );
  const cell = data.model.cells.find((c) => c.train_n >= 100);
  await page.getByLabel("Model location cell").selectOption(cell.cell);
  await expect(page.getByTestId("model-cell-detail")).toContainText(
    `${(cell.probability * 100).toFixed(1)}%`,
  );
  await page
    .getByText("Inspect calibration counts, model definition & provenance", {
      exact: true,
    })
    .click();
  const rows = page
    .getByRole("region", { name: "Evaluated location-only shot model" })
    .getByRole("table")
    .getByRole("row");
  await expect(rows).toHaveCount(11);
  assert.equal(
    data.model.metrics.bins.reduce((n, b) => n + b.n, 0),
    125431,
  );
  await page
    .getByText("Inspect calibration counts, model definition & provenance", {
      exact: true,
    })
    .click();
  report.checks.push(
    "Location probability and ten held-out calibration bins agree with the verified model artifact",
  );
  await page
    .getByLabel("Stint A", { exact: true })
    .selectOption(first.stints[0].stint_id);
  await page
    .getByRole("button", {
      name: `${first.game.away_team} attempts`,
      exact: true,
    })
    .click();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "../../artifacts/m5-lineups-desktop.png",
    fullPage: true,
  });
  await page
    .locator(".location-model")
    .screenshot({ path: "../../artifacts/m5-model-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page
    .locator(".rotation-timeline")
    .screenshot({ path: "../../artifacts/m5-rotation-mobile.png" });
  await page
    .getByTestId("stint-A")
    .screenshot({ path: "../../artifacts/m5-stint-mobile.png" });
  await page
    .locator(".location-model")
    .screenshot({ path: "../../artifacts/m5-model-mobile.png" });
  report.checks.push(
    "390px layout has no document overflow; timeline, stint and model screenshots captured",
  );
  assert.deepEqual(report.pageErrors, []);
  report.lineupFingerprint = data.options.index_fingerprint;
  report.modelFingerprint = data.model.provenance.model_fingerprint;
  report.passed = true;
  await writeFile(
    "../../artifacts/m5-browser-verification.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
