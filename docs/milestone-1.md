# Milestone 1 — Shot to replay

Implemented locally on 2026-10-15. The live development app is served at
`http://127.0.0.1:5177`; production preview uses port 5178. Both use the read-only
API on port 8007. GitHub CI is configured; hosted verification has not run.

## User workflow

Choose an imported game, filter attempts by player and made/missed result, then
select a shot on the court or in the attempt selector. A verified tracking join
loads its source event window automatically. Unmatched, ambiguous, or unavailable
joins show their reason and clear the preceding replay.

The gallery starts with audited examples from the selected game. Charlotte–Toronto
offers Cody Zeller's made attempt (event 5), Nicolas Batum's missed attempt (event
16), and Marvin Williams's partial window (event 47). Denver–Golden State has its
own audited examples. Gallery selection resets shot filters to expose that attempt;
ordinary replay controls preserve the current game, shot, and filters.

Use Play/Pause, the frame slider, step buttons, 0.25×/0.5×/1×/2× speed, start/end,
approximate shot-event jump, recorded event selector, and next-break jump.
Focus the replay region for Space, left/right arrows, Shift+arrow ten-frame steps,
Home, and End. Native form controls retain their keyboard behavior.

Select a player on the court or with the tracked-player selector. The court,
timeline, three charts, and displayed clocks share one observed-frame index.
Click a chart to seek; keyboard users can use the frame slider. Movement trails
cover at most the preceding 1.2 seconds. Optional overlays show nearest-opponent
geometry and team spread.

## Time and incomplete observations

Playback uses original millisecond timestamps and advances through observed
frames without interpolating positions. A browser animation callback schedules
updates; recorded positions still have nominal 25 Hz cadence.

At a discontinuity, playback jumps to the first observation after the break and
pauses with an explicit notice. It does not hold the last position throughout
missing elapsed time. Stepping, seeking, or pressing Play continues from the
observed frame. Playback also pauses when the tab becomes hidden. It never starts
automatically, including for reduced-motion users.

Missing players or ball observations disappear. Conflicting timestamp positions
are hidden and their measurements are unavailable. Duplicate identities and
roster/team mismatches are excluded from geometry. Trails and chart lines break
across gaps, unavailable positions, and conflicting timestamps. Missing values
remain unavailable rather than becoming zero.

Recorded event clocks produce candidate bands within ±1 game-clock second, shown
in amber. Jumps select a nearest-clock observation only when the candidate band
is connected. Disjoint bands are ambiguous and cannot be selected as a single
event jump. These bands and jumps do not identify shot release. Rust markers
identify tracking breaks.

## Measurement definitions

All geometry uses source court feet; attacking direction remains unavailable.
Every replay precomputes measurements before playback, then selects the current
snapshot. Changing player selection projects those snapshots into chart series.

- **Basket distance:** Euclidean distance from the observed player to a chosen
  reference rim. The default is the nearer of `(5.25, 25)` and `(88.75, 25)`;
  left/right references are explicit alternatives. “Nearer” can change as a
  player crosses the court and does not mean that player's attacking basket.
- **Nearest tracked opponent:** minimum Euclidean distance to an observed player
  on the other team. It requires all five opponent identities to be present and
  consistent. Otherwise distance and connector are unavailable. This describes
  team-based proximity, not defensive assignments or contest quality.
- **Movement speed:** magnitude of the two-dimensional linear least-squares
  velocity fitted to five consecutive player observations ending at the current
  frame, using actual source timestamps. This is a backward-looking smoothing
  window of about 0.16 seconds, with no future data, speed clipping, or imputation.
  Insufficient or interrupted history makes speed unavailable. A genuine zero
  stationary speed remains a valid measurement. It is a derived estimate from
  noisy source positions, not a separately measured velocity feed.
- **Team spread:** RMS distance of tracked team members from their centroid.
  Circles use that RMS as radius. Counts are shown as tracked/5; partial teams use
  dashed circles. With fewer than two players, RMS spread is unavailable. This is
  descriptive geometry and does not identify offensive or defensive quality.

