"""Recorded ball flight for audited attempts. No fitted arcs, no inferred direction.

The target rim is the one the recorded ball reaches; a candidate release is the
last shooter-held observation before uninterrupted flight to it. Neither is a
validated release annotation.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import statistics
from collections import Counter
from pathlib import Path

from bkbdata.acquire import sha256
from bkbdata.catalog import Catalog

VERSION = "basketball-arc-v1"
RIM_HEIGHT_FT = 10.0
RIM_RADIUS_FT = 0.75
RIMS = {"left": (5.25, 25.0), "right": (88.75, 25.0)}
DEFINITION = dict(
    version=VERSION,
    population="Shots with a matched M0 tracking window",
    height="SportVU ball z in source feet; checked against made-shot rim crossings",
    rim_arrival=(
        "First observation of a run with ball within 2 ft horizontally of a rim "
        "centre and 7.5-13 ft high, game clock in [event - 1, event + 6] s"
    ),
    candidate_release=(
        "Walking back from arrival: last observation with ball within 2 ft "
        "horizontally of the shooter; every step must be observed and unbroken"
    ),
    selection="Latest qualifying flight in the search interval",
    plausibility=[
        "flight at most 2.5 s",
        "ball at least 6 ft high throughout flight",
        "release-to-rim distance within 4 ft of the shot-chart distance",
    ],
    after_arrival="Up to 19 further unbroken observations, shown as context",
    side_view="Signed distance along the release-to-rim line; lateral offset dropped",
    entry_angle=(
        "Derived: descent angle between arrival and the observation up to three "
        "frames earlier (not before apex); unavailable under 0.3 ft horizontal travel"
    ),
    rim_crossing=(
        "Horizontal rim distance at the recorded observation nearest 10 ft on the "
        "first descending crossing after apex; no interpolation"
    ),
    height_check="Made crossings: at least 90% within 1.5 ft and median below misses",
    not_claimed=["verified release", "attacking direction", "shot quality", "contest"],
)
DEFINITION_HASH = hashlib.sha256(json.dumps(DEFINITION, sort_keys=True).encode()).hexdigest()

HAND_FT, NEAR_FT, Z_LOW, Z_HIGH = 2.0, 2.0, 7.5, 13.0
MAX_FLIGHT_MS, MIN_FLIGHT_Z, MAX_DISTANCE_DELTA = 2500, 6.0, 4.0
AFTER_FRAMES = 19


def _ball(frame: dict) -> dict | None:
    balls = [e for e in frame["entities"] if e["kind"] == "ball"]
    return balls[0] if len(balls) == 1 else None


def _player(frame: dict, player_id: str) -> dict | None:
    return next((e for e in frame["entities"] if e["entity_id"] == player_id), None)


def _rim_distance(entity: dict, rim: str) -> float:
    x, y = RIMS[rim]
    return math.hypot(entity["x_ft"] - x, entity["y_ft"] - y)


def _at_rim(ball: dict | None) -> str | None:
    if ball is None or not Z_LOW <= ball["z_ft"] <= Z_HIGH:
        return None
    rim = min(RIMS, key=lambda r: _rim_distance(ball, r))
    return rim if _rim_distance(ball, rim) <= NEAR_FT else None


def _candidate(frames: list[dict], i: int, rim: str, shot: dict) -> dict:
    j = i
    while True:
        ball, shooter = _ball(frames[j]), _player(frames[j], shot["player_id"])
        if ball is None or shooter is None:
            return dict(arrival=i, reason="missing_observation")
        if math.hypot(ball["x_ft"] - shooter["x_ft"], ball["y_ft"] - shooter["y_ft"]) <= HAND_FT:
            break
        if j == 0 or frames[j]["break_before"]:
            return dict(arrival=i, reason="interrupted")
        j -= 1
    if j == i:
        return dict(arrival=i, reason="no_free_flight")
    flight = frames[j : i + 1]
    duration = flight[-1]["source_timestamp_ms"] - flight[0]["source_timestamp_ms"]
    distance = _rim_distance(_ball(flight[0]), rim)
    if duration > MAX_FLIGHT_MS:
        reason = "implausible_duration"
    elif min(_ball(f)["z_ft"] for f in flight) < MIN_FLIGHT_Z:
        reason = "low_ball"
    elif abs(distance - shot["recorded_distance_ft"]) > MAX_DISTANCE_DELTA:
        reason = "distance_disagrees"
    else:
        reason = None
    return dict(arrival=i, release=j, rim=rim, reason=reason)


def detect_flight(frames: list[dict], shot: dict) -> dict:
    """Locate one recorded flight in timestamp-ordered replay frames."""
    frames = [f for f in frames if f["period"] == shot["period"]]
    event = shot["game_clock_s"]
    candidates = []
    for i, frame in enumerate(frames):
        if not event - 1 <= frame["game_clock_s"] <= event + 6:
            continue
        rim = _at_rim(_ball(frame))
        if rim is None:
            continue
        if i and not frame["break_before"] and _at_rim(_ball(frames[i - 1])) == rim:
            continue
        candidates.append(_candidate(frames, i, rim, shot))
    if not candidates:
        return dict(status="unavailable", reason="no_rim_arrival", candidates=0)
    valid = [c for c in candidates if c["reason"] is None]
    if not valid:
        return dict(
            status="unavailable", reason=candidates[-1]["reason"], candidates=len(candidates)
        )
    chosen = valid[-1]
    return dict(
        status="available",
        reason=None,
        candidates=len(candidates),
        **_measure(frames, chosen["release"], chosen["arrival"], chosen["rim"]),
    )


def _measure(frames: list[dict], j: int, i: int, rim: str) -> dict:
    rx, ry = RIMS[rim]
    release = _ball(frames[j])
    dx, dy = release["x_ft"] - rx, release["y_ft"] - ry
    reach = math.hypot(dx, dy)
    ux, uy = dx / reach, dy / reach
    after = []
    for frame in frames[i + 1 : i + 1 + AFTER_FRAMES]:
        if frame["break_before"] or _ball(frame) is None:
            break
        after.append(frame)
    origin = frames[j]["source_timestamp_ms"]
    samples = []
    for index, frame in enumerate([*frames[j : i + 1], *after]):
        ball = _ball(frame)
        samples.append(
            dict(
                frame_id=frame["frame_id"],
                t_ms=frame["source_timestamp_ms"] - origin,
                s_ft=round((ball["x_ft"] - rx) * ux + (ball["y_ft"] - ry) * uy, 3),
                h_ft=round(_rim_distance(ball, rim), 3),
                z_ft=round(ball["z_ft"], 3),
                phase="flight" if index <= i - j else "after",
            )
        )
    flight = samples[: i - j + 1]
    apex = max(range(len(flight)), key=lambda k: flight[k]["z_ft"])
    early = flight[max(len(flight) - 4, apex)]
    end = flight[-1]
    travel = early["h_ft"] - end["h_ft"]
    entry = (
        round(math.degrees(math.atan2(early["z_ft"] - end["z_ft"], travel)), 1)
        if travel >= 0.3
        else None
    )
    crossing = None
    for a, b in zip(samples[apex:], samples[apex + 1 :]):
        if a["z_ft"] >= RIM_HEIGHT_FT > b["z_ft"]:
            crossing = min(a, b, key=lambda p: abs(p["z_ft"] - RIM_HEIGHT_FT))["h_ft"]
            break
    return dict(
        rim=rim,
        release_frame_id=flight[0]["frame_id"],
        arrival_frame_id=end["frame_id"],
        release_clock_s=frames[j]["game_clock_s"],
        release_height_ft=flight[0]["z_ft"],
        release_distance_ft=round(reach, 2),
        apex_height_ft=flight[apex]["z_ft"],
        apex_t_ms=flight[apex]["t_ms"],
        flight_ms=end["t_ms"],
        entry_angle_deg=entry,
        rim_crossing_ft=crossing,
        samples=samples,
    )


def height_check(arcs: list[dict]) -> dict:
    groups = {}
    for made in (True, False):
        values = [
            a["rim_crossing_ft"]
            for a in arcs
            if a["made"] is made and a["rim_crossing_ft"] is not None
        ]
        groups["made" if made else "missed"] = dict(
            flights=sum(a["made"] is made for a in arcs),
            crossings=len(values),
            median_ft=round(statistics.median(values), 3) if values else None,
            within_1_5_ft=sum(v <= 1.5 for v in values),
            values=sorted(round(v, 3) for v in values),
        )
    made, missed = groups["made"], groups["missed"]
    passed = (
        made["crossings"] >= 20
        and made["within_1_5_ft"] >= 0.9 * made["crossings"]
        and missed["median_ft"] is not None
        and made["median_ft"] < missed["median_ft"]
    )
    return dict(passed=passed, rule=DEFINITION["height_check"], **groups)


def build_arcs(database: Path, output: Path) -> dict:
    identity = dict(
        definition_hash=DEFINITION_HASH,
        catalog_sha256=sha256(database),
        adapter_sha256=sha256(Path(__file__)),
    )
    fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    if output.exists():
        saved = json.loads(output.read_text())
        if saved["provenance"]["arc_fingerprint"] == fingerprint:
            return dict(cached=True, arc_fingerprint=fingerprint, coverage=saved["coverage"])
    catalog = Catalog(database)
    arcs, unavailable, reasons = [], [], Counter()
    for game in catalog.games():
        bundles: dict[str, list[dict]] = {}
        for shot in catalog.shots(game["game_id"]):
            join = shot["tracking_join"]
            if join["status"] != "matched":
                continue
            segment = join["segment_id"]
            if segment not in bundles:
                bundles[segment] = catalog.replay(game["game_id"], segment).model_dump()["frames"]
            result = detect_flight(bundles[segment], shot)
            context = dict(
                shot_id=shot["shot_id"],
                game_id=game["game_id"],
                segment_id=segment,
                matchup=f"{game['away_team']} at {game['home_team']}",
                player_id=shot["player_id"],
                player_name=shot["player_name"],
                team_id=shot["team_id"],
                period=shot["period"],
                game_clock_s=shot["game_clock_s"],
                made=shot["made"],
                shot_value=shot["shot_value"],
                action_type=shot["action_type"],
                recorded_distance_ft=shot["recorded_distance_ft"],
                window_continuity=join["window_continuity"],
            )
            if result["status"] == "available":
                arcs.append({**context, **result})
            else:
                reasons[result["reason"]] += 1
                unavailable.append({**context, **result})
    report = dict(
        schema_version=VERSION,
        definition=DEFINITION,
        coverage=dict(
            matched_attempts=len(arcs) + len(unavailable),
            available=len(arcs),
            unavailable=dict(sorted(reasons.items())),
        ),
        height_check=height_check(arcs),
        arcs=arcs,
        unavailable=unavailable,
        provenance=dict(
            input_identity=identity,
            arc_fingerprint=fingerprint,
            source_fingerprint=catalog.health()["source_fingerprint"],
        ),
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    pending = output.with_suffix(".json.part")
    pending.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    os.replace(pending, output)
    return dict(
        cached=False,
        arc_fingerprint=fingerprint,
        coverage=report["coverage"],
        height_check={
            k: {g: n for g, n in v.items() if g != "values"} if isinstance(v, dict) else v
            for k, v in report["height_check"].items()
        },
    )


class Arcs:
    def __init__(self, path: Path, database: Path):
        self.path, self.database = path, database

    def read(self) -> dict:
        if not self.path.exists():
            raise FileNotFoundError("No recorded ball flights. Run make arcs after make audit.")
        data = json.loads(self.path.read_text())
        identity = data["provenance"]["input_identity"]
        if (
            identity["catalog_sha256"] != sha256(self.database)
            or identity["adapter_sha256"] != sha256(Path(__file__))
            or identity["definition_hash"] != DEFINITION_HASH
        ):
            raise ValueError("Ball flights are stale. Rebuild with make arcs.")
        return data
