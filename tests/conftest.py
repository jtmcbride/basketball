"""Generated fixtures only; no source NBA records are checked into the tests."""

import copy
import csv
import io
import json
import tarfile
from pathlib import Path

import py7zr
import pytest
from bkbdata.acquire import sha256
from bkbdata.audit import build_audit


def moment(timestamp=1000000, clock=700.0, missing_ball=False):
    entities = [[100 if i < 5 else 200, i + 1, 10.0 + i, 20.0, 0.0] for i in range(10)]
    if not missing_ball:
        entities.insert(0, [-1, -1, 14.0, 20.0, 4.0])
    return [1, timestamp, clock, 20.0, None, entities]


@pytest.fixture
def tracking_game():
    home = {
        "name": "Generated Home",
        "abbreviation": "HOM",
        "teamid": 100,
        "players": [
            {
                "playerid": i,
                "firstname": "Generated",
                "lastname": str(i),
                "jersey": str(i),
                "position": "G",
            }
            for i in range(1, 6)
        ],
    }
    away = {
        "name": "Generated Away",
        "abbreviation": "AWY",
        "teamid": 200,
        "players": [
            {
                "playerid": i,
                "firstname": "Generated",
                "lastname": str(i),
                "jersey": str(i),
                "position": "F",
            }
            for i in range(6, 11)
        ],
    }
    return {
        "gameid": "0000000001",
        "gamedate": "2000-01-01",
        "events": [
            {
                "eventId": "5",
                "home": home,
                "visitor": away,
                "moments": [moment(), moment(1000040, 699.96), moment(1000080, 699.92)],
            },
            {
                "eventId": "6",
                "home": home,
                "visitor": away,
                "moments": [
                    moment(1000040, 699.96),
                    moment(1000080, 699.92),
                    moment(1001000, 699.0, missing_ball=True),
                ],
            },
        ],
    }


def shot_row(**overrides):
    return {
        "GAME_ID": "1",
        "GAME_EVENT_ID": "5",
        "PLAYER_ID": "1",
        "PLAYER_NAME": "Generated 1",
        "TEAM_ID": "100",
        "PERIOD": "1",
        "MINUTES_REMAINING": "11",
        "SECONDS_REMAINING": "40",
        "SHOT_MADE_FLAG": "1",
        "SHOT_ATTEMPTED_FLAG": "1",
        "ACTION_TYPE": "Jump Shot",
        "SHOT_TYPE": "2PT Field Goal",
        "LOC_X": "50",
        "LOC_Y": "90",
        "SHOT_DISTANCE": "10",
        **overrides,
    }


def event_row(**overrides):
    return {
        "GAME_ID": "1",
        "EVENTNUM": "5",
        "EVENTMSGTYPE": "1",
        "PERIOD": "1",
        "PCTIMESTRING": "11:40",
        "PLAYER1_ID": "1",
        "PLAYER1_TEAM_ID": "100",
        "HOMEDESCRIPTION": "Generated shot",
        "NEUTRALDESCRIPTION": "",
        "VISITORDESCRIPTION": "",
        "SCORE": "2 - 0",
        **overrides,
    }


def csv_archive(path: Path, rows):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
    content = stream.getvalue().encode()
    with tarfile.open(path, "w:xz") as archive:
        member = tarfile.TarInfo("generated.csv")
        member.size = len(content)
        archive.addfile(member, io.BytesIO(content))


@pytest.fixture
def sample_sources(tmp_path, tracking_game):
    raw = tmp_path / "raw"
    raw.mkdir()
    game = raw / "generated.json"
    game.write_text(json.dumps(tracking_game))
    with py7zr.SevenZipFile(raw / "tracking.7z", "w") as archive:
        archive.write(game, arcname="0000000001.json")
    csv_archive(
        raw / "shots.tar.xz",
        [shot_row(), shot_row(GAME_EVENT_ID="6", SHOT_MADE_FLAG="0", SECONDS_REMAINING="39")],
    )
    csv_archive(
        raw / "events.tar.xz",
        [event_row(), event_row(EVENTNUM="6", EVENTMSGTYPE="2", PCTIMESTRING="11:39")],
    )
    sources = []
    for kind, filename in (
        ("tracking", "tracking.7z"),
        ("shots", "shots.tar.xz"),
        ("play_by_play", "events.tar.xz"),
    ):
        source = {
            "id": kind,
            "kind": kind,
            "filename": filename,
            "url": f"https://example.invalid/{filename}",
            "revision": "generated",
            "rights_note": "Generated test fixture",
        }
        sources.append(source)
        manifest = {
            **source,
            "sha256": sha256(raw / filename),
            "acquired_at": "2000-01-01Z",
            "bytes": (raw / filename).stat().st_size,
        }
        (raw / f"{filename}.manifest.json").write_text(json.dumps(manifest))
    config = tmp_path / "sources.json"
    config.write_text(json.dumps({"version": 1, "sources": sources}))
    return {
        "config": config,
        "raw": raw,
        "database": tmp_path / "catalog.duckdb",
        "lake": tmp_path / "lake",
        "report": tmp_path / "report.json",
    }


@pytest.fixture
def catalog_sample(sample_sources):
    result = build_audit(**sample_sources)
    return copy.deepcopy(result), sample_sources
