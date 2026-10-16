import copy
import json
import math
from pathlib import Path

import duckdb
import pytest
from bkbdata.actions import Actions, PathFeature, build_actions, extract_path
from bkbdata.api import create_app
from bkbdata.catalog import Catalog
from fastapi.testclient import TestClient

FIXTURE = json.loads(Path("tests/fixtures/m4-paths.json").read_text())


@pytest.fixture
def action_paths(tmp_path):
    database = tmp_path / "sample.duckdb"
    # A minimal, typed source catalog with controlled source windows and no outcomes.
    datasets = dict(games=FIXTURE["games"], frames=[], segments=[], event_frames=[])
    for bundle in FIXTURE["bundles"]:
        for i, frame in enumerate(bundle["frames"]):
            datasets["frames"].append(dict(game_id=bundle["game_id"], **frame))
            datasets["event_frames"].append(
                dict(
                    game_id=bundle["game_id"],
                    segment_id=bundle["segment_id"],
                    frame_id=frame["frame_id"],
                    moment_index=i,
                )
            )
        datasets["segments"].append(
            dict(
                game_id=bundle["game_id"],
                segment_id=bundle["segment_id"],
                source_index=0,
                source_event_id="5",
                frame_count=100,
                continuity="continuous",
                discontinuities=0,
                entity_problem_frames=0,
                conflict_frames=0,
                malformed_moments=0,
                invalid_clock_frames=0,
            )
        )
    with duckdb.connect(str(database)) as con:
        for table, rows in datasets.items():
            path = tmp_path / f"{table}.json"
            path.write_text(json.dumps(rows))
            con.execute(f"CREATE TABLE {table} AS SELECT * FROM read_json(?)", [str(path)])
        con.execute(
            "CREATE TABLE events (game_id VARCHAR,event_id VARCHAR,"
            "period INTEGER,game_clock_s DOUBLE)"
        )
        con.execute("CREATE TABLE metadata (payload JSON)")
        con.execute(
            "INSERT INTO metadata VALUES (?)",
            [json.dumps(dict(source_fingerprint="generated-m3-motion", sources=[]))],
        )
    annotations = tmp_path / "annotations.json"
    collection = copy.deepcopy(FIXTURE["collection"])
    collection["pipeline_version"] = "m0-v1"
    annotations.write_text(json.dumps(collection))
    paths = dict(
        source_database=database, database=tmp_path / "actions.duckdb", lake=tmp_path / "lake"
    )
    return paths, annotations


def metric(a, b, profile):
    # Independent, direct paired Euclidean formula; no index scoring helper.
    ax = a["x_ft"]
    ay = a["y_ft"]
    bx = b["x_ft"]
    by = b["y_ft"]
    pairs = [
        (
            (x - (ax[0] if profile == "start_relative" else 0))
            - (u - (bx[0] if profile == "start_relative" else 0)),
            (y - (ay[0] if profile == "start_relative" else 0))
            - (v - (by[0] if profile == "start_relative" else 0)),
        )
        for x, y, u, v in zip(ax, ay, bx, by, strict=True)
    ]
    return math.sqrt(sum(dx * dx + dy * dy for dx, dy in pairs) / 21)


def test_feature_contract_known_translation_rotation_and_timing():
    a, b, c = FIXTURE["features"]
    assert metric(a, b, "start_relative") == pytest.approx(0, abs=1e-12)
    assert metric(a, b, "court_location") == pytest.approx(5, abs=1e-12)
    assert metric(a, c, "start_relative") == pytest.approx(FIXTURE["truth"]["rotated_shape_rms_ft"])
    for feature in [a, b, c]:
        validated = PathFeature.model_validate(feature)
        assert validated.actual_duration_ms == 2000 and validated.observed_frames == 51
        assert max(map(abs, validated.offsets_ms)) == 20
    # Rotating both paths preserves Euclidean RMS; rotating only one does not.
    ra, rc = copy.deepcopy(a), copy.deepcopy(c)
    for f in [ra, rc]:
        f["x_ft"], f["y_ft"] = [-y for y in f["y_ft"]], f["x_ft"]
    assert metric(ra, rc, "start_relative") == pytest.approx(metric(a, c, "start_relative"))


def test_only_declared_player_history_affects_features():
    b = copy.deepcopy(FIXTURE["bundles"][0])
    g = FIXTURE["games"][0]
    expected = extract_path(b["frames"], g, b["segment_id"], "1", 50, "generated-m3-motion")
    for i, f in enumerate(b["frames"]):
        for e in f["entities"]:
            if i > 50 or e["entity_id"] != "1":
                e["x_ft"] = 12345
        f["shot_outcome"] = "made" if i % 2 else "missed"
    b["events"] = [{"label": "future release", "made": True}]
    actual = extract_path(b["frames"], g, b["segment_id"], "1", 50, "generated-m3-motion")
    assert actual == expected
    assert max(actual.timestamps_ms) <= b["frames"][50]["source_timestamp_ms"]


@pytest.mark.parametrize(
    "fault",
    [
        "missing_unsampled",
        "duplicate",
        "wrong_team",
        "conflict",
        "gap",
        "clock_reverse",
        "period_change",
        "outside",
        "insufficient",
        "nonfinite",
    ],
)
def test_quality_exclusions_include_unsampled_observations(fault):
    b = copy.deepcopy(FIXTURE["bundles"][0])
    g = FIXTURE["games"][0]
    f = b["frames"][11]  # A frame between sampled 100 ms targets.
    if fault == "missing_unsampled":
        f["entities"] = [e for e in f["entities"] if e["entity_id"] != "1"]
    if fault == "duplicate":
        f["entities"].append(copy.deepcopy(f["entities"][0]))
    if fault == "wrong_team":
        f["entities"][0]["team_id"] = "wrong"
    if fault == "conflict":
        f["timestamp_conflict"] = True
    if fault == "gap":
        f["source_timestamp_ms"] += 10
    if fault == "clock_reverse":
        f["game_clock_s"] += 5
    if fault == "period_change":
        f["period"] = 2
    if fault == "outside":
        f["entities"][0]["x_ft"] = 95
    if fault == "nonfinite":
        f["entities"][0]["x_ft"] = float("nan")
    with pytest.raises(ValueError):
        extract_path(
            b["frames"],
            g,
            b["segment_id"],
            "1",
            50,
            "generated-m3-motion",
            low=10 if fault == "insufficient" else 0,
        )


