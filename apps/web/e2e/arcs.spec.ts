import { expect, test, type Page } from "@playwright/test";

// Generated flights only; no source NBA records.
function flight(id: string, made: boolean, distance: number, game: string) {
  const samples = Array.from({ length: 26 }, (_, k) => {
    const t = k * 0.04;
    return {
      frame_id: `${id}:${k}`,
      t_ms: k * 40,
      s_ft: +(distance - (distance / 1) * t).toFixed(3),
      h_ft: +Math.abs(distance - distance * t).toFixed(3),
      z_ft: +(9 + 17 * t - 16 * t * t).toFixed(3),
      phase: k <= 23 ? "flight" : "after",
    };
  });
  return {
    shot_id: id,
    game_id: game,
    segment_id: `seg:${id}`,
    matchup: game === "g1" ? "AAA at BBB" : "CCC at DDD",
    player_id: id,
    player_name: `Generated ${id}`,
    team_id: "10",
    period: 2,
    game_clock_s: 400,
    made,
    shot_value: distance >= 22 ? 3 : 2,
    action_type: "Jump Shot",
    recorded_distance_ft: distance,
    window_continuity: "continuous",
    candidates: 1,
    status: "available",
    rim: "left",
    release_frame_id: `${id}:0`,
    arrival_frame_id: `${id}:23`,
    release_clock_s: 401.5,
    release_height_ft: 9,
    release_distance_ft: distance,
    apex_height_ft: 13.5,
    apex_t_ms: 520,
    flight_ms: 920,
    entry_angle_deg: made ? 41.2 : null,
    rim_crossing_ft: made ? 0.2 : 2.5,
    samples,
  };
}

const report = () => ({
  schema_version: "basketball-arc-v1",
  definition: { version: "basketball-arc-v1", population: "Generated" },
  coverage: {
    matched_attempts: 4,
    available: 3,
    unavailable: { no_free_flight: 1 },
  },
  height_check: {
    passed: true,
    rule: "Generated rule",
    made: {
      flights: 2,
      crossings: 2,
      median_ft: 0.2,
      within_1_5_ft: 2,
      values: [0.2, 0.2],
    },
    missed: {
      flights: 1,
      crossings: 1,
      median_ft: 2.5,
      within_1_5_ft: 0,
      values: [2.5],
    },
  },
  arcs: [
    flight("a", true, 24, "g1"),
    flight("b", false, 15, "g1"),
    flight("c", true, 6, "g2"),
  ],
  unavailable: [
    {
      ...flight("d", true, 1, "g2"),
      status: "unavailable",
      reason: "no_free_flight",
    },
  ],
  provenance: {
    arc_fingerprint: "f".repeat(64),
    source_fingerprint: "s".repeat(64),
  },
});

async function mock(page: Page, body: object, status = 200) {
  await page.route("**/api/arcs", (r) => r.fulfill({ status, json: body }));
  await page.goto("/#arcs");
}

test("filters flights, inspects one and hands off to replay", async ({
  page,
}) => {
  await mock(page, report());
  await expect(page.getByText("3 flights, shooter on the left")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Generated a" }),
  ).toBeVisible();
  await expect(page.getByText("41.2°", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Missed", exact: true }).click();
  await expect(page.getByText("1 flight, shooter on the left")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Generated b" }),
  ).toBeVisible();
  await expect(
    page.locator(".arc-detail dl div").filter({ hasText: "Entry angle" }),
  ).toContainText("Unavailable");
  await page.getByRole("button", { name: "All results" }).click();
  await page.getByLabel("Game").selectOption("g2");
  await expect(
    page.getByRole("heading", { name: "Generated c" }),
  ).toBeVisible();
  await page.getByLabel("Shot-chart distance").selectOption("three");
  await expect(page.getByText("No recorded flights match")).toBeVisible();
  await page.getByLabel("Game").selectOption("all");
  await expect(
    page.getByRole("heading", { name: "Generated a" }),
  ).toBeVisible();
  await expect(
    page.getByText("2 of 2 made crossings within 1.5 ft"),
  ).toBeVisible();
  await page.getByText(/Unavailable flights · 1 matched/).click();
  await expect(page.getByText(/Ball stayed with the shooter/)).toBeVisible();
  await page.getByRole("button", { name: "Open tracking replay" }).click();
  await expect(page).toHaveURL(/#tracking$/);
});

test("explains missing flight data", async ({ page }) => {
  await mock(
    page,
    { detail: "No recorded ball flights. Run make arcs after make audit." },
    503,
  );
  await expect(page.getByRole("alert")).toContainText("make arcs");
});

test("rejects coverage that hides unavailable attempts", async ({ page }) => {
  const hidden = report();
  hidden.unavailable = [];
  await mock(page, hidden);
  await expect(page.getByRole("alert")).toContainText("does not reconcile");
});
