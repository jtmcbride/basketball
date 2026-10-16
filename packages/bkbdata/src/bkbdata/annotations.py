"""Versioned curation, source binding, and conservative annotation availability."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator

from bkbdata.catalog import Catalog
from bkbdata.contracts import Contract, ReplayBundle

ANNOTATION_VERSION = "basketball-annotations-v1"


class Annotation(Contract):
    annotation_id: str = Field(min_length=1)
    kind: Literal["catch", "release", "screen", "cut", "relocation", "uncertain"]
    label: str = Field(min_length=1)
    confidence: Literal["uncertain", "supported", "validated"]
    basis: Literal["tracking_review", "video_review", "source_annotation", "synthetic_fixture"]
    start_frame_id: str
    anchor_frame_id: str
    end_frame_id: str
    reviewer: str = Field(min_length=1)
    reviewed_at: str = Field(min_length=1)
    notes: str = Field(min_length=1)
    evidence_uri: str | None = None

    @model_validator(mode="after")
    def evidence_boundary(self):
        if self.confidence == "validated" and not self.evidence_uri:
            raise ValueError("Validated labels need an inspectable evidence reference")
        if self.basis == "tracking_review" and self.kind in {"catch", "release", "screen"}:
            if self.confidence != "uncertain":
                raise ValueError(
                    "Tracking geometry alone cannot validate catches, releases or screens"
                )
        return self


class Sequence(Contract):
    sequence_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    game_id: str = Field(pattern=r"^\d{10}$")
    segment_id: str
    player_id: str
    start_frame_id: str
    end_frame_id: str
    default_anchor_id: str
    split: Literal["development", "held_out"]
    annotation_coverage: Literal["partial", "exhaustive_catches"] = "partial"
    annotations: list[Annotation] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_annotations(self):
        ids = [a.annotation_id for a in self.annotations]
        if len(ids) != len(set(ids)) or self.default_anchor_id not in ids:
            raise ValueError("Annotation IDs must be unique and include the default anchor")
        return self


class AnnotationSet(Contract):
    schema_version: Literal["basketball-annotations-v1"] = ANNOTATION_VERSION
    collection_id: str
    revision: int = Field(ge=1)
    dataset_kind: Literal["historical", "synthetic"]
    source_fingerprint: str
    pipeline_version: str
    description: str
    sequences: list[Sequence] = Field(min_length=1)

    @model_validator(mode="after")
    def collection_boundaries(self):
        ids = [s.sequence_id for s in self.sequences]
        if len(ids) != len(set(ids)):
            raise ValueError("Sequence IDs must be unique")
        if self.dataset_kind == "historical" and any(
            a.basis == "synthetic_fixture" for s in self.sequences for a in s.annotations
        ):
            raise ValueError("Historical collections cannot contain synthetic evidence")
        # Disjoint source windows are required; frame-overlap validation also runs at binding.
        development = {s.segment_id for s in self.sequences if s.split == "development"}
        held_out = {s.segment_id for s in self.sequences if s.split == "held_out"}
        if development & held_out:
            raise ValueError("Development and held-out sequences cannot share a source window")
        return self


def bind_sequence(collection: AnnotationSet, sequence: Sequence, bundle: ReplayBundle) -> dict:
    if (
        collection.source_fingerprint != bundle.provenance.source_fingerprint
        or collection.pipeline_version != bundle.provenance.pipeline_version
    ):
        raise ValueError("Annotation source fingerprint or pipeline version is stale")
    if sequence.game_id != bundle.game_id or sequence.segment_id != bundle.segment_id:
        raise ValueError("Annotation source window does not match replay")
    if sequence.player_id not in {str(p["player_id"]) for p in bundle.players}:
        raise ValueError("Annotated player is not in the source roster")
    indices = {frame.frame_id: i for i, frame in enumerate(bundle.frames)}

    def index(frame_id):
        if frame_id not in indices:
            raise ValueError(f"Annotation references an unavailable frame: {frame_id}")
        return indices[frame_id]

    start, end = index(sequence.start_frame_id), index(sequence.end_frame_id)
    if start > end:
        raise ValueError("Sequence start must precede its end")
    annotations = []
    for annotation in sequence.annotations:
        low, anchor, high = map(
            index, (annotation.start_frame_id, annotation.anchor_frame_id, annotation.end_frame_id)
        )
        if not start <= low <= anchor <= high <= end:
            raise ValueError(
                "Annotation uncertainty interval must contain its anchor within sequence"
            )
        frame = bundle.frames[anchor]
        player = [e for e in frame.entities if e.entity_id == sequence.player_id]
        team = next(
            str(p["team_id"]) for p in bundle.players if str(p["player_id"]) == sequence.player_id
        )
        if (
            frame.timestamp_conflict
            or len(player) != 1
            or player[0].kind != "player"
            or player[0].team_id != team
        ):
            raise ValueError("Annotation anchor requires one unambiguous observed player")
        annotations.append(
            {
                **annotation.model_dump(),
                "start_index": low,
                "anchor_index": anchor,
                "end_index": high,
                "elapsed_s": frame.elapsed_s,
                "uncertainty_start_s": bundle.frames[low].elapsed_s,
                "uncertainty_end_s": bundle.frames[high].elapsed_s,
            }
        )
    return {
        **sequence.model_dump(),
        "start_index": start,
        "end_index": end,
        "annotations": annotations,
        "status": "available",
        "reason": None,
    }


def annotation_index(path: Path, catalog: Catalog) -> dict:
    collection = AnnotationSet.model_validate_json(path.read_text())
    sequences = []
    loaded = {}
    split_frames = {"development": set(), "held_out": set()}
    for sequence in collection.sequences:
        try:
            key = sequence.game_id, sequence.segment_id
            if key not in loaded:
                loaded[key] = catalog.replay(*key)
            bundle = loaded[key]
            bound = bind_sequence(collection, sequence, bundle)
            refs = {
                (bundle.game_id, f.frame_id)
                for f in bundle.frames[bound["start_index"] : bound["end_index"] + 1]
            }
            other = "held_out" if sequence.split == "development" else "development"
            if refs & split_frames[other]:
                raise ValueError("Development/held-out source frames overlap across event windows")
            split_frames[sequence.split].update(refs)
            sequences.append(bound)
        except (KeyError, ValueError) as error:
            sequences.append(
                {**sequence.model_dump(), "status": "unavailable", "reason": str(error)}
            )
    return {
        **collection.model_dump(exclude={"sequences"}),
        "sequences": sequences,
        "automatic_labels": {
            "available": False,
            "reason": "Provisional tracking reviews do not establish held-out catch ground truth.",
        },
    }
