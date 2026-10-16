# Milestone 4 — Geometric action atlas

Implemented and verified locally. Open `http://127.0.0.1:5177/#actions` or choose
**Action atlas**. The index contains **31,631 single-player paths** from the two
audited historical tracking games. The four-season shot atlas does not supply
additional movement coverage.

## Delivered workflow

Choose a curated reference, roster player and reference endpoint. Search the two
seconds ending at that observed frame, compare eight miniature source-court
thumbnails, and select a result for a two-path overlay and synchronized replay.
The off-ball explorer links directly to its sequence/player/annotation reference.
Any returned path can become the next query. Same-player and other-game filters
restrict the candidate pool explicitly. Filters and selection persist across tabs;
leaving the view pauses playback.

**Path shape** subtracts each path's starting position. **Path + court location**
retains source coordinates. Both report paired-position RMS distance in feet.
An expandable table exposes all 21 sample pairs, coordinates, actual timing
offsets and individual distances. The browser independently recomputes the score
and refuses inconsistent results. Only the query and selected match are overlaid;
other players and the ball appear as context in the original source replays.

Replay aligns the two actual observed starts and preserves each source duration.
Controls step through the union of recorded sample times, seek or play at
0.25×–2×. Readouts show source game clock, source-window time, relative time,
observation offset and frame counts. No positions are interpolated. Source
binding checks every intervening selected-player observation, as well as the 21
scored positions, before replay. Missing, stale or insufficient input clears the
previous geometry and explains why the query or replay is unavailable.

## Versioned feature definition

The executable definition and validator are in
`packages/bkbdata/src/bkbdata/actions.py`. `make contract` exports
`config/path-similarity-v1.json` and `schemas/path-feature-v1.schema.json`.
`basketball-path-v1` specifies:

- A nominal **2,000 ms** interval ending at a declared observed frame. There are
  **21 targets**, 100 ms apart, measured backward from that endpoint using source
  timestamps. Choose the nearest recorded observation within 20 ms; ties choose
  the earlier observation. No observation after the endpoint is used.
- Preserve actual sample timestamps and target offsets. Actual endpoint duration
  must be 1,980–2,020 ms. Every intervening selected-player observation must be
  present and unique, with consistent roster/team identity and finite coordinates
  inside the 94 × 50 ft source court. The accepted span contains 45–59 source
  observations. Nominal cadence is 40 ms with a 5 ms tolerance.
- Reject timing/period breaks, timestamp conflicts, invalid game clocks and
  game-clock increases greater than 0.1 s under the existing replay continuity rule.
  Other players and the ball do not contribute to the feature; their absence
  alone does not invalidate a selected-player path.
- Retain source axes and units. Start-relative scoring subtracts each path's own
  first sampled `(x, y)`; court-location scoring uses original coordinates.
  Neither profile rotates, reflects, normalizes attack direction, rescales space,
  or warps time. Opposite-basket paths can therefore score differently.

For transformed query samples `q[i]` and candidate samples `c[i]`, the score is
`sqrt(sum((qx[i]-cx[i])² + (qy[i]-cy[i])²) / 21)`, in feet. It compares positions
at corresponding nominal time targets, with the disclosed source timing offsets.
It is not a percentage, probability, speed similarity or tactical quality score.
The displayed sampled path length is a separate descriptive sum of successive
sample distances.

Each content-addressed `path:<24 hex>` ID hashes the version, source fingerprint,
game/player identity, ordered frame IDs, timestamps and sampled coordinates using
sorted-key compact JSON. Metadata retains original window, player, period, game
clocks, raw frame count and duration. Unknown fields, non-finite values and
inconsistent geometry/time identities are rejected at the Python boundary.

## Candidate construction and retrieval

Candidate endpoints are observed frames nearest an **absolute 2 s source timestamp
grid**, within 20 ms, inside each original event window after allowing two seconds
of history. Eligible roster-player paths are extracted independently. Identical
sampled paths across overlapping windows are deduplicated by feature ID, retaining
the first deterministic source-window reference. These event windows are not
reconstructed possessions or validated action boundaries. Stopped-clock footage
can qualify; no live-play filter is inferred.

Curated queries end at the chosen annotation reference and stay inside that
curated clip. Batum and Harris default references have sufficient history.
Williams' reference has only about 1.32 s of history inside its clip, so its query
is unavailable. Selecting another roster player can also be unavailable. The
uncertain annotations are bookmarks; their kind, confidence and eventual outcome
never enter the score, and changing focus does not reassign their participant.

Exclude every same-game candidate interval overlapping the query footage,
including other players in that footage. Rank the remaining pool by RMS, breaking
ties by stable feature ID. Then greedily suppress results overlapping already
returned footage, across all players, to show distinct intervals. Thus the gallery
shows the nearest remaining distinct footage, rather than eight unsuppressed
individual paths. Candidate counts describe the pool after filters and query
overlap exclusion, before this result suppression.

Only the declared selected-player geometry enters ranking. Player identity is an
optional pool filter. Ball/opponent coordinates, annotations, play-by-play,
outcomes and observations after each declared endpoint are excluded from scoring.
Historical retrieval can return a later interval or game; this is descriptive
search, not a prospective prediction experiment.

