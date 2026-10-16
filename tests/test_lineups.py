import copy
import json
from pathlib import Path

import duckdb
import pytest
from bkbdata.acquire import sha256
from bkbdata.api import create_app
from bkbdata.lineups import (
    DEFINITION,
    LineupGame,
    Lineups,
    parse_gamebook,
    possession_records,
    reconstruct,
)
from fastapi.testclient import TestClient

F = json.loads(Path("tests/fixtures/m5-lineups.json").read_text())


def rebuild(events=None, box=None):
    return reconstruct(F["game"], events or F["events"], F["shots"], box or F["box"])


def test_controlled_substitutions_preserve_tied_event_order_and_minutes():
    b = rebuild()
    a, c = b.stints
    assert [s.duration_s for s in b.stints] == [120, 600]
    assert a.shot_ids == [F["truth"]["before_sub_shot"]]
    assert F["truth"]["after_sub_shot"] in c.shot_ids
    assert "101" in a.lineups["10"] and "106" not in a.lineups["10"]
    assert "106" in c.lineups["10"] and "101" not in c.lineups["10"]
    assert "206" in c.lineups["20"] and len(c.substitution_ids) == 2
    assert all(s.status == "available" for s in b.stints)
    assert all(s["passed"] for s in b.validation["minute_checks"])
    assert all(s["passed"] for s in b.validation["stat_checks"])
    assert sum(s["reconstructed_s"] for s in b.validation["minute_checks"]) == 7200
    assert c.score_start == [2, 0] and c.score_end == [2, 3]


@pytest.mark.parametrize(
    "fault", ["wrong_team", "incoming_team", "incoming_active", "outgoing_absent", "missing_sub"]
)
def test_substitution_faults_withhold_unresolved_lineups(fault):
    events = copy.deepcopy(F["events"])
    if fault == "wrong_team":
        events[7]["PLAYER1_TEAM_ID"] = "20"
    elif fault == "incoming_team":
        events[7]["PLAYER2_TEAM_ID"] = "20"
    elif fault == "incoming_active":
        events[7]["PLAYER2_ID"] = "102"
    elif fault == "outgoing_absent":
        events[7]["PLAYER1_ID"] = "106"
    else:
        del events[7]
    b = rebuild(events=events)
    assert any(s.status == "unavailable" for s in b.stints)
    assert all(not s.lineups and s.reasons for s in b.stints if s.status == "unavailable")


def test_bench_technical_foul_is_not_starter_evidence():
    events = copy.deepcopy(F["events"])
    technical = {
        **events[1],
        "EVENTNUM": "technical",
        "EVENTMSGACTIONTYPE": "11",
        "PLAYER1_ID": "106",
        "PLAYER2_ID": "0",
    }
    events.insert(1, technical)
    assert all(s.status == "available" for s in rebuild(events=events).stints)


@pytest.mark.parametrize("field,value", [("seconds", 100), ("fga", 4), ("points", 7)])
def test_independent_box_constraint_failure_is_not_repaired(field, value):
    box = copy.deepcopy(F["box"])
    box[0][field] = value
    b = rebuild(box=box)
    assert all(s.status == "unavailable" and not s.lineups for s in b.stints)
    assert b.validation["failures"]


def test_clock_reversal_and_duplicate_identity_cannot_define_an_order():
    events = copy.deepcopy(F["events"])
    events[2]["PCTIMESTRING"] = "12:01"
    with pytest.raises(ValueError, match="clock"):
        rebuild(events=events)
    events = copy.deepcopy(F["events"])
    events[2]["EVENTNUM"] = events[1]["EVENTNUM"]
    with pytest.raises(ValueError, match="Duplicate"):
        rebuild(events=events)


def test_missing_period_boundary_and_participant_team_are_explicitly_unavailable():
    assert all(s.status == "unavailable" for s in rebuild(events=F["events"][:-1]).stints)
    events = copy.deepcopy(F["events"])
    events[2]["PLAYER1_TEAM_ID"] = "20"
    assert rebuild(events=events).stints[0].status == "unavailable"
    events = copy.deepcopy(F["events"])
    events[6].update(PLAYER2_ID="999", PLAYER2_TEAM_ID="10")
    assert rebuild(events=events).stints[0].status == "unavailable"


