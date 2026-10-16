"""Controlled motion and invented annotations for M3 contract/transport tests only."""

import copy
import json
from pathlib import Path

from bkbdata.annotations import AnnotationSet, bind_sequence
from bkbdata.contracts import ReplayBundle

base = json.loads(Path("tests/fixtures/m1-constant-motion.json").read_text())["replay"]
bundles = []
sequences = []
for side, anchor in [("a", 50), ("b", 60)]:
    bundle = copy.deepcopy(base)
    gid = "0000000001" if side == "a" else "0000000002"
    bundle.update(game_id=gid, segment_id=f"generated:{side}", source_event_id="5", events=[])
    bundle["provenance"]["source_fingerprint"] = "generated-m3-motion"
    bundle["frames"] = []
    for i in range(100):
        frame = copy.deepcopy(base["frames"][0])
        frame.update(
            frame_id=f"generated-{side}-{i}",
            source_timestamp_ms=1000000 + (100000 if side == "b" else 0) + i * 40,
            elapsed_s=i * 0.04,
            game_clock_s=700 - i * 0.04,
            source_moment_indices=[i],
            break_before=False,
            timestamp_conflict=False,
        )
        t = i * 0.04
        for entity in frame["entities"]:
            entity["x_ft"] += 3 * t
            entity["y_ft"] += 4 * t
        player = next(e for e in frame["entities"] if e["entity_id"] == "1")
        ball = next(e for e in frame["entities"] if e["kind"] == "ball")
        distance = max(0.8, 8 - 18 * max(0, t - (anchor * 0.04 - 0.4)))
        ball.update(x_ft=player["x_ft"] + distance, y_ft=player["y_ft"], z_ft=4)
        bundle["frames"].append(frame)
    ReplayBundle.model_validate(bundle)

    def fid(i):
        return f"generated-{side}-{i}"

    annotation = dict(
        annotation_id=f"catch-{side}",
        kind="catch",
        label="Generated catch reference",
        confidence="validated",
        basis="synthetic_fixture",
        start_frame_id=fid(anchor - 3),
        anchor_frame_id=fid(anchor),
        end_frame_id=fid(anchor + 1),
        reviewer="Fixture generator; no NBA event",
        reviewed_at="2026-10-15",
        notes=(
            "Invented event in controlled 3-4-5 motion. "
            "This only tests numerical and evaluation plumbing."
        ),
        evidence_uri="fixture:m3-annotated-motion",
    )
    sequences.append(
        dict(
            sequence_id=f"generated-{side}",
            title=f"Generated sequence {side.upper()}",
            game_id=gid,
            segment_id=bundle["segment_id"],
            player_id="1",
            start_frame_id=fid(0),
            end_frame_id=fid(99),
            default_anchor_id=annotation["annotation_id"],
            split="development" if side == "a" else "held_out",
            annotation_coverage="exhaustive_catches",
            annotations=[annotation],
        )
    )
    bundles.append(bundle)
collection = dict(
    schema_version="basketball-annotations-v1",
    collection_id="generated-motion",
    revision=1,
    dataset_kind="synthetic",
    source_fingerprint="generated-m3-motion",
    pipeline_version=bundles[0]["provenance"]["pipeline_version"],
    description="Generated annotations and motion; not NBA records.",
    sequences=sequences,
)
validated = AnnotationSet.model_validate(collection)
index = {
    **collection,
    "sequences": [
        bind_sequence(validated, s, ReplayBundle.model_validate(b))
        for s, b in zip(validated.sequences, bundles, strict=True)
    ],
    "automatic_labels": {
        "available": False,
        "reason": "Generated fixture only; automatic labels unavailable.",
    },
}
Path("tests/fixtures/m3-annotated-motion.json").write_text(
    json.dumps(
        dict(
            collection=collection,
            index=index,
            bundles=bundles,
            truth=dict(
                heading_degrees=53.13010235415598,
                speed_ft_s=5,
                anchor_offset_a_s=2,
                anchor_offset_b_s=2.4,
            ),
        ),
        indent=2,
    )
    + "\n"
)
