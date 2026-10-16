"""Conservative source-ID joins with clock, player, period and result checks."""

from __future__ import annotations

import math
import statistics
from collections import Counter, defaultdict

from bkbdata.coordinates import shot_basket_feet, shot_on_source_court
from bkbdata.sources import game_id, parse_clock


def normalize_events(rows: list[dict]) -> list[dict]:
    return [
        {
            "game_id": game_id(row["GAME_ID"]),
            "source_game_id": row["GAME_ID"],
            "event_id": f"nbastats:{game_id(row['GAME_ID'])}:{row['EVENTNUM']}",
            "source_event_id": row["EVENTNUM"],
            "period": int(row["PERIOD"]),
            "game_clock_s": parse_clock(row["PCTIMESTRING"]),
            "event_type": int(row["EVENTMSGTYPE"]),
            "player_id": row["PLAYER1_ID"],
            "team_id": row.get("PLAYER1_TEAM_ID") or None,
            "description": " / ".join(
                row[key]
                for key in ("HOMEDESCRIPTION", "NEUTRALDESCRIPTION", "VISITORDESCRIPTION")
                if row[key]
            ),
            "score": row["SCORE"] or None,
        }
        for row in rows
    ]


def normalize_shots(rows: list[dict]) -> list[dict]:
    result = []
    keys = Counter((row["GAME_ID"], row["GAME_EVENT_ID"]) for row in rows)
    for index, row in enumerate(rows):
        if row["SHOT_TYPE"] not in {"2PT Field Goal", "3PT Field Goal"}:
            raise ValueError(f"Unsupported shot type: {row['SHOT_TYPE']}")
        if row["SHOT_MADE_FLAG"] not in {"0", "1"} or row["SHOT_ATTEMPTED_FLAG"] != "1":
            raise ValueError("Expected a recorded made/missed field-goal attempt")
        lateral, forward = shot_basket_feet(float(row["LOC_X"]), float(row["LOC_Y"]))
        shot_id = f"shotchart:{game_id(row['GAME_ID'])}:{row['GAME_EVENT_ID']}"
        duplicate = keys[(row["GAME_ID"], row["GAME_EVENT_ID"])] > 1
        result.append(
            {
                "shot_id": f"{shot_id}:{index}" if duplicate else shot_id,
                "duplicate_source_key": duplicate,
                "game_id": game_id(row["GAME_ID"]),
                "source_game_id": row["GAME_ID"],
                "source_event_id": row["GAME_EVENT_ID"],
                "player_id": row["PLAYER_ID"],
                "player_name": row["PLAYER_NAME"],
                "team_id": row["TEAM_ID"],
                "period": int(row["PERIOD"]),
                "game_clock_s": int(row["MINUTES_REMAINING"]) * 60 + int(row["SECONDS_REMAINING"]),
                "made": row["SHOT_MADE_FLAG"] == "1",
                "action_type": row["ACTION_TYPE"],
                "shot_value": 3 if row["SHOT_TYPE"] == "3PT Field Goal" else 2,
                "loc_x": float(row["LOC_X"]),
                "loc_y": float(row["LOC_Y"]),
                "lateral_ft": lateral,
                "forward_ft": forward,
                "recorded_distance_ft": float(row["SHOT_DISTANCE"]),
            }
        )
    return result


