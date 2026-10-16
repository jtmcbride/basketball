# Milestone 5 — Lineup context and an evaluated location model

Implemented and verified locally. Open `http://127.0.0.1:5177/#lineups` or choose
**Lineup context**. The rotation explorer covers **58 reconstructed stints and all
367 audited attempts** in the two historical tracking games. A separate
location-only shot-make baseline uses the 2015–16 shot archive, with whole-game
temporal training, calibration and test partitions.

## Rotation workflow

Choose a game, then select a segment in the period timeline or use **Stint A**.
Compare another interval with **Stint B**. The default comparison prefers another
available stint with at least ten combined attempts, then falls back to the next
interval. A shared team filter updates both shot charts and sample counts. Each
panel shows both five-player groups, duration, recorded home score margin,
field-goal makes/attempts and sample FG%. Empty team samples remain empty.

The score-margin plot highlights both intervals. Its steps follow recorded event
order; period bars use game-clock duration, excluding real-world stoppages.
Selectors retain every interval, including short or zero-second stints. Expand
player rotation bars to inspect each active player's reconstructed court time.
Selecting a bar updates A; keyboard users can use the stint selectors.

Choose an underlying attempt and open its audited tracking replay where available.
Returning preserves the game, stint, comparison and shared team filter. A lineup
event clock is not a tracking release frame. Raw tracking positions never supply
inferred starters, missing substitutions or model features in this milestone.

Comparisons are descriptive samples from one game. They do not establish causal
player impact, lineup effectiveness or a defensive assignment. No per-possession
rating or official lineup plus-minus is inferred.

## Source additions

The existing M0 event contract retained only `PLAYER1_ID`; reliable substitution
reconstruction also needs the incoming `PLAYER2_ID`. The new offline adapter reads
the full **already pinned play-by-play CSV**, preserving source row order and all
relevant participants without changing the replay catalog or its fingerprint.

`config/lineup-sources.json` additionally pins:

