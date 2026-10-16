"""Independent source-timestamp, distance and uncentered heading checks for M3."""

import json
import math
from pathlib import Path

from bkbdata.annotations import AnnotationSet, bind_sequence
from bkbdata.catalog import Catalog

catalog = Catalog(Path("data/db/basketball.duckdb"))
collection = AnnotationSet.model_validate_json(Path("annotations/curated-v1.json").read_text())
checks = []
for sequence in collection.sequences:
    bundle = catalog.replay(sequence.game_id, sequence.segment_id)
    bound = bind_sequence(collection, sequence, bundle)
    indices = range(bound["start_index"], bound["end_index"] + 1)
    roster = {p["player_id"]: p["team_id"] for p in bundle.players}
    annotation = next(
        a for a in bound["annotations"] if a["annotation_id"] == sequence.default_anchor_id
    )
    anchor = bundle.frames[annotation["anchor_index"]].source_timestamp_ms

    def entity_at(index, identity):
        frame = bundle.frames[index]
        rows = [e for e in frame.entities if e.entity_id == identity]
        if frame.timestamp_conflict or len(rows) != 1:
            return None
        entity = rows[0]
        return entity if identity == "ball" or roster.get(identity) == entity.team_id else None

    def broken(i):
        a, b = bundle.frames[i - 1 : i + 1]
        return (
            b.break_before
            or a.timestamp_conflict
            or b.timestamp_conflict
            or a.period != b.period
            or abs(b.source_timestamp_ms - a.source_timestamp_ms - 40) > 5
            or b.game_clock_s > a.game_clock_s + 0.1
        )

    for player in [
        sequence.player_id,
        next(
            e.entity_id
            for e in bundle.frames[annotation["anchor_index"]].entities
            if e.kind == "player" and e.entity_id != sequence.player_id
        ),
    ]:
        for cursor in [-2000, -1000, -500, 0, 19, 39, 500, 1000, 1500]:
            eligible = [
                i for i in indices if bundle.frames[i].source_timestamp_ms - anchor <= cursor
            ]
            index = eligible[-1] if eligible else None
            if index is not None and (
                cursor > bundle.frames[bound["end_index"]].source_timestamp_ms - anchor
                or cursor - (bundle.frames[index].source_timestamp_ms - anchor) >= 45
            ):
                index = None
            values = dict(opponent=None, ball=None, heading=None)
            if index is not None:
                p, ball = entity_at(index, player), entity_at(index, "ball")
                if p:
                    opponents = [
                        entity_at(index, pid) for pid, team in roster.items() if team != p.team_id
                    ]
                    opponents = [e for e in opponents if e]
                    if len(opponents) == 5:
                        values["opponent"] = min(
                            math.dist((p.x_ft, p.y_ft), (e.x_ft, e.y_ft)) for e in opponents
                        )
                    if ball:
                        values["ball"] = math.dist((p.x_ft, p.y_ft), (ball.x_ft, ball.y_ft))
                    if index - bound["start_index"] >= 4:
                        history = [entity_at(i, player) for i in range(index - 4, index + 1)]
                        if all(history) and not any(broken(i) for i in range(index - 3, index + 1)):
                            times = [
                                (
                                    bundle.frames[i].source_timestamp_ms
                                    - bundle.frames[index].source_timestamp_ms
                                )
                                / 1000
                                for i in range(index - 4, index + 1)
                            ]
                            denominator = 5 * sum(t * t for t in times) - sum(times) ** 2
                            vx = (
                                5 * sum(t * e.x_ft for t, e in zip(times, history, strict=True))
                                - sum(times) * sum(e.x_ft for e in history)
                            ) / denominator
                            vy = (
                                5 * sum(t * e.y_ft for t, e in zip(times, history, strict=True))
                                - sum(times) * sum(e.y_ft for e in history)
                            ) / denominator
                            if math.hypot(vx, vy) >= 1:
                                values["heading"] = math.degrees(math.atan2(vy, vx))
            checks.append(
                dict(
                    sequence_id=sequence.sequence_id,
                    player_id=player,
                    time_ms=cursor,
                    index=index,
                    expected=values,
                )
            )
result = dict(
    source_fingerprint=collection.source_fingerprint,
    annotation_revision=collection.revision,
    checks=checks,
)
Path("data/exports/m3-reference.json").write_text(json.dumps(result, indent=2) + "\n")
print(
    json.dumps(dict(reference_cases=len(checks), source_fingerprint=collection.source_fingerprint))
)
