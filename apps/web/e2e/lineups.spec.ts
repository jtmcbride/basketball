import { expect, test, type Page } from "@playwright/test";
import fixture from "../../../tests/fixtures/m5-lineups.json" with { type: "json" };

async function mock(page: Page, fault = "") {
  await page.route("**/api/lineups/options", (r) =>
    r.fulfill({
      status: fault === "missing" ? 503 : 200,
      json:
        fault === "missing"
          ? { detail: "Run make lineup-fetch and make lineups." }
          : fixture.options,
    }),
  );
  await page.route("**/api/lineups/games/*", (r) => {
    const bundle = structuredClone(fixture.bundle);
    if (fault === "unavailable") {
      bundle.stints[0].status = "unavailable";
      bundle.stints[0].lineups = {} as (typeof bundle.stints)[0]["lineups"];
      bundle.stints[0].reasons = ["Unresolved period starters"];
    }
    if (fault === "invalid") bundle.stints[0].lineups["10"][0] = "201";
    return r.fulfill({ json: { bundle, metadata: fixture.options } });
  });
  await page.route("**/api/models/location", (r) =>
    r.fulfill({
      status: fault === "no-model" ? 503 : 200,
      json:
        fault === "no-model"
          ? { detail: "Run make shot-model after make atlas." }
          : fixture.model,
    }),
  );
  await page.goto("/#lineups");
}

test("selects event-ordered stints and updates the roster, shots and score context", async ({
  page,
}) => {
  await mock(page);
  const a = page.getByTestId("stint-A"),
    b = page.getByTestId("stint-B");
  await expect(a.getByTestId("stint-attempt-count")).toHaveText("1");
  await expect(
    a.locator(".quintets li").filter({ hasText: "Generated 10 player 1" }),
  ).toBeVisible();
  await expect(
    b.locator(".quintets li").filter({ hasText: "Generated 10 player 6" }),
  ).toBeVisible();
  await expect(a.getByText("0 → -2", { exact: true })).toBeVisible();
  await page
    .getByLabel("Stint A", { exact: true })
    .selectOption(fixture.bundle.stints[1].stint_id);
  await expect(
    a.locator(".quintets li").filter({ hasText: "Generated 10 player 6" }),
  ).toBeVisible();
  await expect(
    a.locator(".quintets li").filter({ hasText: "Generated 10 player 1" }),
  ).toHaveCount(0);
  await expect(a.getByText(/0\/1 · 0.0%/)).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Selected substitution boundary" }),
  ).toContainText("player 6 in for");
  await page
    .getByRole("button", { name: "Select stint 1:", exact: false })
    .click();
  await expect(page.getByLabel("Stint A", { exact: true })).toHaveValue(
    fixture.bundle.stints[0].stint_id,
  );
});

test("shared team filter handles empty attempts and possession coverage stays explicit", async ({
  page,
}) => {
  await mock(page);
  await page.getByRole("button", { name: "HOM attempts", exact: true }).click();
  const a = page.getByTestId("stint-A");
  await expect(a.getByTestId("stint-attempt-count")).toHaveText("0");
  await expect(
    a.getByText("No attempts for this team in the selected stint."),
  ).toBeVisible();
  await expect(a.locator(".court")).toHaveCount(0);
  await expect(a.getByText("Unavailable", { exact: true })).toBeVisible();
  await page
    .getByText("Inspect gamebook constraints & possession coverage", {
      exact: true,
    })
    .click();
  await expect(
    page.getByText(/Provider possession field-goal totals do not reconcile/),
  ).toBeVisible();
  await expect(page.getByRole("table").first().getByRole("row")).toHaveCount(
    13,
  );
  await page.getByRole("button", { name: "Tracking lab", exact: true }).click();
  await page
    .getByRole("button", { name: "Lineup context", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "HOM attempts", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("unresolved lineups withhold prior quintets and charts", async ({
  page,
}) => {
  await mock(page, "unavailable");
  await expect(
    page
      .getByTestId("stint-A")
      .getByRole("heading", { name: "Lineup unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByTestId("stint-A").locator(".court, .quintets"),
  ).toHaveCount(0);
  await expect(page.getByTestId("stint-B").locator(".court")).toBeVisible();
});

test("invalid identities are rejected before lineup geometry is drawn", async ({
  page,
}) => {
  await mock(page, "invalid");
  await expect(page.getByRole("alert")).toContainText("source roster");
  await expect(page.getByTestId("stint-comparison")).toHaveCount(0);
});

test("missing lineup index retains the independent model evaluation", async ({
  page,
}) => {
  await mock(page, "missing");
  await expect(page.getByRole("alert")).toContainText("make lineups");
  await expect(
    page.getByRole("heading", { name: "What location alone can predict." }),
  ).toBeVisible();
  await expect(
    page.getByText(/Evaluation only: the declared gate did not pass/),
  ).toBeVisible();
  await page.getByLabel("Model location cell").selectOption("2:2");
  await expect(page.getByTestId("model-cell-detail")).toContainText("36.0%");
  await page
    .getByText("Inspect calibration counts, model definition & provenance", {
      exact: true,
    })
    .click();
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(11);
  await expect(
    page.getByText(/Intervals describe variation across held-out games/),
  ).toBeVisible();
});

test("missing optional model does not block validated lineups", async ({
  page,
}) => {
  await mock(page, "no-model");
  await expect(page.getByTestId("stint-comparison")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Location-only model unavailable" }),
  ).toBeVisible();
});
