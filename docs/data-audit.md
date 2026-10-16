# Milestone 0 source audit

Audited locally on 2026-10-15 (America/Los_Angeles). This is a two-game development
sample from 2015–16, not a league-wide coverage assessment.

The aggregate machine-readable evidence is in
[`artifacts/audit-summary.json`](../artifacts/audit-summary.json). The full local
report, including detailed diagnostics, is generated at
`data/exports/data-audit.json`. Original downloads, normalized datasets, and
replay exports are ignored by Git.

## Source selection

The [NBA Player Movements archive](https://github.com/linouk23/NBA-Player-Movements)
provided two independently parsed raw SportVU games:

- Charlotte at Toronto, 2016-01-01, game `0021500492`: four regulation periods.
- Denver at Golden State, 2016-01-02, game `0021500504`: four regulation periods
  and one overtime period.

These were selected after checking the archive inventory. The sample exercises
regulation, overtime, overlapping windows, missing observations, and conflicting
timestamps. It is a convenience sample, not a random or representative sample of
teams, seasons, or tracking systems.

Tracking is pinned to revision `f7d4cf2c7e607029abfd5715a0d4073bedae328e`.
Shots and play-by-play come from the `shotdetail_2015.tar.xz` and
`nbastats_2015.tar.xz` files in
[nba_data](https://github.com/shufinskiy/nba_data), pinned to
`e829d4678be1e075f99e5d41a1c5f97089be446b`. The filename's year is the season's
starting year; the selected rows are from January 2016. Each is a compressed
season CSV, streamed to retain only these games. The config pins expected SHA-256
checksums in addition to repository revisions.

No NBA live endpoint is required for this sample. The Hugging Face loader,
hoopR adapter, pbpstats integration, and alternative tracking archive have not
been validated or incorporated. The current pipeline does not depend on them.

## Measured inventory

Charlotte–Toronto:

- 176 shots: 70 makes and 106 misses; 448 play-by-play events.
- 452 source event windows, including 37 empty windows.
- 211,445 source moment memberships; 79,963 unique observations after removing
  131,482 exact repeats across/within windows.
- 236 continuous windows and 216 partial/empty windows under the documented
  structural continuity rules.
- Unique frames by period: 19,411; 20,233; 20,282; 20,037.
- 260 unique frames without exactly one ball; 5,912 without shot-clock values.
- 7,303 unique frames with at least one entity outside court lines, including
  1,885 more than two feet beyond a line. Boundary crossings can be ordinary play;
  these are inspection findings rather than automatic corrupt-data labels.
- No timestamp conflicts or player-roster mismatches were detected.

Denver–Golden State:

- 191 shots: 87 makes and 104 misses; 503 play-by-play events.
- 505 source event windows, including seven empty windows.
- 241,861 source moment memberships; 94,857 distinct observations after removing
  147,004 exact repeats. These observations occupy 94,852 distinct period/time
  keys; five keys have two conflicting variants, all retained.
- 301 continuous windows and 204 partial/empty windows.
- Unique frames by period: 21,338; 22,497; 21,060; 20,490; 9,472 in overtime.
- 577 unique frames without exactly one ball; seven with missing players; 8,397
  without shot-clock values.
- 9,791 unique frames outside court lines, including 2,548 beyond the two-foot
  margin. No roster mismatches were detected.

Combined: 367 shots, 951 play-by-play events, 957 source windows, 453,306 moment
memberships, and 174,820 distinct observations. Counts of missing fields and
coordinate findings refer to deduplicated observations; cadence-step counts
refer to within-window sequences and can include overlapping time intervals.

## Timing and independent checks

Both tracking games carry millisecond timestamps in addition to period, game clock, and
shot clock. Within-window interval histograms are dominated by 39, 40, and 41 ms,
consistent with nominal 25 Hz and timestamp jitter. Charlotte–Toronto includes
22,341 adjacent positive-time steps where game clock is unchanged; Denver–Golden
State includes 38,591. Therefore game-clock differences are unsuitable as the
sole playback time base.

Denver windows also include repeated timestamps and multi-second gaps. Five
period/time keys disagree on their recorded observations. These are retained and
flagged, never averaged into a supposedly measured frame. Frame continuity uses
40 ± 5 ms and explicit clock/identity checks, as specified in
[`data-contracts.md`](data-contracts.md).

The shot coordinate unit conversion was independently checked against recorded
shot distance: all 367 attempts have Euclidean basket-relative distance within
two feet of the reported distance. Median absolute differences are 0.6015 ft for
Charlotte–Toronto and 0.5005 ft for Denver–Golden State. This supports the
tenths-of-feet convention; it does not establish sub-foot location accuracy.

Four explicit court-mapping hypotheses were compared with the recorded shooter
positions within one game-clock second of each matched event. Across all 18
team/period groups, the best median residual used the same lateral sign (`-1`),
opposing baskets for the two teams, and a halftime basket change. Median minimum
residuals for those candidates range from 2.6097 to 10.9969 ft. The comparison
supports court scale and orientation conventions, but the residuals are too large
to claim exact release alignment. One overtime group has only one eligible shot.
No inferred direction is applied to the stored tracking or exported replay.

## Join results and examples

Every shot matched one play-by-play event using event ID plus player, team,
period, result, and clock checks: 367 matched, zero ambiguous, zero unmatched.

Shot-to-tracking results use the same event ID, a verified play-by-play join, and
same-period shooter observations within one game-clock second:

- Charlotte–Toronto: 163 matched, zero ambiguous, 13 unmatched, zero unavailable.
  Eight failed joins violate the event-clock range check; five have no eligible
  period/shooter observations (including empty source windows).
- Denver–Golden State: 71 matched, zero ambiguous, 120 unmatched, zero unavailable.
  All 120 failed joins violate the event-clock range check.

A matched tracking join identifies a source window and can still have partial tracking.
It does not verify the shot's release instant.

Examples retained in the report and available for CLI export:

- Charlotte–Toronto event 5: Cody Zeller made dunk, Q1 11:25; continuous window
  `sportvu:0021500492:5:4`, 550 frames.
- Charlotte–Toronto event 16: Nicolas Batum missed shot, Q1 10:20; continuous
  window `sportvu:0021500492:16:11`, 600 frames.
- Charlotte–Toronto event 47: Marvin Williams made shot, Q1 7:09; partial window
  `sportvu:0021500492:47:39`.
- Charlotte–Toronto event 9: Nicolas Batum, Q1 10:59; the nearest eligible clock
  in its same-ID window differs by 2.72 s, so its tracking join is unmatched.
- Denver–Golden State event 68: Danilo Gallinari made shot, Q1 4:13; continuous
  window `sportvu:0021500504:68:65`, 642 frames.
- Denver–Golden State event 3: Danilo Gallinari, Q1 11:30; the same-ID window's
  nearest eligible clock differs by 3.32 s, so its tracking join is unmatched.

The much lower Denver match rate is an unresolved event-window/timing issue.
We have not established a correction or assumed a constant offset. Widening the
tolerance would inflate apparent availability without verifying the action.

## Reproducibility and local footprint

```sh
make setup
make fetch
make audit
uv run python scripts/summarize_audit.py
make contract
```

A second fetch verifies local checksums without network access. Repeating audit
with unchanged code, source files, and software returns `cached: true`, verifies
Parquet checksums and catalog metadata, and leaves the catalog unchanged.
Generated-fixture tests also exercise changed raw bytes and corrupt outputs.

An uncached local rerun during Milestone 1 took 32.346 seconds and peaked at
2,015,805,440 bytes RSS (about 1.88 GiB) on this macOS ARM64 environment, using Python 3.13.14 and DuckDB
1.5.6. Derived Parquet occupies about 19 MB and the catalog about 43 MB. This is a
single observation, not a performance guarantee. The current adapter parses one
game JSON at a time; its memory footprint needs attention before bulk ingestion.

## Milestone 0 outcome and remaining boundaries

The sample parses end to end, produces inspectable normalized data, reports join
and continuity failures, and exports schema-validated real tracking windows.
Python/React scaffolds, development commands, CI configuration, and a local shot
and coverage inspection screen are present.

No complete possessions, exact release timestamps, attacking-direction labels,
screens, catches, assignments, or player velocities have been established.
Milestone 1 now replays these source windows with explicit availability states
and approximate event-clock bands; see [`milestone-1.md`](milestone-1.md). The
source-window mismatch still requires investigation before broadening replay
coverage or making release/shot-to-frame claims.

Only local tests and browser behavior have been verified. The CI workflow is
configured but has not run on GitHub. Public redistribution and hosted release
validation remain separate future gates.