def test_unavailable_contract_cannot_expose_stale_quintets():
    b = copy.deepcopy(F["bundle"])
    b["stints"][0].update(status="unavailable", reasons=["Unknown group"])
    with pytest.raises(ValueError, match="Unresolved"):
        LineupGame.model_validate(b)
    b["stints"][0].update(status="available", reasons=[], lineups={"10": ["101"] * 5})
    with pytest.raises(ValueError, match="five-player"):
        LineupGame.model_validate(b)


def test_possession_expansion_is_deduplicated_but_missing_coverage_stays_null():
    b = rebuild()
    rows = [*F["possession_rows"], {**F["possession_rows"][0], "DESCRIPTION": "Exploded row"}]
    possession_records(rows, b)
    assert len(b.possessions) == 1 and b.validation["possessions"]["source_rows"] == 2
    assert b.validation["possessions"]["coverage"] == "incomplete"
    assert all(s.possession_count is None for s in b.stints)
    assert b.possessions[0]["stint_id"] is None  # tied substitution boundary
    with pytest.raises(ValueError, match="interval"):
        possession_records([{**rows[0], "ENDTIME": "11:00"}], b)


def test_gamebook_parser_uses_exact_jersey_and_independent_statistics():
    game = copy.deepcopy(F["game"])
    game["players"][5]["jersey"] = "00"
    lines = ["OFFICIAL SCORER'S REPORT FINAL BOX", "VISITOR: Generated away"]
    for p in F["box"]:
        player = next(r for r in game["players"] if r["player_id"] == p["player_id"])
        if p["player_id"] == "201":
            lines.append("HOME: Generated home")
        seconds = int(p["seconds"])
        stats = [p["fgm"], p["fga"], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, p["points"]]
        lines.append(
            f"{player['jersey']} {player['name']} {'G' if p['starter'] else ''} "
            f"{seconds // 60}:{seconds % 60:02d} " + " ".join(map(str, stats))
        )
    text = "\n".join(lines)
    parsed = parse_gamebook(text, game)
    assert len(parsed) == 12 and parsed[5]["player_id"] == "106"
    with pytest.raises(ValueError, match="name"):
        parse_gamebook(text.replace("Generated 10 player 1", "Unrelated player"), game)


def test_read_only_api_missing_unknown_stale_and_schema(tmp_path):
    source = tmp_path / "sample.duckdb"
    source.write_bytes(b"Generated source identity")
    database = tmp_path / "lineups.duckdb"
    client = TestClient(create_app(source, lineups_database=database))
    assert client.get("/lineups/options").status_code == 503
    import bkbdata.lineups as module

    metadata = {
        **F["options"],
        "definition": DEFINITION,
        "input_identity": dict(
            source_database_sha256=sha256(source), adapter_sha256=sha256(Path(module.__file__))
        ),
    }
    with duckdb.connect(str(database)) as con:
        con.execute("CREATE TABLE metadata(payload VARCHAR)")
        con.execute("INSERT INTO metadata VALUES (?)", [json.dumps(metadata)])
        con.execute("CREATE TABLE games(game_id VARCHAR,payload VARCHAR)")
        con.execute(
            "INSERT INTO games VALUES (?,?)", [F["game"]["game_id"], json.dumps(F["bundle"])]
        )
    assert client.get("/lineups/options").status_code == 200
    assert (
        client.get("/lineups/games/0000000001").json()["bundle"]["stints"][0]["duration_s"] == 120
    )
    assert client.get("/lineups/games/invalid%27").status_code == 404
    source.write_bytes(b"Changed source")
    assert client.get("/lineups/options").status_code == 422
    with pytest.raises(ValueError, match="stale"):
        Lineups(database, source).read()
