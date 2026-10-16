"""Independent numerical checks for sampled frames of locally audited games.

No raw frames are committed. The browser compares its outputs with this local
reference. RMS uses pairwise distances and velocity uses uncentered normal
equations, independently of the browser's centered calculations.
"""

import itertools
import json
import math
from pathlib import Path

from bkbdata.catalog import Catalog

catalog = Catalog(Path("data/db/basketball.duckdb"))
windows = []
for game in catalog.games():
    candidates = [
        (
            e["segment_id"],
            next(
                s["player_id"]
                for s in catalog.shots(game["game_id"])
                if s["shot_id"] == e["shot_id"]
            ),
        )
        for e in game["examples"]
        if e.get("segment_id")
    ]
    conflict = next((s for s in catalog.segments(game["game_id"]) if s["conflict_frames"]), None)
    if conflict and all(conflict["segment_id"] != sid for sid, _ in candidates):
        bundle = catalog.replay(game["game_id"], conflict["segment_id"])
        player = next(e.entity_id for f in bundle.frames for e in f.entities if e.kind == "player")
        candidates.append((conflict["segment_id"], player))
    for segment_id, player_id in candidates:
        bundle = catalog.replay(game["game_id"], segment_id)
        roster = {p["player_id"]: p["team_id"] for p in bundle.players}

        def entity_at(index, identity):
            frame = bundle.frames[index]
            if frame.timestamp_conflict:
                return None
            entities = [e for e in frame.entities if e.entity_id == identity]
            if len(entities) != 1 or roster.get(identity) != entities[0].team_id:
                return None
            return entities[0]

        def broken(index):
            a, b = bundle.frames[index - 1 : index + 1]
            return (
                b.break_before
                or a.period != b.period
                or a.timestamp_conflict
                or b.timestamp_conflict
                or abs(b.source_timestamp_ms - a.source_timestamp_ms - 40) > 5
                or b.game_clock_s > a.game_clock_s + 0.1
            )

        indices = {0, 4, len(bundle.frames) // 2, len(bundle.frames) - 1}
        indices.update(i for i, f in enumerate(bundle.frames) if f.timestamp_conflict)
        checks = []
        for index in sorted(i for i in indices if i < len(bundle.frames)):
            point = entity_at(index, player_id)
            expected = {
                "left": None,
                "right": None,
                "nearer": None,
                "opponent": None,
                "speed": None,
            }
            if point:
                expected["left"] = math.dist((point.x_ft, point.y_ft), (5.25, 25))
                expected["right"] = math.dist((point.x_ft, point.y_ft), (88.75, 25))
                expected["nearer"] = min(expected["left"], expected["right"])
                opponents = [
                    entity_at(index, identity)
                    for identity, team in roster.items()
                    if team != point.team_id
                ]
                opponents = [entity for entity in opponents if entity is not None]
                if len(opponents) == 5:
                    expected["opponent"] = min(
                        math.dist((point.x_ft, point.y_ft), (e.x_ft, e.y_ft)) for e in opponents
                    )
                if index >= 4:
                    history = [entity_at(i, player_id) for i in range(index - 4, index + 1)]
                    if all(history) and not any(broken(i) for i in range(index - 3, index + 1)):
                        ts = [
                            (
                                bundle.frames[i].source_timestamp_ms
                                - bundle.frames[index - 4].source_timestamp_ms
                            )
                            / 1000
                            for i in range(index - 4, index + 1)
                        ]
                        denominator = 5 * sum(t * t for t in ts) - sum(ts) ** 2
                        slopes = [
                            (
                                5 * sum(t * getattr(e, axis) for t, e in zip(ts, history))
                                - sum(ts) * sum(getattr(e, axis) for e in history)
                            )
                            / denominator
                            for axis in ("x_ft", "y_ft")
                        ]
                        expected["speed"] = math.hypot(*slopes)
            teams = []
            for team in sorted(set(roster.values())):
                members = [
                    entity_at(index, identity) for identity in roster if roster[identity] == team
                ]
                members = [e for e in members if e is not None]
                pairs = sum(
                    (a.x_ft - b.x_ft) ** 2 + (a.y_ft - b.y_ft) ** 2
                    for a, b in itertools.combinations(members, 2)
                )
                teams.append(
                    {
                        "team_id": team,
                        "count": len(members),
                        "rms": math.sqrt(pairs / len(members) ** 2) if len(members) > 1 else None,
                    }
                )
            checks.append(
                {"index": index, "player_id": player_id, "expected": expected, "teams": teams}
            )
        windows.append({"game_id": game["game_id"], "segment_id": segment_id, "checks": checks})
result = {
    "source_fingerprint": catalog.health()["source_fingerprint"],
    "numerical_tolerance": 1e-8,
    "windows": windows,
}
path = Path("data/exports/m1-reference.json")
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(result, indent=2) + "\n")
print(f"Wrote independent reference for {len(windows)} real windows")
