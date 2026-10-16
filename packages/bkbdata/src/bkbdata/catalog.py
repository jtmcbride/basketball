"""Read-only access to the local audit catalog and replay boundary."""

from __future__ import annotations

import json
from pathlib import Path

import duckdb

from bkbdata.contracts import PIPELINE_VERSION, Provenance, ReplayBundle
from bkbdata.tracking import discontinuity


class Catalog:
    def __init__(self, database: Path):
        self.database = database

    def _rows(self, query: str, params: list | None = None) -> list[dict]:
        if not self.database.is_file():
            raise FileNotFoundError("No local catalog. Run make fetch and make audit first.")
        with duckdb.connect(str(self.database), read_only=True) as db:
            return [json.loads(row[0]) for row in db.execute(query, params or []).fetchall()]

    def health(self) -> dict:
        return self._rows("SELECT payload FROM metadata")[0]

    def games(self) -> list[dict]:
        return self._rows("SELECT to_json(g) FROM games g ORDER BY game_id")

    def game(self, game_id: str) -> dict:
        games = self._rows("SELECT to_json(g) FROM games g WHERE game_id = ?", [game_id])
        if not games:
            raise KeyError("Game not found")
        return games[0]

    def shots(self, game_id: str) -> list[dict]:
        self.game(game_id)
        return self._rows(
            "SELECT to_json(s) FROM shots s WHERE game_id = ? "
            "ORDER BY period, game_clock_s DESC, shot_id",
            [game_id],
        )

    def segments(self, game_id: str) -> list[dict]:
        self.game(game_id)
        return self._rows(
            "SELECT to_json(s) FROM segments s WHERE game_id = ? ORDER BY source_index", [game_id]
        )

    def replay(self, game_id: str, segment_id: str) -> ReplayBundle:
        game = self.game(game_id)
        segments = self._rows(
            "SELECT to_json(s) FROM segments s WHERE game_id = ? AND segment_id = ?",
            [game_id, segment_id],
        )
        if len(segments) != 1 or segments[0]["frame_count"] == 0:
            raise KeyError("Observed tracking window not found")
        segment = segments[0]
        frames = self._rows(
            "SELECT to_json(f) FROM frames f WHERE game_id = ? AND frame_id IN "
            "(SELECT frame_id FROM event_frames WHERE segment_id = ? AND game_id = ?) "
            "ORDER BY source_timestamp_ms, period, frame_id",
            [game_id, segment_id, game_id],
        )
        origin = frames[0]["source_timestamp_ms"]
        membership = self._rows(
            "SELECT to_json(e) FROM event_frames e WHERE game_id = ? AND segment_id = ? "
            "ORDER BY moment_index",
            [game_id, segment_id],
        )
        indices: dict[str, list[int]] = {}
        for reference in membership:
            indices.setdefault(reference["frame_id"], []).append(reference["moment_index"])
        bundle_frames = []
        for index, frame in enumerate(frames):
            bundle_frames.append(
                {
                    **{k: v for k, v in frame.items() if k != "game_id"},
                    "elapsed_s": (frame["source_timestamp_ms"] - origin) / 1000,
                    "source_moment_indices": indices[frame["frame_id"]],
                    "break_before": index > 0
                    and (
                        discontinuity(frames[index - 1], frame)
                        or frame["timestamp_conflict"]
                        or frames[index - 1]["timestamp_conflict"]
                    ),
                }
            )
        metadata = self.health()
        # Event clocks are context, not frame or release annotations. The client
        # exposes their +/-1 second candidate intervals and ambiguous mappings.
        events = self._rows(
            "SELECT to_json(e) FROM events e WHERE game_id = ? ORDER BY period, "
            "game_clock_s DESC, event_id",
            [game_id],
        )
        clock_ranges: dict[int, tuple[float, float]] = {}
        for frame in frames:
            low, high = clock_ranges.get(frame["period"], (float("inf"), float("-inf")))
            clock_ranges[frame["period"]] = (
                min(low, frame["game_clock_s"]),
                max(high, frame["game_clock_s"]),
            )
        context = [
            event
            for event in events
            if event["period"] in clock_ranges
            and clock_ranges[event["period"]][0] - 1
            <= event["game_clock_s"]
            <= clock_ranges[event["period"]][1] + 1
        ]
        return ReplayBundle(
            game_id=game_id,
            segment_id=segment_id,
            source_event_id=segment["source_event_id"],
            continuity=segment["continuity"],
            quality_findings=[
                {
                    "code": code,
                    "count": segment[key],
                    "severity": "warning",
                    "description": description,
                }
                for code, key, description in (
                    ("discontinuities", "discontinuities", "Source timing discontinuities."),
                    (
                        "entity_problems",
                        "entity_problem_frames",
                        "Incomplete or invalid identities.",
                    ),
                    ("conflicts", "conflict_frames", "Conflicting source timestamp observations."),
                    ("malformed", "malformed_moments", "Malformed source moments excluded."),
                    ("invalid_clock", "invalid_clock_frames", "Invalid source game clocks."),
                )
                if segment[key]
            ],
            frames=bundle_frames,
            players=game["players"],
            events=context,
            provenance=Provenance(
                source_fingerprint=metadata["source_fingerprint"],
                pipeline_version=PIPELINE_VERSION,
                sources=metadata["sources"],
            ),
        )
