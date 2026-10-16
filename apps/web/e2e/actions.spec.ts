import { expect, test, type Page } from "@playwright/test";
import fixture from "../../../tests/fixtures/m4-paths.json" with { type: "json" };
type Feature = (typeof fixture.features)[number];
function distance(a: Feature, b: Feature, profile: string) {
  return Math.sqrt(
    a.x_ft.reduce((sum, x, i) => {
      const dx =
        x -
        (profile === "start_relative" ? a.x_ft[0] : 0) -
        (b.x_ft[i] - (profile === "start_relative" ? b.x_ft[0] : 0));
      const dy =
        a.y_ft[i] -
        (profile === "start_relative" ? a.y_ft[0] : 0) -
        (b.y_ft[i] - (profile === "start_relative" ? b.y_ft[0] : 0));
      return sum + dx * dx + dy * dy;
    }, 0) / 21,
  );
}
function response(params: URLSearchParams) {
  const query = params.get("feature_id")
    ? fixture.features.find((f) => f.candidate_id === params.get("feature_id"))!
    : fixture.options.seeds.find(
        (s) => s.sequence.sequence_id === params.get("seed_id"),
      )!.feature;
  const metadata = fixture.options;
  if (params.get("player_id") === "999")
    return {
      status: "unavailable",
      reason: "Missing, duplicate or roster-inconsistent selected player",
      query: null,
      matches: [],
      metadata,
    };
  const matches = fixture.features
    .filter(
      (f) =>
        f.game_id !== query.game_id &&
        (!(params.get("same_player") === "true") ||
          f.player_id === query.player_id),
    )
    .map((f) => ({
      ...f,
      rms_ft: distance(query, f, params.get("profile") ?? "start_relative"),
    }))
    .sort(
      (a, b) =>
        a.rms_ft - b.rms_ft || a.candidate_id.localeCompare(b.candidate_id),
    );
  return {
    status: "available",
    reason: null,
    query,
    matches,
    metadata,
    profile: params.get("profile"),
    eligible_paths: matches.length,
    overlapping_query_paths_excluded: 1,
    result_count: matches.length,
    search_ms: 2,
  };
}
async function setup(page: Page) {
  const requests: URLSearchParams[] = [];
  const options = structuredClone(fixture.options);
  options.roster[0].players.push({
    player_id: "999",
    team_id: "100",
    name: "Generated absent player",
    jersey: "99",
    position: null,
  });
  const games = fixture.games.map((g) => ({
    ...g,
    shots: 0,
    examples: [],
    periods: [],
    findings: [],
    unique_frames: 100,
    source_event_windows: 1,
    continuous_windows: 1,
    partial_windows: 0,
    joins: { shot_to_event: {}, shot_to_tracking: {} },
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
  await page.route("**/api/actions/options", (r) =>
    r.fulfill({ json: options }),
  );
  await page.route("**/api/actions/search?*", (r) => {
    const p = new URL(r.request().url()).searchParams;
    requests.push(p);
    return r.fulfill({ json: response(p) });
  });
  await page.route("**/api/games/*/segments/*", (r) => {
    const bundle = fixture.bundles.find((b) =>
      decodeURIComponent(r.request().url()).endsWith(b.segment_id),
    );
    return r.fulfill({ json: bundle });
  });
  await page.route("**/api/games/*/shots?*", (r) =>
    r.fulfill({ json: { shots: [], total: 0 } }),
  );
  await page.goto("/#actions");
  await expect(
    page.getByRole("heading", { name: "2 geometric matches", exact: true }),
  ).toBeVisible();
  return requests;
}
test("compares shape versus location and exposes paired sample distances", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(".rms-readout strong")).toHaveText("0.00 ft");
  await page
    .getByRole("button", { name: "Path + court location", exact: true })
    .click();
  await expect(page.locator(".rms-readout strong")).toHaveText("5.00 ft");
  await page
    .getByText("Inspect all 21 paired samples & score calculation", {
      exact: true,
    })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Paired sample coordinates and timing" })
      .getByRole("row"),
  ).toHaveCount(22);
  await expect(page.getByText(/agree within 1e-8 ft/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("selects a thumbnail and replays the scored source frames with shared stepping", async ({
  page,
}) => {
  await setup(page);
  await page
    .getByRole("button", { name: /Inspect match 2: Generated Rotated Player/ })
    .click();
  await expect(page.locator(".rms-readout strong")).toHaveText("8.21 ft");
  const replay = page.getByTestId("action-replay");
  await expect(replay).toBeVisible();
  await page.getByRole("button", { name: "Next path observation" }).click();
  await expect(replay).toHaveAttribute("data-time-ms", "40");
  await expect(page.getByTestId("action-replay-0")).toHaveAttribute(
    "data-frame-index",
    "1",
  );
  await expect(page.getByTestId("action-replay-1")).toHaveAttribute(
    "data-frame-index",
    "1",
  );
  await expect(page.getByTestId("tracked-player")).toHaveCount(20);
  await expect(
    page.getByTestId("action-replay-1").getByRole("button"),
  ).toHaveCount(0);
});
test("uses a match as the next query, keeps filters across navigation, and handles no eligible footage", async ({
  page,
}) => {
  const requests = await setup(page);
  await page
    .getByRole("button", { name: /Inspect match 2: Generated Rotated Player/ })
    .click();
  await page
    .getByRole("button", { name: "Use matched path as query", exact: true })
    .click();
  await expect(
    page.getByText("An indexed match is now the query.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Same player only", exact: true })
    .check();
  await expect(
    page.getByText(/No eligible paths under these filters/),
  ).toBeVisible();
  expect(
    requests.some(
      (p) => p.get("feature_id") === fixture.features[2].candidate_id,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Tracking lab", exact: true }).click();
  await page.getByRole("button", { name: "Action atlas", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Same player only" }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "Return to curated query", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reset comparison filters", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "2 geometric matches", exact: true }),
  ).toBeVisible();
});
test("an unavailable query clears prior scores and source positions", async ({
  page,
}) => {
  await setup(page);
  await page.getByLabel("Query player", { exact: true }).selectOption("999");
  await expect(
    page.getByRole("heading", { name: "Query path unavailable", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("tracked-player")).toHaveCount(0);
  await expect(page.locator(".rms-readout")).toHaveCount(0);
});
test("missing index reports the build command", async ({ page }) => {
  await page.route("**/api/data-health", (r) =>
    r.fulfill({ status: 503, json: { detail: "No sample" } }),
  );
  await page.route("**/api/actions/options", (r) =>
    r.fulfill({
      status: 503,
      json: { detail: "No action index. Run make actions after make audit." },
    }),
  );
  await page.goto("/#actions");
  await expect(page.getByRole("alert")).toContainText("make actions");
});
test("rejects a replay that no longer contains the scored coordinates", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/games/*/segments/*", (r) => {
    const original = fixture.bundles.find((b) =>
      decodeURIComponent(r.request().url()).endsWith(b.segment_id),
    )!;
    const changed = structuredClone(original);
    const player = changed.frames[0].entities.find((e) => e.entity_id === "11");
    if (player) player.x_ft += 1;
    return r.fulfill({ json: changed });
  });
  await page
    .getByRole("button", { name: /Inspect match 2: Generated Rotated Player/ })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Scored coordinates disagree",
  );
  await expect(page.getByTestId("tracked-player")).toHaveCount(0);
});
