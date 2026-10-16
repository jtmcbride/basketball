# Basketball data contracts

The Python boundary models live in `packages/bkbdata/src/bkbdata/contracts.py`.
Run `make contract` to regenerate the JSON schemas in `schemas/`. CI checks for
schema drift. The current versions are `basketball-audit-v1` and
`basketball-replay-v1`; unknown replay versions are rejected.

## Storage entities

- `games`: canonical NBA game ID, date, home/away IDs, source roster, measured
  coverage, joins, findings, and selected audit examples.
- `shots`: source and canonical IDs, player/team, period/clock, result, attempt
  value, action type, original coordinates, basket-relative feet, and explicit
  shot-to-event and shot-to-tracking join records.
- `events`: namespaced play-by-play ID, original event/game IDs, event type,
  player/team, period/clock, description, and score.
- `segments`: namespaced source-window ID, original event ID and index, frame
  count, period membership, continuity, and issue counts. These are source event
  windows; possession reconstruction is unavailable.
- `frames`: game, unique observation ID, period, millisecond source timestamp,
  game/shot clocks, conflict flag, quality flags, and a typed list of observed
  entities with feet coordinates.
- `event_frames`: original window membership, original moment index, and unique
  frame ID. A frame can belong to several overlapping windows. Repeated source
  memberships remain inspectable even when the observation itself is stored once.

The corresponding Parquet files contain the same normalized relations as the
DuckDB catalog. The catalog also stores the audit metadata. It is read-only when
served; only the explicit ingestion command replaces it.

## Identity

NBA game IDs are strings of ten digits. These bulk CSVs have removed leading
zeros, so the adapter restores them with an explicit zero-padding rule and keeps
`source_game_id` separately. Player, team, and event IDs remain strings. Providers
are namespaced (`shotchart`, `nbastats`, `sportvu`). The source index disambiguates
repeated tracking window IDs; duplicate event IDs are never silently collapsed.

## Coordinates

SportVU source court coordinates are retained in feet on a 94 × 50 court. The
candidate rim centers are `(5.25, 25)` and `(88.75, 25)`. No attack-direction
normalization is applied in this milestone.

Shot-chart `LOC_X` and `LOC_Y` are retained. The derived fields are
`lateral_ft = LOC_X / 10` and `forward_ft = LOC_Y / 10`, relative to the basket.
The inspection chart draws the rim at `(25, 5.25)` and the shot at
`(25 + lateral_ft, 5.25 + forward_ft)`. This is a basket-relative display, not a
mapping onto an established attacking basket in SportVU coordinates. Attempts
outside that half-court view remain in the attempt selector and are counted in
the caption.

The independent convention diagnostic compares four explicit mappings against
recorded shooter positions near each event clock. A left-basket hypothesis is
`(5.25 + forward_ft, 25 + sign × lateral_ft)` for sign `-1` or `+1`; a right-basket
hypothesis is its 180° rotation `(94 - x, 50 - y)`. It reports residuals by team
and period without converting the best candidate into verified direction data.

Ball height is the source's recorded feet value. Player height is unavailable;
the source's zero placeholder is normalized to null. No flight arc, body facing,
possession holder, catch, or shot release is inferred in the data adapter. The
Milestone 1 browser derives player speed using the documented five-observation
policy in [`milestone-1.md`](milestone-1.md).

## Time and continuity

`source_timestamp_ms` is the source's millisecond timestamp. Exported elapsed
time is exactly `(timestamp - first_observed_timestamp) / 1000`. It continues
when the game clock stops. Game and shot clocks are retained independently.

The nominal interval is 40 ms (25 Hz). A step is discontinuous when it changes
period, differs from 40 ms by more than 5 ms, or increases the game clock by more
than 0.1 seconds. This is a conservative inspection rule, not a proof that every
flag represents a dropped sample. The audit records the actual interval histogram.

A window is `continuous` only with at least two observations, no detected timing
discontinuity, no malformed moments, no timestamp conflicts, a valid game-clock
range, and intact unique player/team/ball identities (five players on each team).
Otherwise it is `partial`. Missing shot clock and out-of-bounds positions are
separate findings; an ordinary boundary crossing is not automatically corruption.
Continuity never establishes that the source recorded a complete possession.

Exact repeated observations, independent of entity-list order, share one frame
record. Different observations at the same period/timestamp receive distinct IDs
and conflict flags. Export orders observations by timestamp, retains their
original moment indices, and marks breaks. It does not interpolate gaps, select
a winning conflict variant, or repair clocks.

## Join rules

Shot-to-event matching requires a unique source event ID plus agreement on
player, team, period, make/miss event type, and event clock within one second.
Duplicate source keys or multiple event candidates are `ambiguous`; absent or
inconsistent events are `unmatched`.

Shot-to-tracking matching requires that verified event join, a unique same-ID
source window, and an observation of the shooter in the same period within one
game-clock second. It identifies an event window, not a release frame. The join
also reports `window_continuity`; a matched window can be partial.

Unverified event joins make tracking `unavailable`. Multiple windows with the
same source ID are `ambiguous`. Missing windows, missing shooter observations,
or clock disagreement are `unmatched`. The importer does not broaden tolerance
or substitute a nearby unrelated window to improve coverage.

## Replay boundary

A replay bundle contains schema version, game/window IDs, segment kind,
continuity, ordering policy, quality findings, roster, observed frames, recorded
play-by-play context, and
provenance. Pydantic validates IDs/field types, finite numbers, supported version,
nonempty frames, unique frame IDs, timestamp order, elapsed-time consistency,
and original source indices. The optional `events` list defaults to empty for
older v1 bundles. Context events are selected by period and observed clock range
(with a one-second margin); their clocks are not release annotations. Missing
players and ball observations are allowed
because partial data must remain inspectable.

Provenance includes all contributing sample manifests, checksums, source URLs,
pipeline version, source fingerprint, time/coordinate conventions, and explicit
unavailable direction/release states. The audit records software versions and a
pipeline fingerprint from implementation contents and software versions. Cached
ingest verifies source bytes, output Parquet checksums, and catalog metadata.

## API

The default local API is `http://127.0.0.1:8007`.

- `GET /health`: process status and catalog availability.
- `GET /data-health`: measured audit, provenance, diagnostics, and boundaries.
- `GET /games` and `GET /games/{game_id}`: audited game summaries.
- `GET /games/{game_id}/shots?limit=200&offset=0`: paginated attempts.
- `GET /games/{game_id}/segments?limit=100&offset=0`: paginated source windows.
- `GET /games/{game_id}/segments/{segment_id}`: validated replay bundle.

Pagination limits are 1–500. Missing catalogs return 503 with setup guidance;
unknown games/windows return 404. Frame data is fetched only for a selected
window. The web app animates observed frames and links player measurements and
chart seeking to one frame selection. See [`milestone-1.md`](milestone-1.md) for
measurement and availability rules.

## Curated movement annotations (Milestone 3)

`basketball-annotations-v1` is independent of the replay v1 contract. Its models
live in `packages/bkbdata/src/bkbdata/annotations.py`, with generated schema
`schemas/annotations-v1.schema.json`. Collections bind their revision and source
fingerprint to exact window/player/frame references and bounded annotation
intervals. Tracking-only reviews remain provisional; validated labels require
evidence. Historical collections reject synthetic evidence, and held-out clips
cannot share source observations with development clips. `GET /annotations`
resolves frame indices and reports per-sequence availability without adding
automatic labels. See [Milestone 3](milestone-3.md) for measurement, timing,
curation and evaluation definitions.
