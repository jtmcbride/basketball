"""Independent analytic fixture: known 3–4–5 motion, no NBA data.

Expected values use Decimal geometry and literal analytic speeds rather than the
browser's implementation. Regenerate with uv run python scripts/generate_motion_fixture.py.
"""

import json
from decimal import Decimal, getcontext
from pathlib import Path

from bkbdata.contracts import ReplayBundle

getcontext().prec = 40
positions = [
    (8.25, 29),
    (6.25, 29),
    (10.25, 29),
    (8.25, 27),
    (8.25, 31),
    (11.25, 33),
    (70, 10),
    (72, 20),
    (75, 30),
    (78, 40),
]
frames = []
for i in range(6):
    t = i * 0.04
    entities = []
    for j, (x, y) in enumerate(positions):
        moving = j <= 5
        entities.append(
            {
                "entity_id": str(j + 1),
                "team_id": "100" if j < 5 else "200",
                "kind": "player",
                "x_ft": x + (3 * t if moving else 0),
                "y_ft": y + (4 * t if moving else 0),
                "z_ft": None,
            }
        )
    entities.append(
        {
            "entity_id": "ball",
            "team_id": None,
            "kind": "ball",
            "x_ft": 8.25 + 3 * t,
            "y_ft": 29 + 4 * t,
            "z_ft": 4.0,
        }
    )
    frames.append(
        {
            "frame_id": f"generated-{i}",
            "period": 1,
            "source_timestamp_ms": 1000000 + i * 40,
            "elapsed_s": t,
            "game_clock_s": 700 - t,
            "shot_clock_s": 20 - t,
            "break_before": False,
            "timestamp_conflict": False,
            "quality_flags": [],
            "source_moment_indices": [i],
            "entities": entities,
        }
    )
bundle = ReplayBundle.model_validate(
    {
        "game_id": "0000000001",
        "segment_id": "sportvu:0000000001:5:0",
        "source_event_id": "5",
        "continuity": "continuous",
        "quality_findings": [],
        "frames": frames,
        "players": [
            {
                "player_id": str(i),
                "team_id": "100" if i <= 5 else "200",
                "name": f"Generated Player {i}",
                "jersey": str(i),
                "position": "G",
            }
            for i in range(1, 11)
        ],
        "events": [
            {
                "game_id": "0000000001",
                "source_game_id": "1",
                "source_event_id": "5",
                "event_id": "nbastats:0000000001:5",
                "period": 1,
                "game_clock_s": 700,
                "event_type": 1,
                "player_id": "1",
                "team_id": "100",
                "description": "Generated analytic event",
                "score": "2 - 0",
            }
        ],
        "provenance": {
            "source_fingerprint": "generated-analytic-fixture",
            "pipeline_version": "fixture-v1",
            "sources": [],
        },
    }
)
fixture = {
    "description": (
        "Generated analytic fixture. Five home players and one opponent move at (3,4) ft/s."
    ),
    "replay": bundle.model_dump(),
    "expected": {
        "left_rim_distance_ft": [float(Decimal(5) + Decimal("0.2") * i) for i in range(6)],
        "nearest_opponent_distance_ft": [5.0] * 6,
        "speed_ft_s": [None, None, None, None, 5.0, 5.0],
        "home_rms_ft": float(Decimal("3.2").sqrt()),
        "right_rim_distance_at_start_ft": float((Decimal("80.5") ** 2 + Decimal(4) ** 2).sqrt()),
    },
}
path = Path("tests/fixtures/m1-constant-motion.json")
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(fixture, indent=2) + "\n")
