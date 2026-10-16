# Milestone 3 — Off-ball movement explorer

Implemented locally on 2026-10-15. Open `http://127.0.0.1:5177/#movement`, choose
**Off-ball explorer**, or follow the annotated-movement link below a tracking replay.

## Delivered workflow

Choose two curated sequences and an annotation reference for each. Replay the
same elapsed seconds before and after those references on two source courts.
Focus any roster player using the dropdown or court markers; other players and
trails dim. Changing the focused player never reassigns the reference annotation
to that player. The original annotation participant remains visible.

Three linked charts compare nearest-opponent separation, planar ball separation,
and movement heading. Court positions, chart cursors and sample readouts share
one relative-time cursor. Step through observed sample times, seek with the shared
slider or charts, jump to the reference, and play at 0.25×–2× wall-clock rate.
Keyboard controls: Space plays/pauses, arrows step observed relative times, and
Home/End seek the displayed interval. Playback pauses when either sequence
encounters a source tracking break and when the page becomes hidden.

Each pane shows its observed game clock, elapsed source-window time, sample offset,
reference offset from the curated clip start, timing uncertainty interval, confidence,
reviewer, source frame IDs, and collection revision. The two panes preserve their
recorded durations; no time warping, duration normalization, interpolation, spatial
rotation or mirroring is applied. The original tracking lab also adds a focused-player
dimming toggle. Court paint-pattern IDs are unique when multiple replays appear.

## Initial curation and its limits

`annotations/curated-v1.json` contains **three sequences and five annotations**:

- Nicolas Batum, CHA at TOR, 2016-01-01, source window event 16: a provisional
  ball-arrival/catch review and a corner relocation review. The default reference
  is frame index 90, source-window elapsed 3.601 s; the reviewer-selected interval
  spans indices 86–94. The curated clip spans indices 35–142.
- Gary Harris, DEN at GSW, 2016-01-02, source window event 8: a provisional
  ball-arrival/catch review and a sideline-to-middle cut description. The default
  reference is index 400, elapsed 16.000 s; interval 396–404, clip 345–444.
- Marvin Williams, CHA at TOR, 2016-01-01, source window event 47: an uncertain
  observation reference at index 333, where the ball is absent. Clip 300–375 and
  reference interval 330–336 support inspection of missing-data behavior.

These are **manual, agent-assisted coordinate reviews**, not independent human
adjudication, video annotations, NBA-provided catches, or validated ball-control
labels. All five annotations are uncertain. Proximity can also reflect a dribble,
rebound, ball flight or an unrelated nearby player. The displayed timing intervals
are reviewer choices, not statistical confidence intervals. Neither a screen nor
a shot release is asserted by the current collection. The format supports them
for future evidence-backed curation.

Only the two previously audited historical games supply tracking. Milestone 2's
four-season shot coverage does not imply additional movement or catch coverage.
Underlying data redistribution rights remain unestablished; raw trajectories stay
in ignored `data/` files. The committed curation contains references and review
notes, not copied trajectory arrays.

## Versioned annotation contract

Python models are in `packages/bkbdata/src/bkbdata/annotations.py`; the generated
schema is `schemas/annotations-v1.schema.json` (`basketball-annotations-v1`).

- A collection records ID, revision, historical/synthetic status, source fingerprint,
  pipeline version and description. Increment its revision for curation changes.
- A sequence records game/window/player IDs, clip start/end frame IDs, default
  anchor, development/held-out split, annotation completeness, and its annotations.
- Each annotation records ID, kind (`catch`, `release`, `screen`, `cut`, `relocation`,
  `uncertain`), label, confidence (`uncertain`, `supported`, `validated`), evidence
  basis, start/reference/end frame IDs, reviewer, review date, notes, and evidence URI.
- A validated label requires an evidence reference. Tracking review alone cannot
  validate catches, releases or screens. Historical collections reject synthetic
  evidence. Generated-fixture labels remain explicitly synthetic.
- Binding checks exact source fingerprint and pipeline version, game/window IDs,
  roster identity/team, unique observed reference player, frame existence, ordered
  intervals and clip containment. Conflicted reference frames are unavailable.
  The browser independently checks source/frame identity before rendering.
- Development and held-out clips cannot share source windows or observed frames,
  including across overlapping SportVU event windows. Sequence IDs and annotation
  IDs must be unique within their respective scopes.

`GET /annotations` returns the read-only, validated collection with resolved frame
indices/times and per-sequence availability reasons. No detector labels are added.
To validate local curation against the installed tracking catalog:

```sh
uv run basketball annotations
uv run basketball annotations --path annotations/curated-v1.json
make contract
```

A new JSON collection must follow the schema and source binding rules. Change the
configured annotation path through `create_app(..., annotations_path=...)` when
embedding the service. No annotation mutation or upload service is exposed.

## Measurement and alignment definitions

