# Milestone 2 — Shot atlas and historical comparison

Implemented locally on 2026-10-15. Open `http://127.0.0.1:5177/#atlas`, or choose
**Shot atlas** above the existing tracking lab.

## Delivered workflow

Compare two players or two seasons on the same basket-relative hex grid. Player
and season belong to each cohort; team, opponent, period (including overtime),
and recorded 2PT/3PT type are shared filters. Four separate views show frequency,
FG%, field-goal points per attempt, and same-season FG% difference. Season small
multiples follow cohort A and share the main maps' color scale.

Select a hexagon with a mouse or keyboard, or use **Inspect region**. Both maps
highlight the same region. The distance distribution updates to that region;
its bars retain the full cohort denominator. Choose which cohort to inspect and
page through its underlying attempts. Matched attempts open the existing audited
tracking replay. Returning to the atlas preserves comparison and region state.
The scrollable attempt list supports keyboard focus. All filters and regions
also have native select controls.

## Verified local archives

Pinned source revision: `shufinskiy/nba_data` at
`e829d4678be1e075f99e5d41a1c5f97089be446b`. The configuration pins each archive's
SHA-256 independently. These are regular-season shot-chart records and paired
play-by-play archives, with 1,230 observed games and 30 teams per season:

- **2015–16:** 207,893 shots, 2015-10-27 through 2016-04-13; 207,835
  metadata-verified PBP matches. PBP has 156 distinct attempt keys without a shot
  and 58 duplicate attempt keys.
- **2016–17:** 209,929 shots, 2016-10-25 through 2017-04-12; 209,868 verified
  matches. PBP has 186 distinct attempt keys without a shot and 59 duplicate keys.
- **2023–24:** 218,701 shots, 2023-10-24 through 2024-04-14; 218,693 verified
  matches. Four PBP keys have no shot, three shots have no PBP key, and three
  PBP attempt keys are duplicated.
- **2024–25:** 219,527 shots, 2024-10-22 through 2025-04-13; 219,520 verified
  matches. One PBP key has no shot and two PBP attempt keys are duplicated.

Total: **856,050 recorded attempts across 4,920 games**. All games found in the
paired PBP files have shot records; this is **not verification against an official
schedule or a claim that every field-goal attempt has a location**. Charts use
available shot-chart rows; PBP-only attempts are disclosed and excluded from the
spatial denominator. Duplicate PBP keys cannot produce verified joins. Other
metadata disagreement also prevents verification. No opponent labels are unknown
in these four imports. Source descriptions for a blocked shot can mention both
teams; home-team inference uses only unambiguous single-side attempt descriptions
and rejects inconsistent identities.

Per-season reports retain source manifests, software versions, adapter checksum,
Parquet checksum, discrepancies, and example discrepant keys. See
`artifacts/m2-data-verification.json` for the measured aggregate evidence.
Individual source rows remain in ignored `data/` files.

Historical tracking remains limited to the separately audited two 2015–16 games.
Atlas replay links require a verified PBP record and agreement with the existing
sample's shot identity, player, team, period, result, value, clock, action, and
coordinates. They preserve the original conservative tracking join; season
coverage does not expand tracking availability or establish release timing.

## Definitions and reliability

- Hex centers use a fixed pointy axial grid with radius **2.5 feet** and origin
  at the basket. Coordinates come directly from shot `LOC_X/10`, `LOC_Y/10`.
  Cube rounding assigns each point once, independent of filters or cohort.
  Display glyphs have a small gap between cells. There is no smoothing.
- The half-court view spans lateral ±25 feet and forward −5.25 through 41.75
  feet from the basket. Attempts outside it enter an inspectable **Outside
  half-court view** region. They remain in totals, frequency denominators, and
  distance distributions. The four seasons have 440, 501, 435, and 521 such rows.
- Frequency is `100 × region attempts / all cohort attempts`, including outside
  attempts. Counts are always inspectable. One maximum across both main maps
  and every small multiple defines the shared frequency scale.
- FG% is `100 × makes / attempts`, with fixed colors from 0–100%. Field-goal
  points per attempt is `sum(made × recorded 2PT/3PT value) / attempts`, with
  fixed colors from 0–3. This metric excludes free throws and offensive rebounds;
  it is not points per possession. A spatial cell can contain both shot values;
  actual recorded values are used without interpolation across the three-point arc.
- Efficiency cells below **10 cohort attempts** are gray and faded. Raw counts,
  makes, and underlying attempts remain inspectable. These are display thresholds,
  not statistical confidence intervals or significance tests.
