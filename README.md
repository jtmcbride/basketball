# Basketball Motion Lab

A local-first NBA shot atlas and historical tracking explorer. Select an attempt,
replay its observed player/ball movement, and search similar player paths. See
[PLAN.md](PLAN.md) for the implementation sequence.

## Development

Requires Python 3.11+ (3.13 recommended), uv, and Node 24 (`nvm use`).

```sh
make setup
make fetch       # explicit network download; immutable local cache
make audit       # offline ingest, validation, Parquet/catalog, audit report
make atlas-fetch # cache four pinned season shot/PBP archive pairs
make atlas       # offline historical atlas with per-season coverage reports
make actions     # offline geometric path index from audited tracking
make lineup-fetch # pinned official gamebooks and possession archive
make lineups     # offline rotations and independent box-score constraints
make shot-model  # fit/calibrate/evaluate a historical location-only baseline
make api         # read-only API at http://127.0.0.1:8007
make dev         # shot atlas and replay at http://127.0.0.1:5177
```

Raw files and generated datasets remain in ignored `data/` directories. The
initial source list is pinned in `config/sources.json`; each download records a
checksum and acquisition manifest. A second fetch verifies the cache without
network access. The app never calls NBA endpoints from the browser.

```sh
make test
make web-build
make lint
npm --prefix apps/web run test:browser
```

## Lineup context and evaluated model (Milestone 5)

Open `http://127.0.0.1:5177/#lineups` or choose **Lineup context**. Follow **58
reconstructed stints**, compare both five-player groups and their shot samples,
inspect substitutions and recorded score margin, and open linked tracking replay.
All 367 audited attempts are assigned by event order. Gamebook minutes, starters,
field goals and points constrain reconstruction; unresolved groups stay unavailable.

The separate location-only model uses 261 training, 228 calibration and 741 test
games from 2015–16. Inspect calibrated location probabilities, held-out counts,
calibration error and whole-game bootstrap intervals. Test Brier score is 0.2342
versus 0.2483 for a constant-rate baseline. No defenders, fatigue, player identity
or passing options enter the model.

Provider possession coverage does not reconcile with the official boxes, so total
possession counts remain unavailable while partial records remain inspectable.
Lineup samples are descriptive; recorded score changes are not causal impact or
official player plus-minus. Learned movement forecasts remain deferred.

Build with `make lineup-fetch`, `make lineups` and `make shot-model`. The lineup
build requires Poppler's `pdftotext` (`brew install poppler` on macOS). Read the
[Milestone 5 definitions and evidence](docs/milestone-5.md), reproduce source and
model checks with `uv run python scripts/verify_lineups.py`, and check the real
browser workflow with `npm --prefix apps/web run verify:lineups`.

## Geometric action atlas (Milestone 4)

Open `http://127.0.0.1:5177/#actions` or choose **Action atlas**. Search **31,631
single-player paths** from the two audited tracking games. Compare shape with
starts aligned or retain original court location, inspect miniature source courts
and all 21 scored sample pairs, then replay the query and match together. Reuse a
match as the next query or enter from an off-ball annotation reference.

The versioned feature uses two seconds of observed movement, actual timestamps,
strict continuity checks and RMS distance in feet. Overlapping footage is
suppressed; same-player and other-game filters are available. Geometric similarity
does not establish an identical action, play call or assignment. Multi-player
matching remains deferred.

Run `make actions` after `make audit`. Read the
[Milestone 4 definition and verification](docs/milestone-4.md), reproduce source
checks with `uv run python scripts/verify_actions.py`, and run the real-data
browser workflow with `npm --prefix apps/web run verify:actions`.

## Off-ball movement explorer (Milestone 3)

Open `http://127.0.0.1:5177/#movement` or choose **Off-ball explorer**. Compare
curated player sequences on a shared relative clock, dim other players/trails,
and inspect linked opponent separation, ball separation, and movement heading.
Each pane shows actual sample times, alignment offsets, annotation confidence,
reviewer provenance and timing uncertainty. Missing observations remain visible.

The initial three sequences contain five **provisional tracking-review annotations**;
they are not independently validated catches or releases. A versioned annotation
schema and source binding protect against stale references. An offline candidate
evaluation gate withholds automatic labels because held-out ground truth is
insufficient. No temporal warping or invented trajectories are used.

Read the [Milestone 3 definitions and verification](docs/milestone-3.md). Validate
curation with `uv run basketball annotations`, generate numerical references with
`uv run python scripts/movement_reference.py`, and run the production workflow
with `npm --prefix apps/web run verify:movement`.

