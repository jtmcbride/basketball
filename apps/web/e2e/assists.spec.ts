import { expect, test, type Page } from "@playwright/test";

// Generated teams and players only; no source NBA records.
const options = {
  schema_version: "basketball-assists-v1",
  definition: { version: "basketball-assists-v1", share: "Generated" },
  fingerprint: "f".repeat(64),
  coverage: {
    "2015-16": {
      atlas_makes: 100,
      event_unmatched: 2,
      assisted: 60,
      unassisted: 38,
      unverified: 0,
    },
  },
  teams: [
    { season: "2015-16", id: "10", name: "Generated Ten", makes: 60 },
    { season: "2015-16", id: "20", name: "Generated Twenty", makes: 38 },
  ],
};

const players = [
  { id: "1", name: "Player One", makes: 30, assisted: 20, assists: 15 },
  { id: "2", name: "Player Two", makes: 20, assisted: 10, assists: 12 },
  { id: "3", name: "Player Three", makes: 10, assisted: 5, assists: 8 },
];

function summary(url: URL) {
  const q = url.searchParams;
  const role = q.get("role") ?? "shooter";
  const player = q.get("player_id");
  const passer = role === "passer";
  return {
    schema_version: "basketball-assists-v1",
    filters: {
      season: q.get("season"),
      team_id: q.get("team_id"),
      player_id: player,
      role,
    },
    cells: [
      {
        cell: "0:0",
        cx: 0,
        cy: 0,
        makes: passer ? 9 : 20,
        assisted: passer ? 9 : 12,
        reliable: true,
        share: passer ? 1 : 0.6,
        per_100: passer ? 60 : 50,
        league_makes: 40,
        league_share: 0.5,
      },
      {
        cell: "3:-6",
        cx: 7.5,
        cy: 22.5,
        makes: passer ? 6 : 4,
        assisted: passer ? 6 : 3,
        reliable: false,
        share: passer ? 1 : 0.75,
        per_100: passer ? 40 : 10,
        league_makes: 30,
        league_share: 0.8,
      },
    ],
    totals: passer
      ? [
          { shot_value: 2, makes: 9, assisted: 9 },
          { shot_value: 3, makes: 6, assisted: 6 },
        ]
      : [
          { shot_value: 2, makes: 30, assisted: 15 },
          { shot_value: 3, makes: 10, assisted: 8 },
        ],
    league: [
      { shot_value: 2, makes: 70, assisted: 35 },
      { shot_value: 3, makes: 28, assisted: 25 },
    ],
    players,
    network: {
      players: players.map(({ id, name }) => ({ id, name })),
      links: [
        { passer_id: "1", shooter_id: "2", makes: 9 },
        { passer_id: "2", shooter_id: "1", makes: 7 },
        { passer_id: "1", shooter_id: "3", makes: 6 },
      ],
      outside_core: 3,
    },
    partners: player
      ? {
          passers: [{ id: "2", name: "Player Two", makes: 7 }],
          targets: [
            { id: "2", name: "Player Two", makes: 9 },
            { id: "3", name: "Player Three", makes: 6 },
          ],
        }
      : null,
    unverified_team_makes: 1,
    fingerprint: "f".repeat(64),
  };
}

async function mock(page: Page, fault = "") {
  await page.route("**/api/assists/options", (r) =>
    fault === "missing"
      ? r.fulfill({
          status: 503,
          json: {
            detail: "No assist index. Run make assists after make atlas.",
          },
        })
      : r.fulfill({ json: options }),
  );
  await page.route("**/api/assists/summary?*", (r) => {
    const body = summary(new URL(r.request().url()));
    if (fault === "stale") body.filters.team_id = "99";
    return r.fulfill({ json: body });
  });
  await page.goto("/#assists");
}

test("team shares, matrix selection and passer map", async ({ page }) => {
  await mock(page);
  await expect(
    page.getByRole("heading", {
      name: "Assisted share of Generated Ten makes",
    }),
  ).toBeVisible();
  const tiles = page.locator(".assist-tile");
  await expect(tiles.filter({ hasText: "Made field goals" })).toContainText(
    "40",
  );
  await expect(tiles.filter({ hasText: "3PT makes assisted" })).toContainText(
    "80%",
  );
  await expect(tiles.filter({ hasText: "3PT makes assisted" })).toContainText(
    "League 89%",
  );
  await expect(page.getByText("98 verified makes in 2015-16")).toBeVisible();
  await expect(page.getByRole("button", { name: "As passer" })).toBeDisabled();
  await expect(
    page.locator(
      ".assist-matrix td[title='Player One → Player Two: 9 assisted makes']",
    ),
  ).toHaveText("9");
  await page.getByRole("button", { name: "Player One", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Where Player One's assists were scored",
    }),
  ).toBeVisible();
  await expect(tiles.filter({ hasText: "Assists to threes" })).toContainText(
    "40%",
  );
  await expect(page.locator(".assist-partners li").first()).toContainText(
    "Player Two9",
  );
  await page.getByRole("button", { name: "As shooter" }).click();
  await expect(
    page.getByRole("heading", { name: "Assisted share of Player One's makes" }),
  ).toBeVisible();
  await page.getByLabel("Team", { exact: true }).selectOption("20");
  await expect(
    page.getByRole("heading", {
      name: "Assisted share of Generated Twenty makes",
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Player", { exact: true })).toHaveValue("");
});

test("explains a missing index", async ({ page }) => {
  await mock(page, "missing");
  await expect(page.getByRole("alert")).toContainText("make assists");
});

test("rejects a summary for a different selection", async ({ page }) => {
  await mock(page, "stale");
  await expect(page.getByRole("alert")).toContainText("does not match");
});