Similar geometry does not establish the same play call, action, assignment or
player role. Retrieval quality against tactical ground truth has not been
established. Multi-player matching remains deferred until player-role
correspondence and retrieval quality can be evaluated.

## Local index and reproducibility

The initial source games are CHA at TOR (2016-01-01; **14,250 paths**) and DEN at
GSW (2016-01-02; **17,381 paths**), covering 957 original source windows. Extraction
attempted 208,702 roster-player/window-endpoint pairs. This includes bench players
absent from a window; rejection totals are **not missing-frame rates**. Each pair
is counted under its first failing rule, and duplicates across windows are expected.
Per-game counts and rejection reasons are inspectable in the app and local
`data/lake/actions/index.json`.

- Source fingerprint:
  `26eed7665e97b79d3e8aaa5738e49a771bb8556bb745e8f7e235f6d984052761`
- Feature definition hash:
  `53b7355b3361c105912dd15d2308b490743a12625e59a9d7c8d6e6749b626920`
- Index fingerprint:
  `ab2f211a48d8562a62962aab5097d891d41cd16833f1f344de3ea4b0e07fa859`

The offline builder writes a DuckDB index, Zstandard Parquet snapshot and JSON
checkpoint through temporary files. Cached reuse requires matching source catalog
bytes, implementation bytes, definition, Python/DuckDB versions and both output
checksums. API access checks source catalog, implementation and definition against
the index and requires an explicit rebuild if stale. API reads do not rebuild data.

One local macOS arm64 run recorded 15.202 s for feature normalization, before final
index/Parquet creation, and a process peak RSS of 1,096,220,672 bytes. The resulting
DuckDB file is 20,983,808 bytes and Parquet is 15,173,305 bytes. Twelve local searches
measured 121–330 ms, median 144 ms. A Chromium run on an Apple M1 Pro recorded an
834 ms initial atlas load. These are individual measurements, not performance
guarantees or sustained playback benchmarks. The production bundle is about
328 kB JavaScript (99 kB gzip) and 38 kB CSS (8 kB gzip).

```sh
make actions                 # offline; requires make audit first
make api                     # read-only API, port 8007
make dev                     # port 5177
uv run python scripts/verify_actions.py
make web-build
npm --prefix apps/web run preview  # separate terminal, port 5178
npm --prefix apps/web run verify:actions  # API, dev and preview running
```

Read-only endpoints:

- `GET /actions/options`: definition, index/source provenance, per-game counts,
  curated query availability and rosters.
- `GET /actions/features/{candidate_id}`: one validated indexed feature.
- `GET /actions/search?seed_id=batum-corner&profile=start_relative&limit=8`:
  curated query search. Optional `annotation_id`, `player_id`, `same_player` and
  `other_game` select the reference/focus/pool. Alternatively supply `feature_id`
  instead of a seed to query from a match. Exactly one query mode is required.
  Profiles are `start_relative` or `court_location`; result limit is 1–30.

## Verification and boundaries

- **58 Python tests**, **35 web unit tests**, and **46 desktop/mobile browser
  checks** pass. Browser tests ran against production preview on port 5178.
  Type checking, Python lint and production build pass. Schema and generated
  fixture regeneration are stable.
- Generated trajectories establish exact translation behavior, joint-rotation
  invariance of the distance, lack of single-path rotation invariance, nearest
  sampling/ties, exclusions and availability. The rotated reference distance is
  independently calculated from the actual selected source samples. Tests alter
  unscored entities, future observations and outcomes without changing features.
- The independent real-source verifier reconciles **all 31,631 features**,
  **664,251 sampled positions** and **1,613,181 intervening observations** with
  canonical tracking and original source-window membership. An exhaustive Python
  ranking agrees with the index across 12 query/profile/filter cases; maximum RMS
  discrepancy is `8.89e-16` ft. Cached rebuild reuse also passes.
- Real browser calculations independently reproduce 32 API scores within the
  declared `1e-8` ft tolerance (maximum error `4.45e-16` ft), and verify 12 replay
  bindings. Checks cover profile switching, sample inspection, source stepping,
  query reuse, unavailable history, tab persistence and off-ball handoff. Desktop
  and 390 px screenshots were inspected; the mobile document has no overflow.

Evidence: [`m4-data-verification.json`](../artifacts/m4-data-verification.json),
[`m4-browser-verification.json`](../artifacts/m4-browser-verification.json),
[`verification.json`](../artifacts/verification.json),
[desktop screenshot](../artifacts/m4-action-atlas-desktop.png),
[mobile overlay](../artifacts/m4-path-overlay-mobile.png) and
[mobile replay](../artifacts/m4-path-replay-mobile.png).

Raw trajectories and generated indexes remain in ignored local `data/` files.
Committed test trajectories are explicitly generated fixtures. Data redistribution
permission and hosted behavior remain unverified. GitHub CI is configured but was
not run as part of this local milestone; no hosted release was attempted.
