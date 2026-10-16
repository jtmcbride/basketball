import { expect, test, type Page } from "@playwright/test";
import fixture from "../../../tests/fixtures/m3-annotated-motion.json" with { type: "json" };

async function setup(
  page: Page,
  mutate?: (bundles: typeof fixture.bundles) => void,
) {
  const bundles = structuredClone(fixture.bundles);
  mutate?.(bundles);
  const index = structuredClone(fixture.index);
  index.sequences.forEach((s, i) =>
    s.annotations.forEach((a) => {
      a.elapsed_s = bundles[i].frames[a.anchor_index].elapsed_s;
      a.uncertainty_start_s = bundles[i].frames[a.start_index].elapsed_s;
      a.uncertainty_end_s = bundles[i].frames[a.end_index].elapsed_s;
    }),
  );
  const games = bundles.map((b) => ({
    game_id: b.game_id,
    game_date: "2000-01-01",
    home_team: "HOM",
    away_team: "AWY",
    home_team_id: "100",
    away_team_id: "200",
    shots: 0,
    examples: [],
    periods: [],
    joins: { shot_to_event: {}, shot_to_tracking: {} },
    findings: [],
  }));
  await page.route("**/api/data-health", (r) =>
    r.fulfill({
      json: {
        schema_version: "basketball-audit-v1",
        source_fingerprint: "generated-m3-motion",
        sources: [],
        games,
      },
    }),
  );
  await page.route("**/api/annotations", (r) => r.fulfill({ json: index }));
  await page.route("**/api/games/*/segments/*", (r) => {
    const b = bundles.find((b) =>
      decodeURIComponent(r.request().url()).endsWith(b.segment_id),
    );
    return r.fulfill({ json: b });
  });
  await page.goto("/#movement");
  return { bundles, index };
}
test("aligns recorded samples, steps both panes and synchronizes all chart cursors", async ({
  page,
}) => {
  await setup(page);
  const view = page.getByTestId("movement-comparison");
  await expect(view).toBeVisible();
  await page
    .getByRole("button", { name: "Jump to reference", exact: true })
    .click();
  await expect(page.getByTestId("movement-pane-A")).toHaveAttribute(
    "data-frame-index",
    "50",
  );
  await expect(page.getByTestId("movement-pane-B")).toHaveAttribute(
    "data-frame-index",
    "60",
  );
  await expect(page.getByTestId("tracked-player")).toHaveCount(20);
  await page
    .getByRole("button", { name: "Next observed comparison time" })
    .click();
  await expect(view).toHaveAttribute("data-time-ms", "40");
  for (const cursor of await page.getByTestId("movement-chart-cursor").all())
    await expect(cursor).toHaveAttribute("data-time-ms", "40");
  await expect(page.getByTestId("movement-pane-A")).toHaveAttribute(
    "data-frame-index",
    "51",
  );
  await view.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(view).toHaveAttribute("data-time-ms", "0");
  await page.getByLabel("Focused player A", { exact: true }).selectOption("2");
  await expect(
    page.getByText(/changing focus does not relabel it/),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("movement-pane-A")
      .getByRole("button", { name: "Select Generated Player 2", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("shows annotation provenance, actual offsets and uncovered intervals", async ({
  page,
}) => {
  await setup(page);
  await expect(page.getByTestId("movement-comparison")).toBeVisible();
  await page
    .getByRole("button", { name: "Jump to reference", exact: true })
    .click();
  await page
    .getByText("Annotation provenance & confidence · A", { exact: true })
    .click();
  await expect(
    page
      .getByTestId("movement-pane-A")
      .getByText(/Fixture generator; no NBA event/),
  ).toBeVisible();
  await expect(page.getByText(/Reference at window \+2.400 s/)).toBeVisible();
  await page.getByLabel("Seconds before reference").selectOption("4");
  await expect(page.getByTestId("movement-pane-A")).toHaveAttribute(
    "data-frame-index",
    "unavailable",
  );
  await expect(page.getByTestId("tracked-player")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Jump to reference", exact: true })
    .click();
  await expect(page.getByTestId("tracked-player")).toHaveCount(20);
  await page
    .getByText("Annotation format & automatic-label availability", {
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      /No automatic catch, screen, cut, or release labels are shown/,
    ),
  ).toBeVisible();
});
test("missing ball and conflicting positions do not retain previous measurements", async ({
  page,
}) => {
  await setup(page, (bundles) => {
    bundles[1].frames[60].entities = bundles[1].frames[60].entities.filter(
      (e) => e.kind !== "ball",
    );
    bundles[1].frames[61].timestamp_conflict = true;
  });
  await expect(page.getByTestId("movement-comparison")).toBeVisible();
  await page
    .getByRole("button", { name: "Jump to reference", exact: true })
    .click();
  const pane = page.getByTestId("movement-pane-B");
  await expect(pane.getByTestId("tracked-ball")).toHaveCount(0);
  await expect(
    pane.getByText("Ball observation unavailable.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Next observed comparison time" })
    .click();
  await expect(pane.getByTestId("tracked-player")).toHaveCount(0);
  await expect(
    pane.getByText("Conflicting timestamp observations", { exact: true }),
  ).toBeVisible();
});
test("comparison playback pauses at a break and preserves source elapsed time", async ({
  page,
}) => {
  await setup(page, (bundles) => {
    for (let i = 26; i < 100; i++) {
      bundles[1].frames[i].source_timestamp_ms += 400;
      bundles[1].frames[i].elapsed_s += 0.4;
    }
    bundles[1].frames[26].break_before = true;
  });
  const view = page.getByTestId("movement-comparison");
  await expect(view).toBeVisible();
  await page.getByLabel("Comparison play rate").selectOption("2");
  await page
    .getByRole("button", { name: "Play comparison", exact: true })
    .click();
  await expect(
    page.getByText(/Paused at a tracking break in one sequence/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play comparison", exact: true }),
  ).toBeVisible();
  const time = Number(await view.getAttribute("data-time-ms"));
  expect(time).toBe(-1755);
});
test("changed annotation source rejects the comparison before drawing positions", async ({
  page,
}) => {
  await setup(page, (bundles) => {
    bundles[1].provenance.source_fingerprint = "changed";
  });
  await expect(page.getByRole("alert")).toContainText(
    "Annotations do not match the current tracking source",
  );
  await expect(page.getByTestId("tracked-player")).toHaveCount(0);
});

test("a roster player absent from the observations is explicitly unavailable", async ({
  page,
}) => {
  await setup(page, (bundles) => {
    for (const b of bundles)
      b.players.push({
        player_id: "999",
        team_id: "100",
        name: "Generated bench player",
        jersey: "99",
        position: null,
      });
  });
  await expect(page.getByTestId("movement-comparison")).toBeVisible();
  await page
    .getByRole("button", { name: "Jump to reference", exact: true })
    .click();
  await page
    .getByLabel("Focused player A", { exact: true })
    .selectOption("999");
  await expect(
    page
      .getByTestId("movement-pane-A")
      .getByText("Focused player is not observed in this frame.", {
        exact: true,
      }),
  ).toBeVisible();
  await expect(
    page.getByTestId("movement-pane-A").getByRole("button", { pressed: true }),
  ).toHaveCount(0);
});
