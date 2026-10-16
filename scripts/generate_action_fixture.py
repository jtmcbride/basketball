"""Controlled path translations/rotation; generated geometry, no NBA records."""

import copy
import json
import math
from pathlib import Path

from bkbdata.actions import DEFINITION, extract_path

motion = json.loads(Path("tests/fixtures/m3-annotated-motion.json").read_text())
bundles = copy.deepcopy(motion["bundles"])
for frame in bundles[1]["frames"]:
    for entity in frame["entities"]:
        entity["x_ft"] += 5
third = copy.deepcopy(bundles[0])
third.update(game_id="0000000003", segment_id="generated:c")
for i, frame in enumerate(third["frames"]):
    frame["frame_id"] = f"generated-c-{i}"
    frame["source_timestamp_ms"] += 200000
    entity = next(e for e in frame["entities"] if e["entity_id"] == "1")
    entity["x_ft"] = 25 - 4 * (i * 0.04)
    entity["y_ft"] = 20 + 3 * (i * 0.04)
for player in third["players"]:
    player["player_id"] = str(int(player["player_id"]) + 10)
    player["name"] = (
        "Generated Rotated Player"
        if player["player_id"] == "11"
        else f"Generated C {player['player_id']}"
    )
for frame in third["frames"]:
    for entity in frame["entities"]:
        if entity["kind"] == "player":
            entity["entity_id"] = str(int(entity["entity_id"]) + 10)
bundles.append(third)
games = [
    dict(
        game_id=b["game_id"],
        players=b["players"],
        game_date="2000-01-01",
        away_team="AWY",
        home_team="HOM",
        away_team_id="200",
        home_team_id="100",
    )
    for b in bundles
]
features = [
    extract_path(
        b["frames"],
        g,
        b["segment_id"],
        "11" if b["game_id"] == "0000000003" else "1",
        50,
        "generated-m3-motion",
    ).model_dump()
    for b, g in zip(bundles, games, strict=True)
]
seeds = []
for i, s in enumerate(motion["collection"]["sequences"]):
    feature = extract_path(
        bundles[i]["frames"],
        games[i],
        s["segment_id"],
        "1",
        50 if i == 0 else 60,
        "generated-m3-motion",
    ).model_dump()
    seeds.append(dict(sequence=s, status="available", reason=None, feature=feature))
options = dict(
    feature_version="basketball-path-v1",
    definition=DEFINITION,
    definition_hash="generated-definition",
    index_fingerprint="generated-index",
    source_fingerprint="generated-m3-motion",
    candidate_count=2,
    games=[dict(game_id=g["game_id"], counts=dict(indexed_paths=1)) for g in games[1:]],
    build_seconds=0,
    seeds=seeds,
    collection=dict(
        id="generated-motion",
        revision=1,
        description="Generated coordinate fixture, not historical tracking.",
    ),
    roster=[
        dict(
            game_id=g["game_id"],
            players=g["players"],
            away_team="AWY",
            home_team="HOM",
            game_date="2000-01-01",
        )
        for g in games
    ],
)
truth = dict(
    translated_shape_rms_ft=0,
    translated_location_rms_ft=5,
    rotated_shape_rms_ft=math.sqrt(
        50 * sum((((i * 100 + 19) // 40) * 0.04) ** 2 for i in range(21)) / 21
    ),
)
Path("tests/fixtures/m4-paths.json").write_text(
    json.dumps(
        dict(
            bundles=bundles,
            games=games,
            features=features,
            options=options,
            collection=motion["collection"],
            truth=truth,
        ),
        indent=2,
    )
    + "\n"
)