Game clock is displayed to hundredths, shot clock to tenths, and ball height in
feet. Missing or source-flagged invalid clock/height values are unavailable.
Ball height does not imply an inferred flight arc or release detector.

## Numerical verification

The shared generated fixture in `tests/fixtures/m1-constant-motion.json` uses
analytic `(3, 4)` ft/s motion, a known five-foot opponent gap, and Decimal-derived
rim distances and RMS spread. It contains no NBA records. Python validates the
bundle contract; TypeScript checks the measurement results and availability.
CI regenerates the fixture and JSON schemas to detect drift.

`scripts/replay_reference.py` independently computes selected observations from
nine real windows: eight curated windows plus a Denver window with timestamp
conflicts. Its velocity reference uses uncentered normal equations; RMS uses the
pairwise-distance identity, separately from the browser's centered calculations.

The browser verification compares three basket references, opponent distance,
speed, team counts, RMS spread, and null availability. The measured run includes
243 finite numerical comparisons and 280 availability checks, all within `1e-8` in the corresponding feet
or feet/second units. Maximum observed speed difference is about `3.2e-13` ft/s;
other numeric differences are below `1.5e-14` ft. This is computational parity,
not a statement about the physical accuracy of source tracking.

Reproduce locally after source ingestion:

```sh
make test lint web-build contract fixtures
uv run python scripts/replay_reference.py
make api                       # terminal 1
make dev                       # terminal 2
npm --prefix apps/web run preview  # terminal 3, after web-build
npm --prefix apps/web run verify:real
```

The final command needs API, dev, and preview servers running.
Its local reference file stays under ignored `data/exports/`. Aggregate results
and implementation fingerprints are saved in `artifacts/m1-verification.json`.

## Browser and performance evidence

Local validation passed 24 Python tests, 21 web unit tests, and 16 browser checks
across desktop and mobile, plus lint, typecheck, and production build. The
production-preview browser suite also passed. CI is configured but has not run
on GitHub.

The test suite covers desktop and 390px mobile layouts, real shot-to-window
navigation, player/result filters, keyboard stepping, chart seeking, basket
reference selection, overlays, missing ball/player observations, timestamp
conflicts, gap pausing, invalid payloads, and clearing stale replays.

Screenshot review is recorded in `artifacts/m1-replay-desktop.png`,
`artifacts/m1-replay-mobile.png`, and `artifacts/m1-replay-mobile-panel.png`.
The real partial-window check inspects Marvin Williams event 47 at frame index
333, where the ball is absent. An unmatched Denver attempt clears player markers
instead of retaining the previous window. Mobile verification reports no
horizontal page overflow and no browser page errors.

Playback profiling uses the 550-frame Cody Zeller window at 1× in a local
production preview, with movement trails, nearest-opponent connector, and team
spread enabled. The reference environment is Apple M1 Pro, Darwin ARM64, headless
Chromium 156, and a 1440×1100 viewport. A roughly three-second run measured
animation callbacks around 16.7 ms median and 16.8 ms at the 95th percentile, with
no callback interval over 33.4 ms and about 74 observed-frame updates. The callback
cadence is consistent with a 60 Hz scheduler; coordinate updates remain at source
cadence. This does not prove GPU-presented frame rate or performance on other
devices. Exact observations are in the verification JSON.

## Remaining boundaries

The two-game sample and conservative join rules remain unchanged: all 367 shots
match play-by-play, and 234 match tracking event windows. The source event-window
clock mismatch remains unresolved. For example, Cody Zeller event 5's nearest
event-clock observation places the ball at 2.8 ft height, while another nearby
observation at clock 685.95 has it at 10.4 ft. This supports treating event time
as context; it does not establish release time or justify an automatic offset.

Complete possession reconstruction, attacking-direction labels, catches,
screens, assignments, and release detection remain unavailable. Historical shot
atlas expansion and season/player comparisons begin in Milestone 2. Public
redistribution and hosted release validation remain separate future gates.
