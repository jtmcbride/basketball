"""Offline, repeatable sample ingestion and measured source audit."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
from collections import Counter
from importlib.metadata import version
from pathlib import Path

import duckdb

from bkbdata.acquire import sha256
from bkbdata.contracts import AUDIT_VERSION, PIPELINE_VERSION, Shot, SourceEvent
from bkbdata.joins import coordinate_checks, link_shots, normalize_events, normalize_shots
from bkbdata.sources import read_manifests, read_tracking, selected_csv_rows
from bkbdata.tracking import normalize_tracking

FRAME_COLUMNS = {
    "game_id": "VARCHAR",
    "frame_id": "VARCHAR",
    "period": "INTEGER",
    "source_timestamp_ms": "BIGINT",
    "game_clock_s": "DOUBLE",
    "shot_clock_s": "DOUBLE",
    "timestamp_conflict": "BOOLEAN",
    "quality_flags": "VARCHAR[]",
    "entities": "STRUCT(entity_id VARCHAR, team_id VARCHAR, kind VARCHAR, "
    "x_ft DOUBLE, y_ft DOUBLE, z_ft DOUBLE)[]",
}

SHOT_COLUMNS = {
    **dict.fromkeys(
        (
            "shot_id",
            "game_id",
            "source_game_id",
            "source_event_id",
            "player_id",
            "player_name",
            "team_id",
            "action_type",
        ),
        "VARCHAR",
    ),
    "duplicate_source_key": "BOOLEAN",
    "period": "INTEGER",
    "game_clock_s": "DOUBLE",
    "made": "BOOLEAN",
    "shot_value": "INTEGER",
    "loc_x": "DOUBLE",
    "loc_y": "DOUBLE",
    "lateral_ft": "DOUBLE",
    "forward_ft": "DOUBLE",
    "recorded_distance_ft": "DOUBLE",
    "event_join": "STRUCT(status VARCHAR, method VARCHAR, reason VARCHAR)",
    "tracking_join": "STRUCT(status VARCHAR, method VARCHAR, reason VARCHAR, segment_id VARCHAR, "
    "clock_delta_s DOUBLE, timing_confidence VARCHAR, window_continuity VARCHAR)",
}
EVENT_COLUMNS = {
    **dict.fromkeys(
        (
            "game_id",
            "source_game_id",
            "event_id",
            "source_event_id",
            "player_id",
            "team_id",
            "description",
            "score",
        ),
        "VARCHAR",
    ),
    "period": "INTEGER",
    "game_clock_s": "DOUBLE",
    "event_type": "INTEGER",
}


def _digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def _write_rows(path: Path, rows: list[dict]) -> None:
    with path.open("w") as stream:
        for row in rows:
            stream.write(json.dumps(row, separators=(",", ":")) + "\n")


def build_audit(config: Path, raw: Path, database: Path, lake: Path, report: Path) -> dict:
    manifests = read_manifests(config, raw)
    if (
        len([s for s in manifests if s["kind"] == "shots"]) != 1
        or len([s for s in manifests if s["kind"] == "play_by_play"]) != 1
    ):
        raise ValueError("The sample audit requires one shots and one play-by-play source")
    if not any(source["kind"] == "tracking" for source in manifests):
        raise ValueError("The sample audit requires at least one tracking source")
    source_fingerprint = _digest([{k: s[k] for k in ("id", "url", "sha256")} for s in manifests])
    code = {p.name: sha256(p) for p in Path(__file__).parent.glob("*.py")}
    software = {
        "python": sys.version.split()[0],
        "duckdb": version("duckdb"),
        "py7zr": version("py7zr"),
        "pydantic": version("pydantic"),
    }
    pipeline_fingerprint = _digest(
        {"version": PIPELINE_VERSION, "code": code, "software": software}
    )
    if database.exists() and report.exists():
        existing = json.loads(report.read_text())
        if (
            existing.get("source_fingerprint") == source_fingerprint
            and existing.get("pipeline_fingerprint") == pipeline_fingerprint
        ):
            for artifact in existing["parquet_files"]:
                path = lake / artifact["filename"]
                if not path.exists() or sha256(path) != artifact["sha256"]:
                    raise ValueError(f"Derived Parquet missing or changed: {path}")
            with duckdb.connect(str(database), read_only=True) as db:
                metadata = json.loads(db.execute("SELECT payload FROM metadata").fetchone()[0])
            if (
                metadata["source_fingerprint"] != source_fingerprint
                or metadata["pipeline_fingerprint"] != pipeline_fingerprint
            ):
                raise ValueError("Catalog metadata does not match audit report")
            return {**existing, "cached": True}

    database.parent.mkdir(parents=True, exist_ok=True)
    lake.parent.mkdir(parents=True, exist_ok=True)
    report.parent.mkdir(parents=True, exist_ok=True)
    games, all_segments, all_refs, all_shots, all_events = [], [], [], [], []
    diagnostics, checks = {}, {}
    with tempfile.TemporaryDirectory(prefix="basketball-audit-", dir=lake.parent) as temporary:
        work = Path(temporary)
        for source in manifests:
            if source["kind"] != "tracking":
                continue
            data = read_tracking(raw / source["filename"])
            gid = str(data["gameid"])
            if any(game["game_id"] == gid for game in games):
                raise ValueError(f"Multiple tracking sources for game {gid}; select one explicitly")
            game, segments, refs, tracking = normalize_tracking(data, work / f"frames-{gid}.jsonl")
            del data
            frames = tracking["frames"]
            shots_source = next(s for s in manifests if s["kind"] == "shots")
            pbp_source = next(s for s in manifests if s["kind"] == "play_by_play")
            shots = normalize_shots(selected_csv_rows(raw / shots_source["filename"], {gid}))
            events = normalize_events(selected_csv_rows(raw / pbp_source["filename"], {gid}))
            joins = link_shots(shots, events, segments, frames)
            for shot in shots:
                Shot.model_validate(shot)
            for event in events:
                SourceEvent.model_validate(event)
            checks[gid] = coordinate_checks(shots, segments, frames)
            diagnostics[gid] = tracking["diagnostics"]
            game.update(
                shots=len(shots),
                play_by_play_events=len(events),
                joins=joins,
                tracking_source_id=source["id"],
            )
            game["findings"] = _findings(tracking["diagnostics"])
            game["shot_results"] = dict(Counter("made" if s["made"] else "missed" for s in shots))
            segment_map = {s["segment_id"]: s for s in segments}
            game["examples"] = _examples(shots, segment_map)
            games.append(game)
            all_shots.extend(shots)
            all_events.extend(events)
            # Frame membership is a separate relation, not embedded into each window row.
            all_segments.extend({k: v for k, v in s.items() if k != "frame_ids"} for s in segments)
            all_refs.extend(refs)
            del tracking, frames
        for name, rows in (
            ("shots", all_shots),
            ("events", all_events),
            ("segments", all_segments),
            ("event_frames", all_refs),
            ("games", games),
        ):
            _write_rows(work / f"{name}.jsonl", rows)
        parquet_files = []
        staging_db = work / "catalog.duckdb"
        with duckdb.connect(str(staging_db)) as db:
            db.execute("SET memory_limit='1GB'")
            db.execute("SET threads=2")
            db.read_json(
                [str(p) for p in sorted(work.glob("frames-*.jsonl"))],
                columns=FRAME_COLUMNS,
                format="newline_delimited",
            ).create("frames")
            # Empty shot/PBP archives are valid audit outcomes, with stable table schemas.
            for name in ("games", "shots", "events", "segments", "event_frames"):
                rows = {
                    "games": games,
                    "shots": all_shots,
                    "events": all_events,
                    "segments": all_segments,
                    "event_frames": all_refs,
                }[name]
                if name in {"shots", "events"}:
                    db.read_json(
                        str(work / f"{name}.jsonl"),
                        format="newline_delimited",
                        columns=SHOT_COLUMNS if name == "shots" else EVENT_COLUMNS,
                    ).create(name)
                elif rows:
                    db.read_json(
                        str(work / f"{name}.jsonl"), format="newline_delimited", maximum_depth=-1
                    ).create(name)
                destination = work / f"{name}.parquet"
                db.table(name).write_parquet(str(destination), compression="zstd")
                parquet_files.append(
                    {
                        "filename": destination.name,
                        "sha256": sha256(destination),
                        "rows": db.table(name).count("*").fetchone()[0],
                    }
                )
            destination = work / "frames.parquet"
            db.table("frames").write_parquet(str(destination), compression="zstd")
            parquet_files.append(
                {
                    "filename": destination.name,
                    "sha256": sha256(destination),
                    "rows": db.table("frames").count("*").fetchone()[0],
                }
            )
            db.execute("CREATE INDEX frame_lookup ON frames(frame_id)")
            db.execute("CREATE INDEX membership_lookup ON event_frames(segment_id)")
            summary = {
                "schema_version": AUDIT_VERSION,
                "software": software,
                "pipeline_version": PIPELINE_VERSION,
                "source_fingerprint": source_fingerprint,
                "pipeline_fingerprint": pipeline_fingerprint,
                "sources": manifests,
                "games": games,
                "diagnostics": diagnostics,
                "coordinate_checks": checks,
                "parquet_files": parquet_files,
                "thresholds": {
                    "nominal_frame_interval_ms": 40,
                    "cadence_tolerance_ms": 5,
                    "event_clock_tolerance_s": 1,
                    "court_margin_ft": 2,
                },
                "boundaries": {
                    "segment_kind": "source_event_window",
                    "possessions_reconstructed": False,
                    "attacking_direction": "unavailable",
                    "shot_release_timing": "unavailable",
                    "redistribution": "not_established",
                },
            }
            db.execute("CREATE TABLE metadata(payload JSON)")
            db.execute("INSERT INTO metadata VALUES (?)", [json.dumps(summary)])
        lake.mkdir(parents=True, exist_ok=True)
        for artifact in parquet_files:
            shutil.move(str(work / artifact["filename"]), lake / artifact["filename"])
        os.replace(staging_db, database)
        report_tmp = report.with_suffix(".tmp")
        report_tmp.write_text(json.dumps(summary, indent=2) + "\n")
        os.replace(report_tmp, report)
    return {**summary, "cached": False}


def _findings(diagnostics: dict) -> list[dict]:
    descriptions = {
        "malformed_moments": "Malformed source moments excluded; affected windows are partial.",
        "player_count_not_ten": "Observed frame has other than ten players.",
        "team_count_not_five": "Observed frame does not have five players from each team.",
        "ball_count_not_one": "Observed frame does not have exactly one ball.",
        "duplicate_entity_ids": "An entity appears more than once in an observed frame.",
        "roster_mismatch": "Observed player/team identity disagrees with source roster.",
        "outside_court": "At least one entity is outside court lines; may include ordinary play.",
        "outside_court_margin": "At least one entity is over two feet beyond court lines.",
        "timestamp_conflict_keys": "Different observations share period and source timestamp.",
        "game_clock_out_of_range": "Game clock exceeds the period's nominal duration.",
        "shot_clock_out_of_range": "Shot clock is outside 0–24.1 seconds.",
        "ball_height_out_of_range": "Recorded ball height is outside -1–50 feet.",
        "missing_shot_clock": "Source shot clock is unavailable.",
    }
    return [
        {
            "code": code,
            "count": diagnostics["counts"].get(code, 0),
            "severity": "warning",
            "description": description,
        }
        for code, description in descriptions.items()
        if diagnostics["counts"].get(code, 0)
    ]


def _examples(shots: list[dict], segments: dict) -> list[dict]:
    examples, selected = [], set()
    for made, continuity in (
        (True, "continuous"),
        (False, "continuous"),
        (True, "partial"),
        (False, "partial"),
    ):
        shot = next(
            (
                s
                for s in shots
                if s["made"] == made
                and s["tracking_join"]["status"] == "matched"
                and segments[s["tracking_join"]["segment_id"]]["continuity"] == continuity
                and s["shot_id"] not in selected
            ),
            None,
        )
        if shot:
            selected.add(shot["shot_id"])
            examples.append(
                {
                    "shot_id": shot["shot_id"],
                    "player": shot["player_name"],
                    "made": shot["made"],
                    "period": shot["period"],
                    "game_clock_s": shot["game_clock_s"],
                    "continuity": continuity,
                    "segment_id": shot["tracking_join"]["segment_id"],
                }
            )
    unavailable = next((s for s in shots if s["tracking_join"]["status"] != "matched"), None)
    if unavailable:
        examples.append(
            {
                "shot_id": unavailable["shot_id"],
                "player": unavailable["player_name"],
                "tracking_join": unavailable["tracking_join"],
            }
        )
    return examples
