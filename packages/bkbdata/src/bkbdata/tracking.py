"""Normalize source event windows, preserving overlaps and timestamp conflicts."""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path


def discontinuity(previous: dict, current: dict) -> bool:
    delta = current["source_timestamp_ms"] - previous["source_timestamp_ms"]
    return (
        current["period"] != previous["period"]
        or abs(delta - 40) > 5
        or current["game_clock_s"] > previous["game_clock_s"] + 0.1
    )


def normalize_tracking(data: dict, output: Path) -> tuple[dict, list[dict], list[dict], dict]:
    game_id = str(data["gameid"])
    events = data["events"]
    first = events[0]
    teams = [first["visitor"], first["home"]]
    players = [
        {
            "player_id": str(player["playerid"]),
            "team_id": str(team["teamid"]),
            "name": f"{player['firstname']} {player['lastname']}",
            "jersey": str(player.get("jersey", "")),
            "position": player.get("position"),
        }
        for team in teams
        for player in team["players"]
    ]
    roster = {player["player_id"]: player["team_id"] for player in players}
    frames: dict[str, dict] = {}
    by_timestamp: dict[tuple, dict[str, str]] = defaultdict(dict)
    segments, references = [], []
    counts, entity_counts, cadence = Counter(), Counter(), Counter()
    examples: dict[str, list] = defaultdict(list)
    event_ids = Counter(str(event["eventId"]) for event in events)

    def flag(code: str, frame_id: str) -> None:
        counts[code] += 1
        frames[frame_id]["quality_flags"].append(code)
        if len(examples[code]) < 5:
            examples[code].append(frame_id)

    for index, event in enumerate(events):
        event_id = str(event["eventId"])
        segment_id = f"sportvu:{game_id}:{event_id}:{index}"
        frame_ids = []
        local_seen = set()
        malformed = 0
        for moment_index, moment in enumerate(event["moments"]):
            counts["raw_moments"] += 1
            try:
                period, timestamp, clock, shot_clock = moment[:4]
                if not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp):
                    raise ValueError("Invalid timestamp")
                if int(timestamp) != timestamp or int(period) < 1:
                    raise ValueError("Invalid timestamp or period")
                if not math.isfinite(clock) or clock < 0:
                    raise ValueError("Invalid game clock")
                entities = []
                for entity in moment[5]:
                    team_id, player_id, x, y, z = entity
                    if not all(math.isfinite(value) for value in (x, y, z)):
                        raise ValueError("Nonfinite position")
                    entities.append(
                        {
                            "entity_id": "ball" if player_id == -1 else str(player_id),
                            "team_id": None if player_id == -1 else str(team_id),
                            "kind": "ball" if player_id == -1 else "player",
                            "x_ft": x,
                            "y_ft": y,
                            "z_ft": z if player_id == -1 else None,
                        }
                    )
                entities.sort(key=lambda entity: entity["entity_id"])
                frame = {
                    "game_id": game_id,
                    "period": int(period),
                    "source_timestamp_ms": int(timestamp),
                    "game_clock_s": clock,
                    "shot_clock_s": shot_clock
                    if shot_clock is not None and math.isfinite(shot_clock)
                    else None,
                    "entities": entities,
                }
            except (ValueError, TypeError, IndexError):
                counts["malformed_moments"] += 1
                malformed += 1
                continue
            signature = hashlib.blake2b(
                json.dumps(frame, sort_keys=True, separators=(",", ":")).encode(), digest_size=16
            ).hexdigest()
            key = (int(period), int(timestamp))
            variants = by_timestamp[key]
            if signature in variants:
                frame_id = variants[signature]
                counts["duplicate_moments"] += 1
            else:
                frame_id = f"{game_id}:{period}:{timestamp}:{len(variants)}"
                variants[signature] = frame_id
                frame["frame_id"] = frame_id
                frame["quality_flags"] = []
                frames[frame_id] = frame
                entity_counts[len(entities)] += 1
                ids = [entity["entity_id"] for entity in entities]
                player_entities = [entity for entity in entities if entity["kind"] == "player"]
                if ids.count("ball") != 1:
                    flag("ball_count_not_one", frame_id)
                if len(player_entities) != 10:
                    flag("player_count_not_ten", frame_id)
                if Counter(e["team_id"] for e in player_entities) != {
                    str(teams[0]["teamid"]): 5,
                    str(teams[1]["teamid"]): 5,
                }:
                    flag("team_count_not_five", frame_id)
                if len(set(ids)) != len(ids):
                    flag("duplicate_entity_ids", frame_id)
                if any(roster.get(e["entity_id"]) != e["team_id"] for e in player_entities):
                    flag("roster_mismatch", frame_id)
                if any(not (0 <= e["x_ft"] <= 94 and 0 <= e["y_ft"] <= 50) for e in entities):
                    flag("outside_court", frame_id)
                if any(not (-2 <= e["x_ft"] <= 96 and -2 <= e["y_ft"] <= 52) for e in entities):
                    flag("outside_court_margin", frame_id)
                if clock > (720 if period <= 4 else 300) + 0.1:
                    flag("game_clock_out_of_range", frame_id)
                if any(e["kind"] == "ball" and not -1 <= e["z_ft"] <= 50 for e in entities):
                    flag("ball_height_out_of_range", frame_id)
                if shot_clock is None or not math.isfinite(shot_clock):
                    flag("missing_shot_clock", frame_id)
                elif not 0 <= shot_clock <= 24.1:
                    flag("shot_clock_out_of_range", frame_id)
            references.append(
                {
                    "game_id": game_id,
                    "segment_id": segment_id,
                    "moment_index": moment_index,
                    "frame_id": frame_id,
                }
            )
            if frame_id in local_seen:
                counts["within_window_duplicates"] += 1
            else:
                frame_ids.append(frame_id)
                local_seen.add(frame_id)
        ordered = [frames[frame_id] for frame_id in frame_ids]
        gaps = 0
        for previous, current in zip(ordered, ordered[1:]):
            delta = current["source_timestamp_ms"] - previous["source_timestamp_ms"]
            cadence[str(delta)] += 1
            if discontinuity(previous, current):
                gaps += 1
            if delta > 0 and current["game_clock_s"] == previous["game_clock_s"]:
                counts["stopped_clock_steps"] += 1
            if delta <= 0:
                counts["nonincreasing_timestamp_steps"] += 1
            if current["game_clock_s"] > previous["game_clock_s"] + 0.1:
                counts["game_clock_increase_steps"] += 1
        segments.append(
            {
                "game_id": game_id,
                "segment_id": segment_id,
                "source_event_id": event_id,
                "source_index": index,
                "frame_ids": frame_ids,
                "frame_count": len(frame_ids),
                "discontinuities": gaps,
                "malformed_moments": malformed,
                "duplicate_event_id": event_ids[event_id] > 1,
            }
        )

    conflict_ids = {
        frame_id
        for variants in by_timestamp.values()
        if len(variants) > 1
        for frame_id in variants.values()
    }
    counts["timestamp_conflict_keys"] = sum(len(v) > 1 for v in by_timestamp.values())
    counts["timestamp_conflict_frames"] = len(conflict_ids)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w") as stream:
        for frame in frames.values():
            frame["timestamp_conflict"] = frame["frame_id"] in conflict_ids
            if frame["timestamp_conflict"]:
                frame["quality_flags"].append("timestamp_conflict")
            stream.write(json.dumps(frame, separators=(",", ":")) + "\n")
    # Use the full frame data for classification; examples are intentionally bounded.
    for segment in segments:
        selected = [frames[frame_id] for frame_id in segment["frame_ids"]]
        missing = sum(
            len([e for e in f["entities"] if e["kind"] == "player"]) != 10
            or len([e for e in f["entities"] if e["kind"] == "ball"]) != 1
            or len({e["entity_id"] for e in f["entities"]}) != len(f["entities"])
            or any(
                e["kind"] == "player" and roster.get(e["entity_id"]) != e["team_id"]
                for e in f["entities"]
            )
            or "team_count_not_five" in f["quality_flags"]
            for f in selected
        )
        segment["entity_problem_frames"] = missing
        segment["conflict_frames"] = sum(f["timestamp_conflict"] for f in selected)
        segment["invalid_clock_frames"] = sum(
            "game_clock_out_of_range" in f["quality_flags"] for f in selected
        )
        segment["continuity"] = (
            "continuous"
            if (
                len(selected) > 1
                and not segment["discontinuities"]
                and not missing
                and not segment["conflict_frames"]
                and not segment["malformed_moments"]
                and not segment["invalid_clock_frames"]
            )
            else "partial"
        )
        segment["periods"] = sorted({f["period"] for f in selected})
    if not frames:
        raise ValueError(f"No usable tracking frames in game {game_id}")
    periods = []
    for period in sorted({f["period"] for f in frames.values()}):
        selected = [f for f in frames.values() if f["period"] == period]
        periods.append(
            {
                "period": period,
                "unique_frames": len(selected),
                "clock_min_s": min(f["game_clock_s"] for f in selected),
                "clock_max_s": max(f["game_clock_s"] for f in selected),
            }
        )
    game = {
        "game_id": game_id,
        "game_date": data["gamedate"],
        "home_team": first["home"]["abbreviation"],
        "away_team": first["visitor"]["abbreviation"],
        "players": players,
        "home_team_id": str(first["home"]["teamid"]),
        "away_team_id": str(first["visitor"]["teamid"]),
        "source_event_windows": len(segments),
        "unique_frames": len(frames),
        "continuous_windows": sum(s["continuity"] == "continuous" for s in segments),
        "partial_windows": sum(s["continuity"] == "partial" for s in segments),
        "empty_windows": sum(not s["frame_count"] for s in segments),
        "periods": periods,
    }
    diagnostics = {
        "counts": dict(counts),
        "entity_count_distribution": dict(entity_counts),
        "cadence_ms": dict(cadence),
        "examples": dict(examples),
        "duplicate_source_event_ids": {key: value for key, value in event_ids.items() if value > 1},
    }
    return game, segments, references, {"diagnostics": diagnostics, "frames": frames}
