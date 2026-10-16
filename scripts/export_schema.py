"""Regenerate reviewable JSON schemas from the Python boundary models."""

import json
from pathlib import Path

from bkbdata.actions import DEFINITION, PathFeature
from bkbdata.annotations import AnnotationSet
from bkbdata.contracts import ReplayBundle, Shot, SourceEvent
from bkbdata.lineups import DEFINITION as LINEUP_DEFINITION
from bkbdata.lineups import LineupGame
from bkbdata.shot_model import DEFINITION as MODEL_DEFINITION

for model, filename in (
    (ReplayBundle, "replay-v1"),
    (PathFeature, "path-feature-v1"),
    (LineupGame, "lineups-v1"),
    (AnnotationSet, "annotations-v1"),
    (Shot, "shot-v1"),
    (SourceEvent, "source-event-v1"),
):
    output = Path("schemas") / f"{filename}.schema.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(model.model_json_schema(), indent=2) + "\n")

Path("config/path-similarity-v1.json").write_text(json.dumps(DEFINITION, indent=2) + "\n")
Path("config/lineups-v1.json").write_text(json.dumps(LINEUP_DEFINITION, indent=2) + "\n")
Path("config/location-model-v1.json").write_text(json.dumps(MODEL_DEFINITION, indent=2) + "\n")