def link_shots(shots: list[dict], events: list[dict], segments: list[dict], frames: dict) -> dict:
    events_by_id, segments_by_id = defaultdict(list), defaultdict(list)
    for event in events:
        events_by_id[event["source_event_id"]].append(event)
    for segment in segments:
        segments_by_id[segment["source_event_id"]].append(segment)
    pbp_counts, tracking_counts = Counter(), Counter()
    for shot in shots:
        candidates = events_by_id[shot["source_event_id"]]
        consistent = [
            e
            for e in candidates
            if e["period"] == shot["period"]
            and e["player_id"] == shot["player_id"]
            and e["team_id"] == shot["team_id"]
            and e["event_type"] == (1 if shot["made"] else 2)
            and abs(e["game_clock_s"] - shot["game_clock_s"]) <= 1
        ]
        if shot["duplicate_source_key"] or len(consistent) > 1 or len(candidates) > 1:
            pbp_status, pbp_reason = (
                "ambiguous",
                "Duplicate source key or multiple event candidates",
            )
        elif len(consistent) == 1:
            pbp_status, pbp_reason = "matched", None
        else:
            pbp_status = "unmatched"
            pbp_reason = "Event ID absent" if not candidates else "Event metadata disagrees"
        shot["event_join"] = {
            "status": pbp_status,
            "method": "source_id_with_metadata_checks",
            "reason": pbp_reason,
        }
        pbp_counts[pbp_status] += 1
        tracking = {
            "status": "unavailable",
            "method": "source_event_id_and_clock",
            "reason": "Shot-to-event join is not verified",
            "segment_id": None,
            "clock_delta_s": None,
            "timing_confidence": "unavailable",
            "window_continuity": None,
        }
        if pbp_status == "matched":
            candidates = segments_by_id[shot["source_event_id"]]
            if len(candidates) > 1:
                tracking.update(status="ambiguous", reason="Multiple source event windows")
            elif not candidates:
                tracking.update(status="unmatched", reason="No source event window")
            else:
                segment = candidates[0]
                valid = [
                    frames[fid]
                    for fid in segment["frame_ids"]
                    if frames[fid]["period"] == shot["period"]
                    and any(e["entity_id"] == shot["player_id"] for e in frames[fid]["entities"])
                ]
                if valid:
                    nearest = min(
                        valid, key=lambda f: abs(f["game_clock_s"] - shot["game_clock_s"])
                    )
                    delta = abs(nearest["game_clock_s"] - shot["game_clock_s"])
                    if delta <= 1:
                        tracking.update(
                            status="matched",
                            reason=None,
                            segment_id=segment["segment_id"],
                            clock_delta_s=delta,
                            timing_confidence="event_clock_only",
                            window_continuity=segment["continuity"],
                        )
                    else:
                        tracking.update(
                            status="unmatched",
                            reason="Event clock outside window",
                            clock_delta_s=delta,
                        )
                else:
                    tracking.update(status="unmatched", reason="No period/shooter observations")
        shot["tracking_join"] = tracking
        tracking_counts[tracking["status"]] += 1
    return {"shot_to_event": dict(pbp_counts), "shot_to_tracking": dict(tracking_counts)}


def coordinate_checks(shots: list[dict], segments: list[dict], frames: dict) -> dict:
    """Compare independently recorded shooter positions with shot coordinates.

    This is a convention diagnostic, not a release detector or direction label.
    Search a fixed +/-1 game-clock second neighborhood in the matching window.
    """
    by_id = {s["segment_id"]: s for s in segments}
    grouped = defaultdict(list)
    distance_errors = []
    for shot in shots:
        distance_errors.append(
            abs(math.hypot(shot["lateral_ft"], shot["forward_ft"]) - shot["recorded_distance_ft"])
        )
        join = shot["tracking_join"]
        if join["status"] != "matched":
            continue
        segment = by_id[join["segment_id"]]
        positions = [
            e
            for fid in segment["frame_ids"]
            for e in frames[fid]["entities"]
            if frames[fid]["period"] == shot["period"]
            and abs(frames[fid]["game_clock_s"] - shot["game_clock_s"]) <= 1
            and e["entity_id"] == shot["player_id"]
        ]
        if not positions:
            continue
        errors = {}
        for basket in ("left", "right"):
            for sign in (-1, 1):
                x, y = shot_on_source_court(shot["lateral_ft"], shot["forward_ft"], basket, sign)
                errors[f"{basket}:sign{sign:+}"] = min(
                    math.hypot(e["x_ft"] - x, e["y_ft"] - y) for e in positions
                )
        grouped[(shot["team_id"], shot["period"])].append(
            {
                "shot_id": shot["shot_id"],
                "errors": errors,
            }
        )
    groups = []
    for (team, period), values in sorted(grouped.items()):
        medians = {
            key: round(statistics.median(v["errors"][key] for v in values), 4)
            for key in values[0]["errors"]
        }
        best = min(medians, key=medians.get)
        groups.append(
            {
                "team_id": team,
                "period": period,
                "shots": len(values),
                "median_min_distance_ft": medians,
                "best_candidate": best,
                "examples": values[:2],
            }
        )
    return {
        "method": "shooter nearest position within +/-1 game-clock second of event",
        "direction_applied": False,
        "groups": groups,
        "shot_distance_check": {
            "shots": len(distance_errors),
            "median_absolute_error_ft": round(statistics.median(distance_errors), 4)
            if distance_errors
            else None,
            "within_2ft": sum(error <= 2 for error in distance_errors),
        },
    }
