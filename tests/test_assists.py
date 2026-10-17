import json
from pathlib import Path

import bkbdata.assists as module
import duckdb
import pytest
from bkbdata.acquire import sha256
from bkbdata.api import create_app
from bkbdata.assists import DEFINITION_HASH, Assists, classify
from fastapi.testclient import TestClient


def pbp(player2="", text="Generated 12' Jump Shot (2 PTS)", team2="10", player1="1"):
    return {
        "HOMEDESCRIPTION": text,
        "NEUTRALDESCRIPTION": "",
        "VISITORDESCRIPTION": "",
        "PLAYER1_ID": player1,
        "PLAYER1_TEAM_ID": "10",
        "PLAYER2_ID": player2,
        "PLAYER2_TEAM_ID": team2,
    }


ASSISTED = "Generated 12' Jump Shot (2 PTS) (Passer 3 AST)"


@pytest.mark.parametrize(
    ("row", "expected"),
    [
        (pbp(), ("unassisted", None)),
        (pbp(player2="0"), ("unassisted", None)),
        (pbp(player2="2", text=ASSISTED), ("assisted", None)),
        (pbp(player2="2"), ("unverified", "field_text_disagree")),
        (pbp(text=ASSISTED), ("unverified", "field_text_disagree")),
        (pbp(player2="2", text=ASSISTED, team2="20"), ("unverified", "other_team")),
        (pbp(player2="1", text=ASSISTED), ("unverified", "self")),
    ],
)
def test_assist_requires_field_text_and_team_agreement(row, expected):
    assert classify(row) == expected


def fixture_db(tmp_path: Path) -> tuple[Path, Path]:
    atlas = tmp_path / "atlas.duckdb"
    atlas.write_bytes(b"generated atlas")
    database = tmp_path / "assists.duckdb"
    # (shooter, passer, cell, value); team 10 unless noted.
    makes = [("1", "2", "0:0", 2)] * 6 + [("1", None, "0:0", 2)] * 6
    makes += [("2", "1", "3:-6", 3)] * 4 + [("3", "1", "3:-6", 3)] * 2 + [("3", None, "1:1", 2)]
    with duckdb.connect(str(database)) as con:
        con.execute(
            "CREATE TABLE makes(season VARCHAR, shot_id VARCHAR, game_id VARCHAR, "
            "team_id VARCHAR, team_name VARCHAR, player_id VARCHAR, player_name VARCHAR, "
            "shot_value INTEGER, cell VARCHAR, cx DOUBLE, cy DOUBLE, status VARCHAR, "
            "passer_id VARCHAR, passer_name VARCHAR)"
        )
        rows = [
            (
                "2015-16",
                f"s{i}",
                "g",
                "10",
                "Generated Ten",
                shooter,
                f"Player {shooter}",
                value,
                cell,
                0.0,
                0.0,
                "assisted" if passer else "unassisted",
                passer,
                f"Player {passer}" if passer else None,
            )
            for i, (shooter, passer, cell, value) in enumerate(makes)
        ]
        rows.append(
            (
                "2015-16",
                "o1",
                "g",
                "20",
                "Generated Twenty",
                "9",
                "Player 9",
                2,
                "0:0",
                0.0,
                0.0,
                "assisted",
                "8",
                "Player 8",
            )
        )
        rows.append(
            (
                "2015-16",
                "u1",
                "g",
                "10",
                "Generated Ten",
                "1",
                "Player 1",
                2,
                "0:0",
                0.0,
                0.0,
                "unmatched",
                None,
                None,
            )
        )
        con.executemany(f"INSERT INTO makes VALUES ({','.join('?' * 14)})", rows)
        con.execute("CREATE TABLE metadata(value VARCHAR)")
        identity = dict(
            definition_hash=DEFINITION_HASH,
            atlas_sha256=sha256(atlas),
            adapter_sha256=sha256(Path(module.__file__)),
        )
        con.execute(
            "INSERT INTO metadata VALUES (?)",
            [json.dumps(dict(fingerprint="f", input_identity=identity, coverage={}))],
        )
    return database, atlas


def test_shares_count_verified_makes_only_and_reconcile(tmp_path):
    a = Assists(*fixture_db(tmp_path))
    s = a.summary("2015-16", "10")
    by_value = {t["shot_value"]: t for t in s["totals"]}
    assert by_value[2] == {"shot_value": 2, "makes": 13, "assisted": 6}
    assert by_value[3]["assisted"] == by_value[3]["makes"] == 6
    rim = next(c for c in s["cells"] if c["cell"] == "0:0")
    assert rim["share"] == 0.5 and rim["reliable"]
    assert rim["league_share"] == pytest.approx(7 / 13)  # league includes team 20
    assert not next(c for c in s["cells"] if c["cell"] == "1:1")["reliable"]
    assert sum(c["per_100"] for c in s["cells"]) == pytest.approx(100)
    assert s["unverified_team_makes"] == 1
    assert {p["id"]: (p["assists"], p["assisted"]) for p in s["players"]} == {
        "1": (6, 6),
        "2": (6, 4),
        "3": (0, 2),
    }
    assert sum(link["makes"] for link in s["network"]["links"]) == 12


def test_passer_map_places_assists_at_the_shooters_location(tmp_path):
    a = Assists(*fixture_db(tmp_path))
    s = a.summary("2015-16", "10", "1", "passer")
    assert [(c["cell"], c["makes"]) for c in s["cells"]] == [("3:-6", 6)]
    assert s["partners"]["targets"] == [
        {"id": "2", "name": "Player 2", "makes": 4},
        {"id": "3", "name": "Player 3", "makes": 2},
    ]
    shooter = a.summary("2015-16", "10", "1", "shooter")
    assert shooter["partners"]["passers"] == [{"id": "2", "name": "Player 2", "makes": 6}]
    with pytest.raises(ValueError, match="requires a player"):
        a.summary("2015-16", "10", None, "passer")
    with pytest.raises(KeyError):
        a.summary("2015-16", "10", "9")
    with pytest.raises(KeyError):
        a.summary("2023-24", "10")


def test_reader_rejects_missing_and_stale_index(tmp_path):
    database, atlas = fixture_db(tmp_path)
    client = TestClient(
        create_app(tmp_path / "basketball.duckdb", atlas_database=atlas, assists_database=database)
    )
    assert client.get("/assists/summary?season=2015-16&team_id=10").status_code == 200
    assert client.get("/assists/summary?season=2015-16&team_id=10&role=other").status_code == 422
    atlas.write_bytes(b"rebuilt atlas")
    assert client.get("/assists/options").status_code == 422
    database.unlink()
    assert client.get("/assists/options").status_code == 503
