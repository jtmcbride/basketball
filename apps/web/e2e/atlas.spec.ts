import { expect, test, type Page } from "@playwright/test";
const seasons = ["2015-16", "2024-25"];
const coverage = (season: string) => ({
  season,
  attempts: 30,
  games: 1,
  teams: 2,
  date_min: "20151027",
  date_max: "20160413",
  event_matched: 29,
  pbp_attempts: 31,
  pbp_rows: 32,
  duplicate_pbp_keys: 1,
  pbp_attempts_without_shot: 1,
  shots_without_pbp_key: 0,
  unknown_opponent: 0,
  outside_half_court: 1,
  fingerprint: "generated",
  sources: [],
});
const base = {
  cx: 0,
  cy: 0,
  n: 20,
  made: 10,
  points: 20,
  frequency: (100 * 20) / 30,
  fg_pct: 50,
  points_per_attempt: 1,
  difference_pp: 0,
  baseline_n: 30,
  baseline_fg_pct: 50,
  reliable: true,
};
async function setup(page: Page) {
  const requests: URLSearchParams[] = [];
  await page.route("**/api/data-health", (r) =>
    r.fulfill({ status: 503, json: { detail: "No tracking sample" } }),
  );
  await page.route("**/api/atlas/options", (r) =>
    r.fulfill({
      json: {
        version: "shot-atlas-v1",
        seasons: seasons.map(coverage),
        players: [
          { id: "201939", name: "Stephen Curry", seasons },
          { id: "2", name: "Generated Second", seasons },
        ],
        teams: [{ id: "100", name: "Generated Team" }],
        opponents: ["AWY"],
        periods: [1, 5],
      },
    }),
  );
  await page.route("**/api/atlas/summary?*", (r) => {
    const p = new URL(r.request().url()).searchParams;
    requests.push(p);
    return r.fulfill({
      json: {
        filters: Object.fromEntries(p),
        n: 30,
        made: 15,
        points: 35,
        bins: [
          { ...base, cell: "0:0" },
          {
            ...base,
            cell: "1:0",
            cx: 4.33,
            n: 9,
            made: 4,
            points: 12,
            fg_pct: 400 / 9,
            points_per_attempt: 12 / 9,
            reliable: false,
            difference_pp: null,
            frequency: 30,
          },
          {
            ...base,
            cell: "outside",
            cx: null,
            cy: null,
            n: 1,
            made: 1,
            points: 3,
            fg_pct: 100,
            points_per_attempt: 3,
            reliable: false,
            difference_pp: null,
            frequency: 100 / 30,
          },
        ],
        histogram: [
          { distance: 0, cell: "0:0", n: 20 },
          { distance: 5, cell: "1:0", n: 9 },
          { distance: 50, cell: "outside", n: 1 },
        ],
        baseline: {
          n: 30,
          season: p.get("season"),
          population: "All recorded players under shared filters",
        },
      },
    });
  });
  await page.route("**/api/atlas/attempts?*", (r) => {
    const p = new URL(r.request().url()).searchParams;
    const total =
      p.get("cell") === "outside" ? 1 : p.get("cell") === "0:0" ? 20 : 30;
    const offset = Number(p.get("offset") ?? 0);
    return r.fulfill({
      json: {
        total,
        offset,
        attempts: Array.from(
          { length: Math.min(25, total - offset) },
          (_, i) => ({
            shot_id: `test-shot-${offset + i}`,
            game_id: "0000000001",
            source_event_id: "5",
            game_date: "20160101",
            player_name: "Stephen Curry",
            period: 1,
            game_clock_s: 700,
            made: 1,
            shot_value: 3,
            action_type: "Jump Shot",
            recorded_distance_ft: 25,
            event_matched: 1,
            tracking_status: "unavailable",
            tracking_reason: "No audited tracking window in the local sample",
          }),
        ),
      },
    });
  });
  await page.goto("/#atlas");
  await expect(
    page.getByRole("heading", { name: "How the floor changes." }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Inspect region", { exact: true }),
  ).toBeVisible();
  return requests;
}

test("compares cohorts with shared filters and fixed metric scales", async ({
  page,
}) => {
  const requests = await setup(page);
  await page.getByLabel("Player B", { exact: true }).selectOption("2");
  await page.getByLabel("Team", { exact: true }).selectOption("100");
  await page.getByLabel("Opponent", { exact: true }).selectOption("AWY");
  await page.getByLabel("Period", { exact: true }).selectOption("5");
  await page.getByLabel("Shot type", { exact: true }).selectOption("3");
  await expect
    .poll(
      () =>
        requests.filter(
          (p) =>
            p.get("shot_value") === "3" &&
            p.get("team_id") === "100" &&
            p.get("opponent") === "AWY" &&
            p.get("period") === "5",
        ).length,
    )
    .toBeGreaterThanOrEqual(3);
  await page
    .getByRole("button", { name: "Field-goal percentage", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Region 1:0: 9 attempts, Unavailable: sparse sample",
    }),
  ).toHaveCount(2);
  await page
    .getByRole("button", {
      name: "Difference from same-season baseline",
      exact: true,
    })
    .click();
  await expect(page.getByText("−30 → 30 (colors capped)")).toBeVisible();
  await page
    .getByRole("button", { name: "Compare 2024-25 in cohort A" })
    .click();
  await expect(page.getByLabel("Season A", { exact: true })).toHaveValue(
    "2024-25",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("links region selection, counts, distance bins and paginated attempts", async ({
  page,
}) => {
  await setup(page);
  await expect(page.getByText("1–25 of 30", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next attempts" }).click();
  await expect(page.getByText("26–30 of 30", { exact: true })).toBeVisible();
  await page.getByLabel("Inspect region", { exact: true }).selectOption("0:0");
  await expect(page.getByText("1–20 of 20", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Attempts in the selected region" }),
  ).toBeVisible();
  await expect(page.locator(".tracking-unavailable").first()).toContainText(
    "Tracking unavailable",
  );
  await page
    .getByLabel("Inspect region", { exact: true })
    .selectOption("outside");
  await expect(
    page.getByText("1 attempts · Outside the half-court view", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear region" }).click();
  await expect(page.getByLabel("Inspect region", { exact: true })).toHaveValue(
    "all",
  );
  await expect(
    page.getByRole("heading", { name: "Where the attempts come from" }),
  ).toBeVisible();
  await page
    .getByText("Season coverage & provenance", { exact: false })
    .click();
  await expect(
    page.getByText(/Archive reconciliation is not a check/),
  ).toBeVisible();
  // Crossing to the tracking view and back preserves comparison controls.
  await page.getByLabel("Player B", { exact: true }).selectOption("2");
  await page.getByRole("button", { name: "Tracking lab", exact: true }).click();
  await page.getByRole("button", { name: "Shot atlas", exact: true }).click();
  await expect(page.getByLabel("Player B", { exact: true })).toHaveValue("2");
});

test("missing atlas has an actionable empty state independent of tracking", async ({
  page,
}) => {
  await page.route("**/api/data-health", (r) =>
    r.fulfill({ status: 503, json: { detail: "Missing sample" } }),
  );
  await page.route("**/api/atlas/options", (r) =>
    r.fulfill({ status: 503, json: { detail: "Missing atlas" } }),
  );
  await page.goto("/#atlas");
  await expect(page.getByRole("alert")).toContainText(
    "make atlas-fetch and make atlas",
  );
  await expect(
    page.getByRole("heading", { name: "Load the local sample" }),
  ).not.toBeVisible();
});
