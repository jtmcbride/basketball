import json
import math

import pytest
from bkbdata.api import create_app
from bkbdata.arcs import Arcs, detect_flight, height_check
from fastapi.testclient import TestClient

G = 32.17
# Generated flight: released 20 ft from the left rim, crossing the rim plane at t=1 s.
LIFT = 1 + G / 2


def flight_frames(dunk=False, break_at=None, drop_ball_at=None, period=1):
    frames = []
    for k in range(60):
        t = (k - 10) * 0.04
        if dunk:
            bx, bz, sx = 5.25 + max(0, 1.5 - k * 0.05), 9.0 + min(k, 20) * 0.1, None
        elif t <= 0:
            bx, bz, sx = 25.25, 9.0, None
        else:
            bx, bz, sx = 25.25 - 20 * t, 9 + LIFT * t - G / 2 * t * t, 25.25
        shooter_x = bx if sx is None else sx
        entities = [
            {"entity_id": "7", "kind": "player", "x_ft": shooter_x, "y_ft": 25.0, "z_ft": None},
            {"entity_id": "8", "kind": "player", "x_ft": 40.0, "y_ft": 10.0, "z_ft": None},
        ]
        if k != drop_ball_at:
            entities.append(
                {"entity_id": "ball", "kind": "ball", "x_ft": bx, "y_ft": 25.0, "z_ft": max(bz, 0)}
            )
        frames.append(
            {
                "frame_id": f"f{k}",
                "period": period,
                "source_timestamp_ms": 1_000_000 + k * 40,
                "game_clock_s": round(700 - k * 0.04, 2),
                "break_before": k == break_at,
                "entities": entities,
            }
        )
    return frames


SHOT = {"player_id": "7", "period": 1, "game_clock_s": 698.0, "recorded_distance_ft": 20.0}


def test_generated_parabola_recovers_release_apex_and_rim_crossing():
    r = detect_flight(flight_frames(), SHOT)
    assert r["status"] == "available" and r["rim"] == "left"
    assert r["release_frame_id"] == "f12"  # last observation within 2 ft (1.6 ft) of the shooter
    assert r["release_distance_ft"] == pytest.approx(18.4, abs=0.01)
    assert r["apex_height_ft"] == pytest.approx(9 + LIFT**2 / (2 * G), abs=0.02)
    assert r["rim_crossing_ft"] <= 0.8
    # Arrival is the first frame within 2 ft (t=0.92 s); chord from three frames earlier.
    z = lambda t: 9 + LIFT * t - G / 2 * t * t  # noqa: E731
    chord = math.degrees(math.atan2(z(0.8) - z(0.92), 20 * 0.12))
    assert r["entry_angle_deg"] == pytest.approx(chord, abs=0.1)
    flight = [s for s in r["samples"] if s["phase"] == "flight"]
    after = [s for s in r["samples"] if s["phase"] == "after"]
    assert flight[0]["t_ms"] == 0 and flight[0]["s_ft"] == pytest.approx(18.4, abs=0.01)
    assert all(a["t_ms"] < b["t_ms"] for a, b in zip(r["samples"], r["samples"][1:]))
    assert after and after[-1]["s_ft"] < 0  # passes through the rim, behind its centre
    assert r["flight_ms"] == flight[-1]["t_ms"]


def test_samples_are_recorded_heights_not_a_fitted_curve():
    frames = flight_frames()
    frames[20]["entities"][-1]["z_ft"] = 12.345
    r = detect_flight(frames, SHOT)
    assert any(s["frame_id"] == "f20" and s["z_ft"] == 12.345 for s in r["samples"])


@pytest.mark.parametrize(
    ("frames", "shot", "reason"),
    [
        (flight_frames(dunk=True), SHOT, "no_free_flight"),
        (flight_frames(break_at=20), SHOT, "interrupted"),
        (flight_frames(drop_ball_at=20), SHOT, "missing_observation"),
        (flight_frames(), {**SHOT, "recorded_distance_ft": 27.0}, "distance_disagrees"),
        (flight_frames(period=2), SHOT, "no_rim_arrival"),
        (flight_frames(), {**SHOT, "game_clock_s": 690.0}, "no_rim_arrival"),
    ],
)
def test_unverifiable_flights_remain_unavailable_with_a_reason(frames, shot, reason):
    r = detect_flight(frames, shot)
    assert r["status"] == "unavailable" and r["reason"] == reason
    assert "samples" not in r


def test_height_check_requires_makes_to_cross_near_the_rim():
    made = [{"made": True, "rim_crossing_ft": 0.3} for _ in range(20)]
    missed = [{"made": False, "rim_crossing_ft": 2.0} for _ in range(10)]
    assert height_check(made + missed)["passed"]
    assert not height_check(made[:19] + missed)["passed"]
    wide = [{"made": True, "rim_crossing_ft": 1.6 if i < 3 else 0.3} for i in range(20)]
    assert not height_check(wide + missed)["passed"]
    assert not height_check(made + [{"made": False, "rim_crossing_ft": 0.2}])["passed"]
    assert height_check(made + missed)["made"]["median_ft"] == 0.3


def test_reader_rejects_missing_and_stale_flights(tmp_path):
    database = tmp_path / "db/basketball.duckdb"
    database.parent.mkdir()
    database.write_bytes(b"catalog")
    path = tmp_path / "exports/arcs-v1.json"
    with pytest.raises(FileNotFoundError):
        Arcs(path, database).read()
    client = TestClient(create_app(database, arcs_path=path))
    assert client.get("/arcs").status_code == 503
    path.parent.mkdir()
    path.write_text(
        json.dumps(
            {
                "provenance": {
                    "input_identity": {
                        "catalog_sha256": "0" * 64,
                        "adapter_sha256": "0" * 64,
                        "definition_hash": "0" * 64,
                    }
                }
            }
        )
    )
    with pytest.raises(ValueError, match="stale"):
        Arcs(path, database).read()
    assert client.get("/arcs").status_code == 422