- Difference is cohort FG% minus baseline FG% in the same hex and season. The
  baseline includes **all recorded players satisfying the shared team, opponent,
  period, and shot-value filters**, including the selected player. Only the player
  filter is removed. Each map and selected region disclose baseline counts. A
  difference needs at least 10 cohort and **25 baseline attempts** in the cell;
  otherwise it is unavailable. The common diverging scale caps color at ±30
  percentage points; inspected values retain their actual difference.
- This is a descriptive comparison, not a modeled expected-shot-value or
  shot-quality-adjusted estimate. Differences in shot mix within a cell remain
  possible. Optional contours are deferred; no bandwidth or smoothed surface is
  implied by the hex display.
- Distance bars use source-recorded whole-foot distances in five-foot bins;
  **50+** retains longer attempts. Color A/B is consistent across the charts.

## Reproduce and extend

```sh
make atlas-fetch  # explicit network acquisition; completed files are checksum-verified
make atlas        # offline, resumable per-season partitions; publish a read-only catalog
make api
make dev          # open /#atlas
```

`config/atlas-sources.json` declares each season's shot and PBP pair. Add a pinned
pair to extend coverage. Acquisition resumes at completed-file boundaries;
interrupted individual downloads restart, rather than using HTTP byte ranges.
Completed season partitions are reused only when source manifests, adapter code,
Python/DuckDB versions, and Parquet checksums match. Corrupt outputs or incomplete
checkpoints rebuild that season. The catalog is published atomically after all
requested partitions succeed, keeping prior published data available on failure.
No network access occurs during `make atlas` or API queries.

Local outputs: `data/lake/atlas/<season>.parquet` plus its JSON coverage checkpoint,
and `data/db/atlas.duckdb`. This catalog is independent of the tracking database.
The read-only API adds:

- `GET /atlas/options`: observed seasons, coverage/provenance, players, teams,
  opponents, periods, fixed grid, and reliability thresholds.
- `GET /atlas/summary?season=2015-16&player_id=201939`: counts, hexes, same-season
  baseline, and region-linked distance bins. Optional shared filters are
  `team_id`, `opponent`, `period`, `shot_value`.
- `GET /atlas/attempts?...&cell=0%3A0&offset=0&limit=25`: underlying rows, total,
  and audited tracking availability; limit is bounded at 100. Omit `cell` for all
  regions or use `outside`. Ordering is date, game ID, numeric source event ID.

Queries use bound parameters. Browser requests abort on filter changes; late
results cannot replace newer selections. Duplicate main/small-multiple requests
are deduplicated within each update. Whole seasons are aggregated in DuckDB;
only bins, distributions, and bounded attempt pages reach the browser.

## Local verification

Final local gates passed: **28 Python tests, 24 web unit tests, and 22 desktop/mobile
browser checks** against the production preview, plus typecheck, lint, and build.

```sh
make lint test web-build
npm --prefix apps/web run test:browser
uv run python scripts/verify_atlas.py
npm --prefix apps/web run preview       # separate terminal, API must be running
npm --prefix apps/web run verify:atlas
```

- Generated-source tests cover coverage discrepancies, duplicate event keys,
  raw/output corruption, interrupted checkpoints, reusable season partitions,
  exact metric values, shared-filter baselines, source values, outside attempts,
  distance bins, pagination, SQL parameterization, and absent tracking/catalogs.
- The independent raw-CSV oracle checks 20 combinations across all four seasons:
  totals, makes, actual field-goal points, distance distributions, bin reconciliation,
  and paginated region rows. It does not reuse the pipeline's raw normalizer.
- Browser checks cover filters, metrics and sparse cells, small multiples, region
  linking, attempt pagination, retained state, unavailable sources, and desktop/
  mobile overflow. The real production-preview check additionally opens Cody
  Zeller event 5 into the existing audited replay and checks actual Curry totals,
  outside attempts, empty player-seasons, and 390px layout.
- Screenshots are `artifacts/m2-atlas-desktop.png`,
  `m2-baseline-region-desktop.png`, `m2-atlas-mobile.png`, and
  `m2-atlas-mobile-panel.png`. Browser observations and local timing are in
  `artifacts/m2-browser-verification.json`; the timing is one local observation,
  not a performance guarantee.

CI is configured with generated fixtures and browser checks; it has not run on
GitHub. Hosted verification and raw-data redistribution rights remain unresolved.
