"""Atlas acceptance fixtures use known counts, mixed shot values and imperfect archives."""

import json
from pathlib import Path

import pytest
from bkbdata.acquire import sha256
from bkbdata.api import create_app
from bkbdata.atlas import Atlas, build_atlas, hex_cell
from conftest import csv_archive, event_row, shot_row
from fastapi.testclient import TestClient


@pytest.fixture
def atlas_paths(tmp_path):
    raw = tmp_path / "raw"
    raw.mkdir()
    shots, pbp = [], []
    for i in range(32):
        player = "1" if i < 10 or i >= 30 else "2"
        team = "100" if player == "1" else "200"
        value = 2 if player == "1" else 3
        made = i % 2 == 0
        shots.append(
            shot_row(
                GAME_EVENT_ID=str(i + 1),
                PLAYER_ID=player,
                TEAM_ID=team,
                PLAYER_NAME=f"Player {player}",
                TEAM_NAME=f"Team {team}",
                SHOT_TYPE=f"{value}PT Field Goal",
                SHOT_MADE_FLAG=str(int(made)),
                GAME_DATE="20000101",
                HTM="HOM",
                VTM="AWY",
                LOC_X="300" if i == 31 else "0",
                LOC_Y="0",
                SHOT_DISTANCE="60" if i == 31 else "0",
                PERIOD="2" if i >= 30 else "1",
            )
        )
        pbp.append(
            event_row(
                EVENTNUM=str(i + 1),
                PLAYER1_ID=player,
                PLAYER1_TEAM_ID=team,
                EVENTMSGTYPE="1" if made else "2",
                PERIOD="2" if i >= 30 else "1",
                HOMEDESCRIPTION="Home attempt" if team == "100" else "Home BLOCK",
                VISITORDESCRIPTION="" if team == "100" else "Away attempt",
            )
        )
    # Duplicate PBP IDs must not become verified joins; one unmatched PBP attempt is disclosed.
    pbp.append(dict(pbp[0]))
    pbp.append(event_row(EVENTNUM="99"))
    config = {"version": 1, "sources": [], "seasons": []}
    for year in ["1999-00", "2000-01"]:
        ids = []
        for kind, rows in [("shots", shots), ("pbp", pbp)]:
            filename = f"{kind}-{year}.tar.xz"
            csv_archive(raw / filename, rows)
            source = dict(
                id=f"{kind}-{year}",
                kind=kind,
                filename=filename,
                url="https://example.invalid/pinned",
                revision="fixture",
                sha256=sha256(raw / filename),
            )
            (raw / f"{filename}.manifest.json").write_text(json.dumps(source))
            config["sources"].append(source)
            ids.append(source["id"])
        config["seasons"].append(dict(season=year, shots=ids[0], pbp=ids[1]))
    path = tmp_path / "sources.json"
    path.write_text(json.dumps(config))
    paths = dict(config=path, raw=raw, database=tmp_path / "atlas.duckdb", lake=tmp_path / "lake")
    return paths


def test_season_coverage_resume_and_corruption_repair(atlas_paths):
    first = build_atlas(**atlas_paths)
    season = first["seasons"][0]
    assert season["attempts"] == 32
    assert season["event_matched"] == 31
    assert season["duplicate_pbp_keys"] == 1
    assert season["pbp_attempts_without_shot"] == 1
    assert season["outside_half_court"] == 1
    assert season["unknown_opponent"] == 0
    assert all(s["cached"] for s in build_atlas(**atlas_paths)["seasons"])
    (atlas_paths["lake"] / "1999-00.parquet").write_bytes(b"corrupt")
    repaired = build_atlas(**atlas_paths)
    assert [s["cached"] for s in repaired["seasons"]] == [False, True]
    (atlas_paths["lake"] / "1999-00.json").write_text("{interrupted")
    assert [s["cached"] for s in build_atlas(**atlas_paths)["seasons"]] == [False, True]
    (atlas_paths["raw"] / "shots-1999-00.tar.xz").write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="checksum"):
        build_atlas(**atlas_paths)


