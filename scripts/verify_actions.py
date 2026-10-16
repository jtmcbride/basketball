"""Independent raw-source reconciliation and exhaustive geometric ranking oracle."""

import json
import math
import statistics
import time
from pathlib import Path

import duckdb
from bkbdata.actions import Actions, build_actions
from bkbdata.catalog import Catalog

source_path = Path("data/db/basketball.duckdb")
index_path = Path("data/db/actions.duckdb")
source = Catalog(source_path)
actions = Actions(index_path, source, Path("annotations/curated-v1.json"))
with duckdb.connect(str(index_path), read_only=True) as con:
    cursor = con.execute("SELECT * EXCLUDE(dx,dy) FROM paths")
    names = [c[0] for c in cursor.description]
    paths = [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]
verified_samples = 0
verified_history = 0
for game in source.games():
    with duckdb.connect(str(source_path), read_only=True) as con:
        rows = con.execute(
            "SELECT frame_id,source_timestamp_ms,period,game_clock_s,"
            "timestamp_conflict,quality_flags,entities FROM frames WHERE game_id=?",
            [game["game_id"]],
        ).fetchall()
        frames = {
            row[0]: dict(
                frame_id=row[0],
                time=row[1],
                period=row[2],
                clock=row[3],
                conflict=row[4],
                flags=row[5],
                entities=row[6],
            )
            for row in rows
        }
        membership = {
            sid: ids
            for sid, ids in con.execute(
                "SELECT segment_id,list(DISTINCT frame_id) FROM event_frames "
                "WHERE game_id=? GROUP BY segment_id",
                [game["game_id"]],
            ).fetchall()
        }
    roster = {p["player_id"]: p["team_id"] for p in game["players"]}
    windows = {
        sid: sorted(
            (frames[fid] for fid in ids), key=lambda f: (f["time"], f["period"], f["frame_id"])
        )
        for sid, ids in membership.items()
    }
    locations = {
        sid: {f["frame_id"]: i for i, f in enumerate(window)} for sid, window in windows.items()
    }
    for feature in (f for f in paths if f["game_id"] == game["game_id"]):
        window = windows[feature["segment_id"]]
        lookup = locations[feature["segment_id"]]
        start, end = lookup[feature["frame_ids"][0]], lookup[feature["frame_ids"][-1]]
        history = window[start : end + 1]
        assert len(history) == feature["observed_frames"]
        assert abs(feature["end_ms"] - round(feature["end_ms"] / 2000) * 2000) <= 20
        for i, frame in enumerate(history):
            assert not frame["conflict"] and "game_clock_out_of_range" not in frame["flags"]
            selected = [e for e in frame["entities"] if e["entity_id"] == feature["player_id"]]
            assert len(selected) == 1 and selected[0]["team_id"] == roster[feature["player_id"]]
            assert 0 <= selected[0]["x_ft"] <= 94 and 0 <= selected[0]["y_ft"] <= 50
            if i:
                before = history[i - 1]
                assert 35 <= frame["time"] - before["time"] <= 45
                assert (
                    frame["period"] == before["period"] and frame["clock"] <= before["clock"] + 0.1
                )
            verified_history += 1
        # Include the preceding observation to independently test the first-target tie rule.
        nearby = window[max(0, start - 1) : end + 1]
        for i, identity in enumerate(feature["frame_ids"]):
            target = feature["end_ms"] - 2000 + i * 100
            selected = min(nearby, key=lambda f: (abs(f["time"] - target), f["time"]))
            assert selected["frame_id"] == identity
            assert abs(selected["time"] - target) <= 20
            player = next(e for e in selected["entities"] if e["entity_id"] == feature["player_id"])
            assert (player["x_ft"], player["y_ft"]) == (feature["x_ft"][i], feature["y_ft"][i])
            assert selected["time"] == feature["timestamps_ms"][i]
            verified_samples += 1


def score(query, path, profile):
    qx, qy = query["x_ft"], query["y_ft"]
    px, py = path["x_ft"], path["y_ft"]
    translated = profile == "start_relative"
    return math.sqrt(
        sum(
            ((qx[i] - (qx[0] if translated else 0)) - (px[i] - (px[0] if translated else 0))) ** 2
            + ((qy[i] - (qy[0] if translated else 0)) - (py[i] - (py[0] if translated else 0))) ** 2
            for i in range(21)
        )
        / 21
    )


def overlaps(a, b):
    return (
        a["game_id"] == b["game_id"]
        and a["start_ms"] <= b["end_ms"]
        and a["end_ms"] >= b["start_ms"]
    )


checks = []
latencies = []
for seed in ["batum-corner", "harris-middle"]:
    for profile in ["start_relative", "court_location"]:
        for filters in [{}, dict(other_game=True), dict(same_player=True)]:
            started = time.perf_counter()
            result = actions.search(seed_id=seed, profile=profile, limit=8, **filters)
            latencies.append((time.perf_counter() - started) * 1000)
            query = result["query"]
            eligible = [
                p
                for p in paths
                if not overlaps(query, p)
                and (not filters.get("other_game") or p["game_id"] != query["game_id"])
                and (not filters.get("same_player") or p["player_id"] == query["player_id"])
            ]
            assert result["eligible_paths"] == len(eligible)
            ordered = sorted(
                ((score(query, p, profile), p["candidate_id"], p) for p in eligible),
                key=lambda r: (r[0], r[1]),
            )
            expected = []
            for distance, identity, path in ordered:
                if any(overlaps(path, p[2]) for p in expected):
                    continue
                expected.append((distance, identity, path))
                if len(expected) == 8:
                    break
            assert [m["candidate_id"] for m in result["matches"]] == [p[1] for p in expected], (
                seed,
                profile,
                filters,
            )
            deltas = [
                abs(m["rms_ft"] - p[0]) for m, p in zip(result["matches"], expected, strict=True)
            ]
            assert max(deltas, default=0) < 1e-8
            checks.append(
                dict(
                    seed=seed,
                    profile=profile,
                    filters=filters,
                    eligible=len(eligible),
                    matches=len(expected),
                    max_score_error_ft=max(deltas, default=0),
                    rank_ids_agree=True,
                )
            )
meta = json.loads(Path("data/lake/actions/index.json").read_text())
# Re-running an unchanged index checks all cached output bytes without source extraction.
cached = build_actions(source_path, index_path, Path("data/lake/actions"))
assert cached["cached"]
report = dict(
    feature_version=meta["feature_version"],
    source_fingerprint=meta["source_fingerprint"],
    index_fingerprint=meta["index_fingerprint"],
    definition_hash=meta["definition_hash"],
    indexed_paths=len(paths),
    raw_sample_pairs_verified=verified_samples,
    raw_history_observations_verified=verified_history,
    ranking_cases=checks,
    cached_rebuild_verified=True,
    query_latency_ms=dict(
        min=min(latencies), median=statistics.median(latencies), max=max(latencies)
    ),
    build_seconds=meta["build_seconds"],
    build_environment=meta.get("build_environment"),
    database_bytes=index_path.stat().st_size,
    parquet_bytes=Path("data/lake/actions/paths.parquet").stat().st_size,
    limitations=[
        "Two historical games only",
        "Descriptive geometry; no tactical retrieval ground truth or play-call labels",
        "Timings are one local run, not universal bounds",
    ],
)
Path("artifacts/m4-data-verification.json").write_text(json.dumps(report, indent=2) + "\n")
print(
    json.dumps(
        dict(
            indexed_paths=len(paths),
            raw_samples=verified_samples,
            history_observations=verified_history,
            ranking_cases=len(checks),
            passed=True,
        )
    )
)