- [Official CHA–TOR final gamebook](https://statsdmz.nba.com/pdfs/20160101/20160101_CHATOR_book.pdf),
  SHA-256 `261873d153f6e95865feb4eace2a461d496f8825029cded2b011460f99884109`.
- [Official DEN–GSW final gamebook](https://statsdmz.nba.com/pdfs/20160102/20160102_DENGSW_book.pdf),
  SHA-256 `4e1481ad90c298f3c86af2527c641b86c5bfe0f9f66e8de9d8e9dd205c1b477a`.
- [2015–16 pbpstats possession archive](https://raw.githubusercontent.com/shufinskiy/nba_data/e829d4678be1e075f99e5d41a1c5f97089be446b/datasets/pbpstats_2015.tar.xz),
  SHA-256 `43470995870cdaea1eb727dcb03909c47bbf549e87abc2f286f32297b011a56c`.

Poppler's `pdftotext -layout` reads the first final-box page. The adapter checks
its heading, fixed statistics columns, exact team/jersey binding (including `00`),
player names and five opening starters per team. Both final-box pages were also
rendered and visually inspected. Gamebook minutes, field goals and points are
independent constraints on the event-based reconstruction. They do not prove
frame-accurate substitution timing.

## Versioned reconstruction rules

`basketball-lineups-v1` is implemented in
`packages/bkbdata/src/bkbdata/lineups.py`. `make contract` exports
`config/lineups-v1.json` and `schemas/lineups-v1.schema.json`.

1. Keep source CSV row order within each period. Game-clock ties never reorder
   shots, free throws or substitutions. Duplicate event IDs and clock reversals
   prevent establishing a reliable order.
2. Infer each period's starting group from players whose first explicit on-court
   involvement or outgoing substitution occurs before their first incoming
   substitution. Require exactly five roster players on each team. Do not carry
   the prior period's lineup forward through an unrecorded break.
3. Use explicit shooter, assist, blocker, rebound, turnover/steal, ordinary foul
   and jump-ball participant roles. Bench/technical foul categories do not
   establish starter evidence. Check observed participant roster/team identity
   and membership in the inferred group. Opening groups must match the gamebook.
4. Apply a contiguous batch of same-clock substitutions together: remove outgoing
   players, then add incoming players. Both raw team IDs and roster teams must
   agree. Missing/duplicate outgoing players, already-active incoming players or
   a resulting group other than five remain unresolved. Non-substitution events
   between batches preserve their source ordering, even at the same clock.
5. Start a new stint after each batch; split periods explicitly. Stint duration is
   `start_clock - end_clock`. Assign shots through their verified source event
   identity and row order, including shots tied to a substitution clock.
6. Independently check every active player's summed stint seconds against the
   final box. The rounding allowance is one second per included interval boundary
   plus one gamebook rounding second. Reconcile each player's FGA, FGM and points
   (including recorded made free throws), as well as the final game score. An
   active player without a gamebook row fails validation.
7. Withhold unresolved quintets rather than repairing them. Local event/starter
   failures mark the affected interval or remainder of the period; a failed
   game-level box constraint withholds all lineup groups in that game. Reasons
   remain visible. Contracts reject stale roster, game, period and shot ownership.

CHA–TOR has **25 available stints**, 176 attempts and a final recorded score of
94–104. All 19 active-player minute checks match exactly. DEN–GSW has **33
available stints**, 191 attempts and a final score of 108–111, including overtime.
Its 19 active-player minute checks differ by at most one second. Stint duration
sums are 2,880 and 3,180 seconds; player-time sums are exactly ten times those
durations. Every audited shot belongs to exactly one stint.

Recorded event-order score allocation differs from official individual plus-minus
for some players around dead-ball substitutions. The discrepancy is retained in
the verification evidence, and the UI shows **recorded home margin** instead of
presenting the derived allocation as an official impact statistic. No score-driven
lineup repair is used.

## Possession records and the unavailable total

The pbpstats CSV repeats whole-possession fields across exploded description
rows. Deduplicate by every whole-record field except `DESCRIPTION` and `URL`,
retain the full event text, and bind offense through the recorded opponent.
This produces **175 records from 382 rows** for CHA–TOR and **199 records from
425 rows** for DEN–GSW.

The possession archive's field-goal totals do not fully reconcile:

- TOR has 90 provider attempts versus 91 in the official box; CHA reconciles at 85.
- GSW has 84 provider attempts versus 86 in the official box; DEN reconciles at 105.

Both games therefore expose **null total possession counts**, with the source
coverage reason. The UI can inspect overlapping provider records, but neither
their count nor the raw CSV row count is labeled a complete possession count.
An interval crossing a substitution boundary, or touching a tied substitution
clock, remains unallocated to an exact stint. Strict interior containment is
required even if future source totals reconcile. No estimated `FGA + .44 × FTA`
formula substitutes for a reconstructed possession count.

## Location-only shot model

`basketball-location-model-v1` is defined in
`packages/bkbdata/src/bkbdata/shot_model.py` and exported to
`config/location-model-v1.json`. It predicts a recorded field-goal make using
**only basket-relative lateral and forward coordinates**, quantized onto the
existing fixed 2.5 ft hexagons. Player, team, lineup, action type, shot value,
defenders, fatigue and passing options are not features.

The source season contains 207,893 attempts. Exclude event-unmatched attempts and
coordinates outside the fixed half-court; these categories can overlap. The
remaining **207,395 attempts in 1,230 games** are split by complete game date:

- **Training:** 2015-10-27 through 2015-11-30; 261 games / 43,819 attempts.
- **Calibration:** 2015-12-01 through 2015-12-31; 228 games / 38,145 attempts.
- **Test:** 2016-01-01 through 2016-04-13; 741 games / 125,431 attempts.

For each fixed cell, fit
`p_raw = (training makes + 20 × overall training FG%) / (training attempts + 20)`.
Unseen training cells use the training mean. Fit weighted monotone isotonic
regression to calibration-game outcomes at these frozen probabilities using the
pool-adjacent-violators algorithm. Equal inputs pool together. Prediction uses a
right-boundary step function between calibration blocks and holds the end blocks
outside the calibration range, clipped to 1–99%. Test outcomes fit neither stage.

The artifact records all train/calibration/test game IDs, dates, attempts,
definition, fitted blocks/cells, feature availability, exclusions, source/catalog
and implementation fingerprints, evaluation metrics and limitations. No tracking
window enters fitting, so overlapping tracking observations cannot cross splits.

The comparison baseline predicts the overall training FG% everywhere. Held-out
results are:

- **Brier:** 0.234226 versus 0.248326 for the constant baseline (lower is better).
- **Log loss:** 0.661182 versus 0.689799.
- **ECE:** 0.003725, or about 0.37 percentage points, across ten fixed probability bins.
- **95% game-bootstrap Brier difference:** −0.014800 to −0.013411.

Uncertainty uses 200 deterministic whole-test-game bootstrap resamples, seed
20261015, with interpolated percentile bounds. The calibration plot and table
show observed test FG%, predicted rates, counts and 95% intervals. Empty prediction
bins stay empty. This model produces only three occupied test prediction bins;
no curve is invented between them. Intervals describe variation across held-out
games, not uncertainty for an individual shot or uncertainty from refitting the
training/calibration samples.

The declared gate requires at least 100 games in every split, ECE ≤ 0.025 and a
negative upper 95% bound for Brier difference against the constant baseline. The
historical model passes. Gate results are diagnostic, not a claim of modern-season
transfer or calibrated probabilities under distribution shift. The location map
uses a fixed probability color scale; cells with fewer than 25 training attempts
are faint, and their counts/fallback behavior are inspectable.

**Learned movement forecasts remain deferred.** Two tracking games do not support
a convincing training/validation/test evaluation of a richer predictor. No
movement prediction overlay is added. A later forecast must beat declared simple
baselines on separate held-out games before being exposed in replay.

## Reproduce and verify

For gamebook extraction, install Poppler (`brew install poppler` on macOS) if
`pdftotext` is unavailable. It is only required for the explicit offline lineup
build, not serving an existing index or running generated-fixture CI tests.

```sh
make lineup-fetch          # pinned PBP, gamebooks and possession cache
make lineups               # requires the audited M0 catalog
make shot-model            # requires the M2 atlas
make api                   # read-only local API on 8007
make dev                   # port 5177
uv run python scripts/verify_lineups.py
make lint test web-build
make contract fixtures
npm --prefix apps/web run preview    # separate terminal, port 5178
BASKETBALL_ORIGIN=http://127.0.0.1:5178 npm --prefix apps/web run test:browser
npm --prefix apps/web run verify:lineups
```

New read-only endpoints are `GET /lineups/options`,
`GET /lineups/games/{game_id}` and `GET /models/location`. They return setup
guidance for missing outputs, reject source/implementation drift with rebuild
instructions, and never fit or reconstruct data as a side effect of browsing.
Builds publish outputs through temporary files. Source checksums, implementation
identity and definitions prevent stale cache reuse.

Local validation passes **79 Python tests**, **39 web unit tests**, and **58
desktop/mobile browser checks**, with type checking, Python lint and production
build passing. Generated fixtures cover tied-clock shots/substitution batches,
minute/stat failures, missing events, conflicting identity, incomplete possessions,
known isotonic solutions, deterministic whole-game bootstrap and test-outcome
leakage checks. Fixture and schema regeneration are stable.

The offline real-source verifier checks every stint, all 367 shot memberships,
substitution identities, five-player groups and player-time conservation. An
independent per-shot DuckDB calculation reproduces the model's Brier score, log
loss and baseline loss within `1e-12`, and confirms all 1,230 split game IDs are
disjoint. Cached rebuild reuse passes. The real-data browser verifies 12 filtered
stint counts, a real shot-to-replay handoff and return, rotation bars, gamebook
tables, model readouts and 390 px layout. Screenshots were inspected.

Evidence: [`m5-data-verification.json`](../artifacts/m5-data-verification.json),
[`m5-browser-verification.json`](../artifacts/m5-browser-verification.json),
[desktop rotations](../artifacts/m5-lineups-desktop.png),
[desktop model](../artifacts/m5-model-desktop.png),
[mobile stint](../artifacts/m5-stint-mobile.png), and
[mobile model](../artifacts/m5-model-mobile.png).

Raw gamebooks, trajectories, source archives, the lineup database and fitted model
remain in ignored local `data/`. Redistribution permission and hosted behavior
remain unverified. CI is configured; no GitHub run or hosted release was performed
for this milestone.