def test_aggregates_filters_baseline_and_pagination_reconcile(atlas_paths):
    build_atlas(**atlas_paths)
    atlas = Atlas(atlas_paths["database"])
    filters = dict(season="1999-00", player_id="1", period=1)
    result = atlas.summary(filters)
    assert (result["n"], result["made"], result["points"]) == (10, 5, 10)
    cell = result["bins"][0]
    assert cell["frequency"] == 100
    assert cell["fg_pct"] == 50
    assert cell["points_per_attempt"] == 1  # 2-point makes, not a possession metric
    assert cell["baseline_n"] == 30
    assert cell["difference_pp"] == 0
    assert result["baseline"]["n"] == 30  # Player filter removed; period retained
    assert sum(h["n"] for h in result["histogram"]) == result["n"]
    assert atlas.summary(dict(season="1999-00", player_id="2", shot_value=3))["points"] == 30
    assert atlas.summary(dict(season="1999-00", team_id="100", opponent="AWY"))["n"] == 12
    assert atlas.summary(dict(season="1999-00", team_id="100", opponent="HOM"))["n"] == 0
    all_rows = atlas.attempts(dict(season="1999-00"), None, 0, 100)
    assert all_rows["total"] == 32
    assert len({s["shot_id"] for s in all_rows["attempts"]}) == 32
    assert (
        atlas.attempts(filters, "0:0", 5, 5)["attempts"]
        == atlas.attempts(filters, "0:0", 0, 100)["attempts"][5:10]
    )
    outside = atlas.summary(dict(season="1999-00", period=2))
    assert sum(b["n"] for b in outside["bins"]) == 2
    assert all(not b["reliable"] and b["difference_pp"] is None for b in outside["bins"])
    assert any(h["distance"] == 50 and h["n"] == 1 for h in outside["histogram"])
    # Same-season baseline cannot include attempts from the other partition.
    assert atlas.options()["seasons"][1]["attempts"] == 32
    assert atlas.summary(dict(season="1999-00"))["baseline"]["n"] == 32
    with pytest.raises(ValueError, match="one season"):
        atlas.summary(dict(season="all"))


def test_atlas_api_boundaries_and_missing_tracking(atlas_paths):
    build_atlas(**atlas_paths)
    client = TestClient(
        create_app(atlas_paths["database"].with_name("no-tracking.duckdb"), atlas_paths["database"])
    )
    assert client.get("/atlas/options").json()["version"] == "shot-atlas-v1"
    assert client.get("/atlas/summary", params=dict(season="1999-00", period=0)).status_code == 422
    assert client.get("/atlas/summary", params=dict(season="all")).status_code == 422
    assert (
        client.get("/atlas/attempts", params=dict(season="1999-00", limit=101)).status_code == 422
    )
    data = client.get("/atlas/attempts", params=dict(season="1999-00", limit=5)).json()
    assert data["total"] == 32 and len(data["attempts"]) == 5
    assert all(s["tracking_status"] == "unavailable" for s in data["attempts"])
    # Filter text is parameterized, including malicious-looking source-independent values.
    assert (
        client.get("/atlas/summary", params=dict(season="1999-00", player_id="' OR 1=1 --")).json()[
            "n"
        ]
        == 0
    )
    assert TestClient(create_app(Path("/no/sample"))).get("/atlas/options").status_code == 503


def test_fixed_hex_grid_and_outside_accounting():
    assert hex_cell(0, 0) == ("0:0", 0, 0)
    assert hex_cell(30, 0) == ("outside", None, None)
    assert hex_cell(0, 42) == ("outside", None, None)
    # Every center maps back to its own axial cell, independent of cohort or season.
    for x in range(-25, 26):
        for y in range(-5, 42):
            cell, cx, cy = hex_cell(x, y)
            if -25 <= cx <= 25 and -5.25 <= cy <= 41.75:
                assert hex_cell(cx, cy)[0] == cell