def test_grid_samples_are_actual_observations_tie_earlier_and_no_future():
    b = copy.deepcopy(FIXTURE["bundles"][0])
    g = FIXTURE["games"][0]
    result = extract_path(b["frames"], g, b["segment_id"], "1", 50, "generated-m3-motion")
    assert result.frame_ids[1] == "generated-a-2"  # Target 100 ms ties 80/120, chooses 80.
    # Source grid targets actually use end-relative times: 100 ms offset is -20 ms.
    # This fixture's sample timestamps at 100 ms targets alternate exact and -20 ms.
    assert result.offsets_ms[1] == -20
    assert result.end_ms == b["frames"][50]["source_timestamp_ms"]


def test_feature_content_address_and_schema_reject_mutation():
    feature = copy.deepcopy(FIXTURE["features"][0])
    feature["x_ft"][5] += 0.1
    with pytest.raises(ValueError, match="Feature ID"):
        PathFeature.model_validate(feature)
    feature = copy.deepcopy(FIXTURE["features"][0])
    feature["offsets_ms"][3] = 21
    with pytest.raises(ValueError, match="offsets"):
        PathFeature.model_validate(feature)
    feature = copy.deepcopy(FIXTURE["features"][0])
    feature["made"] = True
    with pytest.raises(ValueError):
        PathFeature.model_validate(feature)


def test_index_resume_ranking_filters_and_overlap_exclusion(action_paths):
    paths, annotations = action_paths
    report = build_actions(**paths)
    assert report["candidate_count"] == 30
    assert build_actions(**paths)["cached"] is True
    actions = Actions(paths["database"], Catalog(paths["source_database"]), annotations)
    for profile in ["start_relative", "court_location"]:
        result = actions.search(seed_id="generated-a", profile=profile, limit=8)
        assert result["status"] == "available" and result["eligible_paths"] == 20
        assert result["overlapping_query_paths_excluded"] == 10
        assert len(result["matches"]) == 2
        assert [m["rms_ft"] for m in result["matches"]] == sorted(
            m["rms_ft"] for m in result["matches"]
        )
        for m in result["matches"]:
            assert m["rms_ft"] == pytest.approx(metric(result["query"], m, profile), abs=1e-10)
        assert all(m["game_id"] != "0000000001" for m in result["matches"])
    shape = actions.search(seed_id="generated-a", same_player=True)
    assert shape["matches"][0]["rms_ft"] == pytest.approx(0, abs=1e-12)
    assert len(shape["matches"]) == 1
    rotated = actions.search(feature_id=FIXTURE["features"][2]["candidate_id"])
    assert all(
        m["rms_ft"] == pytest.approx(FIXTURE["truth"]["rotated_shape_rms_ft"])
        for m in rotated["matches"]
    )
    empty = actions.search(feature_id=FIXTURE["features"][2]["candidate_id"], same_player=True)
    assert empty["eligible_paths"] == 0 and empty["matches"] == []
    repeat = actions.search(feature_id=shape["matches"][0]["candidate_id"], same_player=True)
    assert repeat["query"]["game_id"] == "0000000002"
    assert actions.feature(shape["matches"][0]["candidate_id"]).player_id == "1"
    assert actions.options()["candidate_count"] == 30
    # Output checksums prevent reusing a damaged exported partition.
    (paths["lake"] / "paths.parquet").write_bytes(b"corrupt")
    assert build_actions(**paths)["cached"] is False


def test_api_query_boundaries_and_unavailable_query(action_paths):
    paths, annotations = action_paths
    build_actions(**paths)
    client = TestClient(
        create_app(
            paths["source_database"],
            annotations_path=annotations,
            actions_database=paths["database"],
        )
    )
    assert client.get("/actions/options").status_code == 200
    assert client.get("/actions/search").status_code == 422
    assert (
        client.get(
            "/actions/search", params=dict(seed_id="generated-a", feature_id="both")
        ).status_code
        == 422
    )
    assert (
        client.get(
            "/actions/search", params=dict(seed_id="generated-a", profile="rotate")
        ).status_code
        == 422
    )
    assert (
        client.get("/actions/search", params=dict(seed_id="generated-a", limit=31)).status_code
        == 422
    )
    absent = client.get(
        "/actions/search", params=dict(seed_id="generated-a", player_id="999")
    ).json()
    assert absent["status"] == "unavailable" and absent["matches"] == []
    assert client.get("/actions/features/not-found").status_code == 404
    assert client.get("/actions/search", params=dict(seed_id="' OR 1=1 --")).status_code == 404
    assert (
        TestClient(
            create_app(
                paths["source_database"],
                actions_database=paths["database"].with_name("missing.duckdb"),
            )
        )
        .get("/actions/options")
        .status_code
        == 503
    )
    # Any source-catalog mutation invalidates a cached index before use.
    with duckdb.connect(str(paths["source_database"])) as con:
        con.execute(
            'UPDATE metadata SET payload=json(\'{"source_fingerprint":"changed","sources":[]}\')'
        )
    stale = client.get("/actions/options")
    assert stale.status_code == 422 and "stale" in stale.json()["detail"]