## Historical shot atlas (Milestone 2)

Open `http://127.0.0.1:5177/#atlas` or select **Shot atlas**. Compare players and
seasons with shared team, opponent, period, and 2PT/3PT filters. Inspect frequency,
FG%, field-goal points per attempt, and descriptive same-season FG% differences
on fixed hexagons with common scales and explicit sparse-sample rules.

Four verified archive pairs contain 856,050 shot-chart attempts across 4,920
games: 2015–16, 2016–17, 2023–24, and 2024–25. Season small multiples, region-linked
distance distributions, paginated underlying attempts, replay links, and coverage
reports are included. Tracking still covers only the two separately audited games.
PBP discrepancies remain disclosed; archive agreement is not an official schedule
check. No smoothed surface or shot-quality model is implied.

Read the [Milestone 2 definitions and verification](docs/milestone-2.md).
Reproduce the raw-source checks with `uv run python scripts/verify_atlas.py` and
the real preview workflow with `npm --prefix apps/web run verify:atlas`.

## Shot to replay (Milestone 1)

- Per-game shot charts with player and make/miss filters, plus audited examples.
- Full-court recorded player/ball replay, player selection, fading movement trails,
  and optional nearest-opponent and team-spread overlays.
- Play/pause, frame slider, 0.25×–2× speed, keyboard stepping, approximate event
  jumps, and automatic pauses at tracking breaks.
- Synchronized basket-distance, opponent-distance, and derived speed charts;
  click a chart to seek the court to the same observed frame.
- Explicit missing-player/ball, partial-window, conflicting-timestamp, ambiguous
  event-time, and unavailable-match states.

Read the [Milestone 1 verification and definitions](docs/milestone-1.md).

## Data foundations (Milestone 0)

- Pinned downloads with expected SHA-256 checksums and acquisition manifests.
- Offline normalization into typed Parquet and a read-only DuckDB catalog.
- Exact-overlap deduplication with conflicting observations and original window
  memberships retained.
- Measured cadence, identity, field availability, coordinate, and join checks.
- Versioned shot, event, and replay contracts with JSON schemas.
- A responsive game/shot/coverage inspection screen and local API.
- Generated-fixture tests and a GitHub Actions workflow.

The initial sample contains Charlotte–Toronto (2016-01-01) and Denver–Golden State
(2016-01-02, including overtime): 367 shots and 174,820 distinct tracking
observations. All 367 shots match play-by-play; 234 match tracking event windows
under the current ID/metadata/clock checks. A matched window can still be partial.

Read the [measured source audit](docs/data-audit.md),
[data contracts](docs/data-contracts.md), and
[aggregate evidence](artifacts/audit-summary.json) for definitions and limitations.
Real data is used locally; generated test fixtures are explicitly labeled.
Exact release detection and complete possession reconstruction remain unavailable.
CI is configured; it has not been run on GitHub.

## Inspect and export

```sh
uv run basketball games
uv run basketball health
uv run basketball export \
  --game-id 0021500492 \
  --segment-id sportvu:0021500492:5:4 \
  --output data/exports/0021500492-event-5.json
uv run basketball validate-replay data/exports/0021500492-event-5.json
make contract
uv run python scripts/summarize_audit.py
```

The shot court shows basket-relative recorded attempts. Selecting one loads its
verified source window into the full-court replay, or displays why a match is
unavailable. Game coverage and source findings remain inspectable below the
replay. Full frames are also available through the selected-segment API and CLI
export. Player movement comes from recorded tracking positions.

For the local production preview and reproducible real-data checks, run:

```sh
make web-build
uv run python scripts/replay_reference.py
npm --prefix apps/web run preview      # separate terminal; port 5178
npm --prefix apps/web run verify:real  # API, dev, and preview must be running
```

The API defaults to `127.0.0.1:8007` and the web app to `127.0.0.1:5177`, so they
can run beside the other sports projects. For another API port, run
`uv run basketball serve --port <port>` and start Vite with
`BASKETBALL_API_URL=http://127.0.0.1:<port>`. For browser checks against an existing
web origin, set `BASKETBALL_ORIGIN`.

Raw data redistribution permission and hosted validation have not been
established. Keep `data/` out of published assets. Local verification screenshots
are in `artifacts/m1-replay-desktop.png` and `artifacts/m1-replay-mobile-panel.png`.
