"""Offline proximity proposal. Never used to label the application automatically."""

from __future__ import annotations

from bkbdata.annotations import AnnotationSet, bind_sequence
from bkbdata.catalog import Catalog
from bkbdata.contracts import ReplayBundle
from bkbdata.tracking import discontinuity

DEFINITION = {
    "version": "ball-approach-proposal-v1",
    "near_ft": 3,
    "prior_far_ft": 5,
    "max_height_ft": 8,
    "confirmation_observations": 3,
    "history_observations": 6,
    "confirmation_latency_s": 0.08,
    "matching_tolerance_s": 0.20,
    "interpretation": "Planar ball approach, not a validated catch detector; dribbles can qualify.",
}


def candidates(bundle: ReplayBundle, player_id: str, start: int, end: int) -> list[int]:
    distances = []
    roster = {str(p["player_id"]): str(p["team_id"]) for p in bundle.players}
    for index, frame in enumerate(bundle.frames):
        players = [e for e in frame.entities if e.entity_id == player_id]
        balls = [e for e in frame.entities if e.kind == "ball"]
        valid = (
            not frame.timestamp_conflict
            and len(players) == len(balls) == 1
            and players[0].kind == "player"
            and players[0].team_id == roster.get(player_id)
            and balls[0].z_ft is not None
            and 0 <= balls[0].z_ft <= DEFINITION["max_height_ft"]
        )
        distances.append(
            ((players[0].x_ft - balls[0].x_ft) ** 2 + (players[0].y_ft - balls[0].y_ft) ** 2) ** 0.5
            if valid
            else None
        )
    result = []
    for i in range(start + 6, end - 1):
        history = bundle.frames[i - 6 : i + 3]
        if any(
            discontinuity(a.model_dump(), b.model_dump())
            or b.break_before
            or a.timestamp_conflict
            or b.timestamp_conflict
            for a, b in zip(history, history[1:])
        ):
            continue
        before, after = distances[i - 6 : i], distances[i : i + 3]
        if any(d is None for d in before + after):
            continue
        if (
            max(before) >= DEFINITION["prior_far_ft"]
            and max(after) <= DEFINITION["near_ft"]
            and (not result or i - result[-1] > 6)
        ):
            result.append(i)
    return result


def evaluate(collection: AnnotationSet, catalog: Catalog) -> dict:
    reports = []
    tp = fp = fn = 0
    eligible = 0
    bound_frames = {"development": set(), "held_out": set()}
    for sequence in collection.sequences:
        bundle = catalog.replay(sequence.game_id, sequence.segment_id)
        bound = bind_sequence(collection, sequence, bundle)
        refs = {
            (bundle.game_id, frame.frame_id)
            for frame in bundle.frames[bound["start_index"] : bound["end_index"] + 1]
        }
        other = "development" if sequence.split == "held_out" else "held_out"
        if refs & bound_frames[other]:
            raise ValueError(
                "Held-out evaluation cannot share source observations with development"
            )
        bound_frames[sequence.split].update(refs)
        if sequence.split != "held_out":
            continue
        proposed = candidates(bundle, sequence.player_id, bound["start_index"], bound["end_index"])
        labels = [a for a in bound["annotations"] if a["kind"] == "catch"]
        verified = (
            sequence.annotation_coverage == "exhaustive_catches"
            and not any(
                a["kind"] == "uncertain" or a["confidence"] == "uncertain"
                for a in bound["annotations"]
            )
            and all(
                a["confidence"] == "validated" and a["basis"] != "tracking_review" for a in labels
            )
        )
        entry = dict(
            sequence_id=sequence.sequence_id,
            candidates=len(proposed),
            eligible=verified,
            reason=None
            if verified
            else "Incomplete or provisional labels cannot establish TP, FP or FN.",
        )
        if verified:
            eligible += 1
            unmatched = set(range(len(labels)))
            matches = 0
            failures = []
            for i in proposed:
                time = bundle.frames[i].elapsed_s
                compatible = [
                    j
                    for j in unmatched
                    if labels[j]["uncertainty_start_s"] - 0.20
                    <= time
                    <= labels[j]["uncertainty_end_s"] + 0.20
                ]
                if compatible:
                    j = min(compatible, key=lambda j: abs(labels[j]["elapsed_s"] - time))
                    unmatched.remove(j)
                    matches += 1
                else:
                    failures.append(dict(kind="false_positive", frame_id=bundle.frames[i].frame_id))
            failures.extend(
                dict(kind="false_negative", annotation_id=labels[j]["annotation_id"])
                for j in sorted(unmatched)
            )
            entry.update(
                tp=matches, fp=len(proposed) - matches, fn=len(unmatched), failures=failures
            )
            tp += matches
            fp += len(proposed) - matches
            fn += len(unmatched)
        reports.append(entry)
    return dict(
        definition=DEFINITION,
        dataset_kind=collection.dataset_kind,
        collection_id=collection.collection_id,
        revision=collection.revision,
        source_fingerprint=collection.source_fingerprint,
        eligible_held_out_sequences=eligible,
        held_out=reports,
        precision=tp / (tp + fp) if tp + fp else None,
        recall=tp / (tp + fn) if tp + fn else None,
        true_positives=tp if eligible else None,
        false_positives=fp if eligible else None,
        false_negatives=fn if eligible else None,
        status="measured" if eligible else "insufficient_ground_truth",
        automatic_labels_shipped=False,
        limitation=(
            "Tracking-only proximity is not possession truth. "
            "Synthetic metrics, if any, only validate the evaluation harness."
        ),
    )
