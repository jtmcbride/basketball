import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const origin = process.env.BASKETBALL_ORIGIN ?? "http://127.0.0.1:5178";
const devOrigin = process.env.BASKETBALL_DEV_ORIGIN ?? "http://127.0.0.1:5177";
const reference = JSON.parse(
  await readFile("../../data/exports/m3-reference.json", "utf8"),
);
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
  await page.goto(`${devOrigin}/#movement`);
  await page.getByTestId("movement-comparison").waitFor();
  report.numerical = await page.evaluate(async (reference) => {
    const { bindClient } = await import("/src/offball/model.ts");
    const { analyzeMovement, sampleAt } = await import(
      "/src/offball/analysis.ts"
    );
    const set = await (await fetch("/api/annotations")).json();
    if (
      set.source_fingerprint !== reference.source_fingerprint ||
      set.revision !== reference.annotation_revision
    )
      throw new Error("Reference provenance mismatch");
    const prepared = new Map();
    let numeric = 0,
      masks = 0;
    const maxError = { opponent: 0, ball: 0, heading: 0 };
    for (const check of reference.checks) {
      const key = `${check.sequence_id}:${check.player_id}`;
      if (!prepared.has(key)) {
        const sequence = set.sequences.find(
          (s) => s.sequence_id === check.sequence_id,
        );
        const bundle = await (
          await fetch(
            `/api/games/${sequence.game_id}/segments/${encodeURIComponent(sequence.segment_id)}`,
          )
        ).json();
        const bound = bindClient(
          set,
          sequence,
          bundle,
          sequence.default_anchor_id,
        );
        prepared.set(
          key,
          analyzeMovement({
            ...bound,
            sequence: { ...bound.sequence, player_id: check.player_id },
          }),
        );
      }
      const point = sampleAt(prepared.get(key), check.time_ms);
      if ((point?.index ?? null) !== check.index)
        throw new Error(`Sample mismatch ${key}:${check.time_ms}`);
      for (const metric of ["opponent", "ball", "heading"]) {
        const actual = point?.[metric].value ?? null,
          expected = check.expected[metric];
        masks++;
        if ((actual === null) !== (expected === null))
          throw new Error(`Availability mismatch ${key}:${metric}`);
        if (actual === null) continue;
        const delta = Math.abs(actual - expected);
        maxError[metric] = Math.max(maxError[metric], delta);
        if (delta > 1e-8)
          throw new Error(`Numerical mismatch ${key}:${metric}:${delta}`);
        numeric++;
      }
    }
    return {
      referenceCases: reference.checks.length,
      sampleMatches: reference.checks.length,
      numericComparisons: numeric,
      availabilityChecks: masks,
      maxError,
      tolerance: 1e-8,
    };
  }, reference);
  await page.goto(`${origin}/#movement`);
  await page.getByTestId("movement-comparison").waitFor();
  await page
    .getByRole("button", { name: "Jump to reference", exact: true })
    .click();
  assert.equal(
    await page.getByTestId("movement-pane-A").getAttribute("data-frame-index"),
    "90",
  );
  assert.equal(
    await page.getByTestId("movement-pane-B").getAttribute("data-frame-index"),
    "400",
  );
  assert.equal(await page.getByTestId("tracked-player").count(), 20);
  await page.screenshot({
    path: "../../artifacts/m3-movement-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Next observed comparison time", exact: true })
    .click();
  const t = await page
    .getByTestId("movement-comparison")
    .getAttribute("data-time-ms");
  for (const cursor of await page.getByTestId("movement-chart-cursor").all())
    assert.equal(await cursor.getAttribute("data-time-ms"), t);
  await page
    .getByText("Annotation provenance & confidence · A", { exact: true })
    .click();
  assert.match(
    await page.getByTestId("movement-pane-A").innerText(),
    /not independently adjudicated/,
  );
  report.checks.push(
    "Real Batum/Harris alignment, 20 observed players, shared stepping/chart cursors, confidence and reviewer provenance",
  );
  await page
    .getByLabel("Focused player A", { exact: true })
    .selectOption("202689");
  // Selection may be a different roster player, but the annotation retains Batum attribution.
  await page.getByText(/changing focus does not relabel it/).waitFor();
  report.checks.push(
    "Changing focused player preserves the annotation participant and provenance",
  );
  await page
    .getByLabel("Sequence A", { exact: true })
    .selectOption("williams-missing-ball");
  await page
    .getByRole("button", { name: "Jump to reference", exact: true })
    .click();
  await page
    .getByTestId("movement-pane-A")
    .getByText("Ball observation unavailable.", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByTestId("movement-pane-A")
      .getByTestId("tracked-ball")
      .count(),
    0,
  );
  report.checks.push(
    "Real Williams reference frame 333 has no ball; the ball and its separation value remain unavailable",
  );
  await page
    .getByLabel("Sequence A", { exact: true })
    .selectOption("batum-corner");
  await page
    .getByRole("button", { name: "Jump to reference", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: "../../artifacts/m3-movement-mobile.png",
    fullPage: true,
  });
  await page.getByTestId("movement-pane-A").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../../artifacts/m3-movement-mobile-panel.png",
  });
  await page.locator(".movement-charts").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../../artifacts/m3-movement-mobile-charts.png",
  });
  report.checks.push(
    "390px comparison controls, focused courts and direction/separation charts have no document overflow",
  );
  assert.deepEqual(report.pageErrors, []);
  report.sourceFingerprint = reference.source_fingerprint;
  report.annotationRevision = reference.annotation_revision;
  report.files = {};
  for (const path of [
    "../../annotations/curated-v1.json",
    "src/offball/analysis.ts",
    "src/offball/model.ts",
    "package-lock.json",
  ])
    report.files[path] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  report.passed = true;
  await writeFile(
    "../../artifacts/m3-verification.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
