# Basketball Motion Lab — Implementation Plan

Status: Milestones 0–3 implemented and locally verified on 2026-10-15. Milestones 4–5 remain planned. See `docs/data-audit.md`, `docs/milestone-1.md`, `docs/milestone-2.md`, and `docs/milestone-3.md` for measured evidence and unresolved source-window timing limits; CI is configured but has not run on GitHub.

Created: 2026-10-15.

## Product objective

Build a local-first basketball visualization app that connects a shot atlas to a possession explorer. The signature workflow is:

> Select a shot on the court, inspect the movement that preceded it, and compare it with similar attempts.

Combine the baseball project's spatial comparisons and reliability-aware heatmaps with the football project's replay, linked measurements, and explicit data provenance. Use one application with three connected views:

- **Shot Atlas:** broad historical shot analysis, with newer seasons added when their source coverage is verified.
- **Tracking lab:** observed player and ball movement in the historical games with audited tracking coverage.
- **Off-ball explorer:** curated movement sequences, focused-player measurements, and time-aligned comparisons with explicit annotation uncertainty.

Tracking availability is a property of each game and event. A shot without tracking remains useful in the atlas and reports why replay is unavailable.

## Scope and priorities

The first release should demonstrate one complete, polished workflow using a small set of real games. Prioritize understandable examples, accurate synchronization, and responsive interaction before broad ingestion or advanced modeling.

Build in this order:

1. Audit representative sources and establish data contracts.
2. Deliver shot selection linked to a real tracking replay.
3. Expand the shot atlas and player/season comparisons.
4. Add off-ball movement exploration and curated action annotations.
5. Add geometric sequence search and comparison.
6. Add lineup context and optional evaluated models.

Defer live feeds, video-based tracking reconstruction, automated defensive assignments, pass-versus-shoot recommendations, and full expected-possession-value models. Do not synthesize modern player trajectories from shot locations or aggregate tracking statistics.

## Data sources and acquisition

Candidate sources from the initial research:

- [NBA Player Movements](https://github.com/linouk23/NBA-Player-Movements): historical SportVU archives and example replay code; primary tracking candidate.
- [NBA Movement Data](https://github.com/sealneaward/nba-movement-data): related archive, conversion code, and shot-timing work; use for cross-checking and comparison, avoiding duplicate game ingestion.
- [Hugging Face tracking dataset](https://huggingface.co/datasets/alexcollins535/nba_tracking_data_15_16): supplementary schema and enrichment reference. Its card acknowledges missing coordinates and overlapping event windows; validate the loader and underlying files before relying on it.
- [nba_data](https://github.com/shufinskiy/nba_data): candidate bulk historical shot and play-by-play archive. Its documented season range is a claim to verify against files and game coverage.
- [nba_api ShotChartDetail](https://github.com/swar/nba_api/blob/master/docs/nba_api/stats/endpoints/shotchartdetail.md): shot schema and optional incremental acquisition adapter.
- [hoopR](https://github.com/sportsdataverse/hoopR): alternative acquisition source to evaluate if primary shot or play-by-play coverage is insufficient.
- [pbpstats](https://pbpstats.readthedocs.io/en/latest/): candidate possession and lineup reconstruction dependency; compare its outputs with raw events and retain repair provenance.

Keep immutable raw downloads with source URL, acquisition date, checksum, source version where available, and access/redistribution notes. Prefer cached bulk files for reproducibility. Put remote acquisition in Python rather than making NBA requests from the browser. A remote outage must not prevent already imported games from loading.

Public accessibility and a repository's code license do not establish redistribution permission for its data. Keep raw files out of Git; establish what can be distributed before a public deployment. Local development and public-release checks are separate milestones.

## Architecture

Start with a small Python data package, DuckDB over typed Parquet, a read-only FastAPI service, and a React/TypeScript application built with Vite. Follow the existing sports projects' conventions without copying sport-specific assumptions.

```text
packages/bkbdata/       source adapters, normalization, validation, joins, exports
apps/api/              read-only catalog, shot, game, and replay endpoints
apps/web/              court, replay controls, linked charts, comparisons
data/raw/              immutable downloaded inputs (gitignored)
data/lake/             normalized Parquet (gitignored)
data/db/               DuckDB catalog and analytical views (gitignored)
data/exports/          compact versioned replay bundles (gitignored)
tests/fixtures/        small generated or redistribution-cleared fixtures
docs/                  source audits and measurement definitions
artifacts/             selected verification reports and UI screenshots
```

Use SVG for the initial court, player markers, overlays, and charts. Consider Canvas/WebGL for dense shot layers only after measuring a bottleneck. Keep coordinate transforms independent of rendering. Precompute replay measurements; playback should select a frame, not rerun analytics.

The key interface is a versioned replay bundle. It contains identities, source timestamps, normalized positions, events, quality flags, and provenance, and can be consumed through the API or a local file import. Keep summaries small and fetch frame data only when opening a replay.

## Data contracts and measurement rules

- Preserve source IDs as strings, including leading zeros. Namespace provider-specific event IDs; never assume two feeds share an event identifier without validation.
- Separate games, players, teams, shots, play-by-play events, reconstructed possessions, tracking segments, and annotations. A source event window is not automatically a possession.
- Preserve raw coordinates and define explicit transforms into court feet. Record source units, origin, axes, basket location, and orientation. Verify transforms with court landmarks and real shot examples.
- Offer normalized attacking direction for comparison while retaining source orientation. Unknown direction remains unavailable; do not silently mirror or reflect paths.
- Keep original sample timestamps, period, game clock, and shot clock. Validate nominal tracking cadence against actual observations. Repeated clock values, dead balls, and discontinuities require explicit handling; game-clock differences alone are not a universal elapsed-time axis.
- Reconcile overlapping event windows without dropping conflicting observations silently. Deduplicate using source identity and time information, preserve conflicts, and mark gaps. Do not interpolate across discontinuities to make a replay appear complete.
- Distinguish event timestamp, estimated shot release, and verified release. Event timestamps can describe a result rather than the instant the ball leaves a hand.
- Shot-to-event and event-to-tracking joins report `matched`, `ambiguous`, `unmatched`, or `unavailable`, with method and timing confidence. Ambiguous joins do not open a replay as though verified.
- Every measurement identifies its basis: recorded, derived, annotated, or modeled. Missing values remain null with a reason.
- Nearest-defender distance measures proximity, not defensive assignment or contest quality. Team spread measures geometry, not offensive effectiveness. Passing-lane clearance does not establish completion probability.
- Derived speed requires a documented differentiation and smoothing policy and valid elapsed time. Ball possession and catches require validated inference or explicit annotation; nearest player alone is insufficient.

## Milestone 0 — Source audit and foundations

Implemented: Python/React scaffolds, pinned acquisition, offline Parquet/DuckDB ingestion, quality and join audit, read-only API, versioned replay export, inspection screen, tests, and CI configuration. Two real games were audited, with all 367 shots matched to play-by-play and 234 matched to tracking event windows. Structural continuity is measured per source window; complete possessions, attacking direction, and exact release timing remain unavailable. Implementation evidence is in `docs/data-audit.md`, `docs/data-contracts.md`, and `artifacts/audit-summary.json`.

Tasks:

- Scaffold the Python and web projects, standard development commands, and CI.
- Obtain a small representative set of tracking games and corresponding shots/play-by-play; choose games after inspecting actual availability.
- Inventory game IDs, teams, dates, periods, frame coverage, entity counts, duplicates, coordinate bounds, and clocks.
- Test candidate shot/event joins and inspect tracking around several attempts, including misses and incomplete windows.
- Define the normalized schemas, coordinate transforms, provenance manifest, quality findings, and replay-bundle version.
- Write `docs/data-audit.md` with measured coverage, example problems, source selection, and unresolved limitations.

Acceptance:

- At least one real game can be parsed and inspected end to end.
- Coordinate units/orientation and timing behavior have independent checks against identifiable court events.
- The audit counts successful, ambiguous, and failed joins and complete versus partial windows.
- Ingestion is repeatable and idempotent for unchanged inputs.
- If complete possessions cannot be recovered reliably, the first release explicitly presents validated tracking segments; it does not invent missing action.

## Milestone 1 — Shot to replay vertical slice

Implemented: player/result shot filters, automatic matched-window loading, full-court player/ball replay, selectable players, frame/time controls and keyboard navigation, approximate event jumps, fading trails, opponent connectors, team-spread overlays, and synchronized distance/speed charts. Missing entities, conflicts, gaps, partial windows, and unavailable matches have explicit states. Basket references remain geometric because attacking direction is unverified. Local validation passed 24 Python tests, 21 web unit tests, 16 desktop/mobile browser checks, and 243 independent finite numerical comparisons across nine real windows. Playback callback timing and screenshots are recorded in `artifacts/m1-verification.json` and `docs/milestone-1.md`. Exact release timing and complete possessions remain unavailable.

Tasks:

- Build a game browser and per-game shot chart with player and result filters.
- Link selected shots to validated tracking windows and provide visible availability states for all others.
- Render a full court, ten player markers when available, and the ball, with consistent team colors and selectable players.
- Add play/pause, frame stepping, speed control, keyboard navigation, and event jumps.
- Add short fading movement trails and optional nearest-defender connectors.
- Link the playhead to selected-player distance-to-basket, nearest-defender-distance, and validated speed charts.
- Add an optional team-spread overlay with its definition and tracked-player count.
- Display game/shot clocks, source labels, quality findings, and partial-window boundaries.
- Curate a small gallery of useful examples after the data audit; explain what to inspect in each.

Acceptance:

- A user can select a real shot, open its matched replay, scrub it, and inspect synchronized geometry without manual data preparation in the UI.
- All rendered measurements agree with independent fixture calculations within documented numerical tolerances.
- A gap, ambiguous match, missing ball, or missing player is visible and does not silently become a plausible trajectory or zero-valued metric.
- Court, timeline, and charts share one time-selection state and remain synchronized during playback and seeking.
- Playback is profiled on a documented reference machine; target smooth 60 Hz presentation while preserving source sample timing. Report observed results rather than claiming universal performance.
- Browser verification covers the main workflow, keyboard controls, narrow-screen layout, and unavailable states; inspect screenshots at desktop and mobile widths.

## Milestone 2 — Shot atlas and historical comparison

Implemented: four season archive pairs, 856,050 recorded attempts, shared comparison filters, fixed hexagons, four metric views, small multiples, linked distance distributions, inspectable attempts, and audited replay handoff. Optional contours remain deferred. See `docs/milestone-2.md` for measured coverage and exact definitions.

Tasks:

- Expand cached shot ingestion across verified seasons with per-season coverage reports and resumable acquisition.
- Add player, team, season, opponent, period, and shot-type filters where fields support them.
- Provide separate frequency, field-goal percentage, field-goal points per attempt, and same-season baseline-difference views.
- Use inspectable hex bins first; add optional smoothed contours with documented bandwidth and effective sample-size masks.
- Use a fixed court grid, common color scales, and shared filters for side-by-side player or season comparisons.
- Normalize shot-selection comparisons per 100 attempts while showing raw sample counts.
- Add season small multiples and linked shot-distance distributions.
- Let a selected region open its attempts and preserve the replay link where tracking exists.

Acceptance:

- Aggregates reconcile with their underlying attempts and reported filters.
- Field-goal points per attempt includes the recorded two/three-point value and is not labeled points per possession; free throws and offensive rebounds are outside that metric.
- Sparse cells are faded or unavailable using an explicit reliability rule; smoothing does not blend across the three-point boundary without accounting for shot value.
- League comparisons specify the baseline population, season, sample counts, and whether the estimate is descriptive or modeled.
- Historical coverage and tracking coverage remain independently visible.

## Milestone 3 — Off-ball movement explorer

Implemented: versioned source-bound curation, three provisional historical sequences, focused-player replay, linked separation/heading charts, relative-time comparisons with visible uncertainty/offsets, and an offline held-out evaluation gate. Automatic labels remain disabled because validated exhaustive ground truth is unavailable. See `docs/milestone-3.md`.

Tasks:

- Add a curated, versioned annotation format for catches, screens, cuts, relocations, and uncertain events.
- Focus the replay on a selected player, with other trails dimmed and linked separation/direction charts.
- Compare short sequences aligned at an annotated or validated catch or release.
- Show actual elapsed time and alignment offsets; make any temporal rescaling explicit.
- Evaluate candidate detection heuristics against held-out annotated examples before exposing automatic labels.

Acceptance:

- Users can inspect and compare the movement before a catch without confusing inferred events with source annotations.
- Annotation provenance and confidence are inspectable.
- Automated labels, if shipped, have measured precision/recall and failure examples; an uncertain state is supported.

## Milestone 4 — Geometric action atlas

Tasks:

- Build miniature-court thumbnails for curated or consistently segmented movement sequences.
- Start similarity search with one selected player's path over a defined window.
- Define time sampling, coordinate normalization, spatial translation, duration treatment, and exclusions in the similarity contract.
- Provide side-by-side replay and limited path overlays with sample counts and geometric distances in feet.
- Explore multi-player matching only after defining player-role correspondence and evaluating retrieval quality.

Acceptance:

- Similarity can be reproduced from a versioned feature definition and source fingerprint.
- Ranking uses only the stated movement features; shot outcome and future events do not enter unnoticed.
- Retrieval is described as geometric similarity, not proof of an identical play call or assignment.

## Milestone 5 — Lineup context and evaluated models

Tasks:

- Add reconstructed lineup stints, substitutions, score margin, and linked shots/possessions.
- Validate lineup reconstruction against event and box-score constraints; retain unresolved stints as unavailable.
- Consider a location-based shot-make model with calibrated probabilities and uncertainty, followed by richer models only where their inputs exist.
- Evaluate optional short-horizon movement forecasts against simple baselines before adding prediction overlays.

Acceptance:

- Selecting a lineup stint updates linked views and displays possession/attempt counts.
- Lineup comparisons are descriptive and do not imply causal player impact.
- Model evaluation splits by game, with temporal holdouts where appropriate; overlapping windows from one game cannot cross splits.
- Model artifacts record feature availability, source fingerprint, train/evaluation games, calibration or error measures, and exclusions.
- A model using shot location alone is labeled accordingly and does not imply knowledge of defenders, fatigue, or unobserved passing options.

## Interaction and visual design

Use a restrained court with readable markings, consistent team colors, and one emphasized analytical layer at a time. Keep top-down replay as the default. Prioritize linked inspection over a large collection of disconnected charts.

Selection and filters should persist when moving between the atlas and replay. Include clear reset controls, useful empty states, accessible labels, color-independent make/miss marks, and reduced-motion behavior. On narrow screens, stack court and charts while keeping playback controls accessible.

An optional oblique ball view can follow later if ball height and timing pass validation. Do not derive a supposedly measured flight arc from a shot's start location. Save/share view state only when its referenced dataset can be resolved in the destination environment.

## Verification and release gates

- **Data:** measured coverage; deduplication/conflict handling; identity checks; coordinate transforms; timing continuity; source-event joins; reproducible quality reports.
- **Numerical:** independently calculated geometry fixtures, including rotation invariance, known distances, missing entities, and discontinuous timestamps.
- **Integration:** ingest to catalog to API to replay, including partial and unavailable data. Use generated fixtures for edge cases and cleared real samples for source compatibility.
- **UI:** browser workflow checks and screenshot inspection for court readability, synchronized selection, overlays, responsive controls, and sparse-data displays.
- **Performance:** measure ingest time/memory, query latency, bundle size, and playback on a stated dataset and machine before optimizing.
- **Public release:** separately verify redistribution basis, deployed routes, asset loading, and hosted browser behavior. Passing local tests does not establish a live release.

## Immediate implementation sequence

1. Begin Milestone 2 with verified shot-source coverage, cached season ingestion, and frequency/efficiency comparisons.
2. Preserve the Milestone 1 replay contract, measurement definitions, and explicit availability states as the atlas expands.
3. Investigate the source event-window/clock mismatch before claiming release alignment or expanding replay joins; keep action recognition and automatic tactical labels in their later milestones.

The first milestone succeeds when a real shot leads to a trustworthy, inspectable movement sequence—not merely when a court animation runs.
