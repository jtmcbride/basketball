"""Regenerate reviewable JSON schemas from the Python boundary models."""

import json
from pathlib import Path

from bkbdata.annotations import AnnotationSet
from bkbdata.contracts import ReplayBundle, Shot, SourceEvent

for model, filename in (
    (ReplayBundle, "replay-v1"),
    (AnnotationSet, "annotations-v1"),
    (Shot, "shot-v1"),
    (SourceEvent, "source-event-v1"),
):
    output = Path("schemas") / f"{filename}.schema.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(model.model_json_schema(), indent=2) + "\n")
