import copy
import json
from pathlib import Path

import pytest
from bkbdata.annotations import AnnotationSet, annotation_index, bind_sequence
from bkbdata.api import create_app
from bkbdata.catch_evaluation import candidates, evaluate
from bkbdata.contracts import ReplayBundle
from fastapi.testclient import TestClient

FIXTURE = json.loads(Path("tests/fixtures/m3-annotated-motion.json").read_text())


class GeneratedCatalog:
    def __init__(self, bundles=None):
        self.bundles = [ReplayBundle.model_validate(b) for b in (bundles or FIXTURE["bundles"])]

    def replay(self, gid, sid):
        return next(b for b in self.bundles if b.game_id == gid and b.segment_id == sid)


def test_annotations_roundtrip_and_cross_language_bound_indices(tmp_path):
    collection = AnnotationSet.model_validate(FIXTURE["collection"])
    bound = bind_sequence(collection, collection.sequences[0], GeneratedCatalog().bundles[0])
    assert bound["annotations"][0]["anchor_index"] == 50
    assert bound["annotations"][0]["elapsed_s"] == 2
    assert bound == FIXTURE["index"]["sequences"][0]
    path = tmp_path / "annotations.json"
    path.write_text(collection.model_dump_json())
    index = annotation_index(path, GeneratedCatalog())
    assert [s["status"] for s in index["sequences"]] == ["available", "available"]
    assert index["automatic_labels"]["available"] is False


@pytest.mark.parametrize(
    "mutation",
    [
        "fingerprint",
        "unknown_frame",
        "wrong_window",
        "reversed",
        "outside_clip",
        "conflict",
        "wrong_team",
    ],
)
def test_source_binding_rejects_stale_ambiguous_or_invalid_references(mutation):
    collection = AnnotationSet.model_validate(FIXTURE["collection"])
    sequence = collection.sequences[0]
    bundle = GeneratedCatalog().bundles[0]
    if mutation == "fingerprint":
        collection.source_fingerprint = "stale"
    if mutation == "unknown_frame":
        sequence.start_frame_id = "absent"
    if mutation == "wrong_window":
        sequence.segment_id = "other"
    if mutation == "reversed":
        sequence.start_frame_id, sequence.end_frame_id = (
            sequence.end_frame_id,
            sequence.start_frame_id,
        )
    if mutation == "outside_clip":
        sequence.start_frame_id = bundle.frames[51].frame_id
    if mutation == "wrong_team":
        next(
            e for e in bundle.frames[50].entities if e.entity_id == sequence.player_id
        ).team_id = "bad"
    if mutation == "conflict":
        bundle.frames[50].timestamp_conflict = True
    with pytest.raises(ValueError):
        bind_sequence(collection, sequence, bundle)


def test_provenance_and_split_contracts():
    raw = copy.deepcopy(FIXTURE["collection"])
    raw["dataset_kind"] = "historical"
    with pytest.raises(ValueError, match="synthetic evidence"):
        AnnotationSet.model_validate(raw)
    raw = copy.deepcopy(FIXTURE["collection"])
    raw["sequences"][0]["annotations"][0]["evidence_uri"] = None
    with pytest.raises(ValueError, match="evidence reference"):
        AnnotationSet.model_validate(raw)
    raw = copy.deepcopy(FIXTURE["collection"])
    raw["sequences"][0]["annotations"][0]["basis"] = "tracking_review"
    with pytest.raises(ValueError, match="cannot validate"):
        AnnotationSet.model_validate(raw)
    raw = copy.deepcopy(FIXTURE["collection"])
    raw["sequences"][1]["segment_id"] = raw["sequences"][0]["segment_id"]
    with pytest.raises(ValueError, match="share a source window"):
        AnnotationSet.model_validate(raw)
    raw = copy.deepcopy(FIXTURE["collection"])
    raw["sequences"][1]["sequence_id"] = raw["sequences"][0]["sequence_id"]
    with pytest.raises(ValueError, match="unique"):
        AnnotationSet.model_validate(raw)