- Reference zero is the chosen annotation's exact **source timestamp**. Each
  sequence retains its separate source-window elapsed clock and reference offset.
  Signed chart time is `(sample timestamp − reference timestamp) / 1000`.
- Playback advances a shared elapsed-time clock. Each court selects the last actual
  sample at or before that clock only while its age is **less than 45 ms**. Outside
  curated coverage or in a source gap, positions are unavailable. A missing entity
  disappears; a conflicting timestamp hides all its positions. Sample offset in
  milliseconds makes any hold between observations inspectable.
- Frame stepping uses the sorted union of actual relative sample timestamps;
  the slider controls comparison time, not an invented frame. Requested pre/post
  ranges can exceed available clip coverage; unavailable intervals remain visible.
  A break barrier pauses transport at the start of unavailable sample timing.
- Trails use at most 1.2 s of observed history, stop at source/identity gaps, and do
  not extend before the displayed curated portion. Focus dims other trails and
  markers without inferring who holds the ball or who defends the selected player.
- Nearest-opponent distance uses the closest of **five valid tracked opponents**;
  incomplete opponent coverage or a missing focused player makes it unavailable.
- Ball separation is planar Euclidean distance in feet. Height is not included,
  and proximity does not establish possession.
- Heading is `atan2(vy, vx)` in degrees using a backward linear fit to five consecutive
  observations within the curated clip. It uses source timestamps, not game clock
  differences, and is unavailable across discontinuities, missing/conflicting
  player histories, or fitted speed below **1 ft/s**. Source +x is 0°, +y is +90°.
  This is movement direction, not body facing or attacking direction.
- Heading colors use a fixed −180° to +180° scale. Chart paths break at wraps rather
  than drawing through the angular discontinuity. Distance scales are shared by
  A and B within each chart. Shaded bands indicate each annotation's timing interval.

## Offline candidate evaluation

`packages/bkbdata/src/bkbdata/catch_evaluation.py` freezes a versioned **ball-approach
proposal**, not a validated catch detector. A candidate requires six preceding
observations, a prior planar distance of at least 5 ft, followed by three observations
within 3 ft with recorded ball height between 0 and 8 ft. Missing ball/player history,
conflicts and timing breaks exclude it. Three-sample confirmation has about 0.08 s
latency; the proposed event time refers to the first near observation.

The evaluator reserves a source-disjoint held-out split. Scoring requires
**exhaustive catch annotations and validated evidence**; partial or uncertain
annotations cannot establish false positives, false negatives or recall. Matching
is one-to-one within the annotation interval plus a fixed ±0.20 s tolerance.
Reports include failure examples when scoring is eligible.

The historical Harris clip produces **one proximity proposal**, but **zero eligible
held-out sequences**: its review is provisional and partial. Precision, recall,
TP/FP/FN are therefore **unavailable**, not zero. `artifacts/m3-candidate-evaluation.json`
records this result and code/annotation hashes. **No automatic labels ship.**
Generated controlled cases test successful matching, false positives, missed events,
missing observations, leakage rejection and the evaluation gate; their scores are
only tests of the harness, not NBA detector performance.

```sh
uv run python scripts/evaluate_catches.py
```

## Verification and reproduction

Final gates passed: **42 Python tests, 30 web unit tests and 34 desktop/mobile
browser checks** against the production preview, plus lint, typecheck and build.
Real-source parity matched all 54 sample selections, 142 finite numerical values,
and 162 availability checks at a 1e-8 tolerance. Maximum heading error was about
6.94e-12 degrees. Schemas and both generated motion fixtures regenerate identically.


```sh
make lint test web-build
make fixtures contract
npm --prefix apps/web run test:browser
uv run python scripts/movement_reference.py
uv run python scripts/evaluate_catches.py
npm --prefix apps/web run preview          # separate terminal; API/dev also running
npm --prefix apps/web run verify:movement
```

The shared generated fixture has analytically known 3–4–5 ft/s motion and invented
annotations. Tests cover source binding, all event kinds, confidence gates,
unknown/ambiguous frames, temporal alignment without rescaling, exact sample
selection, heading availability, missing entities and transport pauses. Browser
workflows exercise keyboard controls, focused-player changes, provenance,
invalid sources, uncovered intervals, conflicts and narrow-screen layout.

The independent Python reference uses raw source timestamps, Euclidean distances,
and uncentered velocity normal equations; the browser uses its own centered fit.
It checks **54 actual time/player cases** across all three curated sequences, plus
availability and source-frame selection. Generated fixtures and annotation schemas
have reproducible generation commands in CI. See `artifacts/m3-verification.json`
for numerical counts, tolerances, source/code fingerprints and real browser checks.

Visually reviewed screenshots:
`artifacts/m3-movement-desktop.png`, `m3-movement-mobile.png`,
`m3-movement-mobile-panel.png`, and `m3-movement-mobile-charts.png`.
CI is configured but has not run on GitHub. Hosted validation is not claimed.