def test_all_curated_event_kinds_and_uncertain_state_are_supported():
    for kind in ["catch", "release", "screen", "cut", "relocation", "uncertain"]:
        raw = copy.deepcopy(FIXTURE["collection"])
        a = raw["sequences"][0]["annotations"][0]
        a.update(kind=kind, confidence="uncertain", basis="tracking_review", evidence_uri=None)
        assert AnnotationSet.model_validate(raw).sequences[0].annotations[0].kind == kind


def test_held_out_scoring_and_missing_ground_truth():
    collection = AnnotationSet.model_validate(FIXTURE["collection"])
    catalog = GeneratedCatalog()
    proposed = candidates(catalog.bundles[1], "1", 0, 99)
    assert len(proposed) == 1
    report = evaluate(collection, catalog)
    assert (report["true_positives"], report["false_positives"], report["false_negatives"]) == (
        1,
        0,
        0,
    )
    assert report["precision"] == report["recall"] == 1
    assert report["dataset_kind"] == "synthetic" and not report["automatic_labels_shipped"]
    # A label outside the proposal interval produces both a false positive and a missed event.
    label = collection.sequences[1].annotations[0]
    label.start_frame_id = label.anchor_frame_id = label.end_frame_id = (
        catalog.bundles[1].frames[90].frame_id
    )
    failures = evaluate(collection, catalog)
    assert failures["precision"] == failures["recall"] == 0
    assert {f["kind"] for f in failures["held_out"][0]["failures"]} == {
        "false_positive",
        "false_negative",
    }
    label.confidence = "uncertain"
    insufficient = evaluate(collection, catalog)
    assert insufficient["status"] == "insufficient_ground_truth"
    assert insufficient["precision"] is insufficient["recall"] is None
    assert insufficient["true_positives"] is None
    label.kind = "uncertain"
    assert evaluate(collection, catalog)["status"] == "insufficient_ground_truth"


def test_candidate_excludes_missing_ball_and_timing_breaks():
    bundle = GeneratedCatalog().bundles[1]
    i = candidates(bundle, "1", 0, 99)[0]
    for f in bundle.frames[i - 6 : i + 3]:
        f.entities = [e for e in f.entities if e.kind != "ball"]
    assert candidates(bundle, "1", 0, 99) == []
    bundle = GeneratedCatalog().bundles[1]
    bundle.frames[i].break_before = True
    assert candidates(bundle, "1", 0, 99) == []


def test_api_annotation_endpoint_delegates_read_only_validation(tmp_path, monkeypatch):
    path = tmp_path / "annotations.json"
    path.write_text(json.dumps(FIXTURE["collection"]))
    monkeypatch.setattr(
        "bkbdata.catalog.Catalog.replay", lambda self, gid, sid: GeneratedCatalog().replay(gid, sid)
    )
    client = TestClient(create_app(tmp_path / "sample.duckdb", annotations_path=path))
    response = client.get("/annotations")
    assert response.status_code == 200
    assert response.json()["sequences"][1]["annotations"][0]["anchor_index"] == 60
    raw = copy.deepcopy(FIXTURE["collection"])
    raw["source_fingerprint"] = "changed"
    path.write_text(json.dumps(raw))
    result = client.get("/annotations").json()
    assert all(s["status"] == "unavailable" for s in result["sequences"])
    path.unlink()
    assert client.get("/annotations").status_code == 503


def test_held_out_overlap_is_rejected_across_distinct_event_windows(tmp_path):
    raw = copy.deepcopy(FIXTURE["collection"])
    a = raw["sequences"][0]
    raw["sequences"][1] = {
        **copy.deepcopy(a),
        "sequence_id": "overlapping-heldout",
        "segment_id": "other-window",
        "split": "held_out",
    }
    bundles = copy.deepcopy(FIXTURE["bundles"])
    bundles[1] = copy.deepcopy(bundles[0])
    bundles[1]["segment_id"] = "other-window"
    catalog = GeneratedCatalog(bundles)
    collection = AnnotationSet.model_validate(raw)
    with pytest.raises(ValueError, match="share source observations"):
        evaluate(collection, catalog)
    path = tmp_path / "annotations.json"
    path.write_text(collection.model_dump_json())
    index = annotation_index(path, catalog)
    assert index["sequences"][1]["status"] == "unavailable"
    assert "overlap" in index["sequences"][1]["reason"]
