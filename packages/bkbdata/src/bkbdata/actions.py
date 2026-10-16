"""Single-player geometric retrieval. No outcomes, events, roles, or future frames score."""

from __future__ import annotations

import bisect
import hashlib
import json
import math
import os
import platform
import resource
import tempfile
import time
from collections import Counter
from pathlib import Path
from typing import Literal

import duckdb
from pydantic import Field, model_validator

from bkbdata.acquire import sha256
from bkbdata.annotations import AnnotationSet, bind_sequence
from bkbdata.catalog import Catalog
from bkbdata.contracts import Contract
from bkbdata.tracking import discontinuity

FEATURE_VERSION = "basketball-path-v1"
DEFINITION = {
    "version": FEATURE_VERSION,
    "duration_ms": 2000,
    "sampling_interval_ms": 100,
    "sample_count": 21,
    "sampling": (
        "Nearest recorded observation, ties choose earlier, maximum 20 ms error; no interpolation"
    ),
    "time_basis": (
        "source_timestamp_ms; sample targets run backward from the declared observed endpoint"
    ),
    "coordinates": (
        "SportVU source court feet; no rotation, reflection, direction "
        "normalization or scale change"
    ),
    "profiles": {
        "start_relative": (
            "Subtract each path's first sampled x/y; preserve source-axis orientation"
        ),
        "court_location": "Retain original source-court x/y coordinates",
    },
    "metric": "sqrt(mean((query_x-candidate_x)^2+(query_y-candidate_y)^2)), in feet",
    "duration_treatment": (
        "Fixed nominal 2 s, actual endpoint span within 20 ms; no temporal rescaling or warping"
    ),
    "candidates": (
        "Observed endpoints nearest an absolute 2 s timestamp grid within source "
        "event windows; deduplicate identical sampled player paths across overlaps"
    ),
    "quality": (
        "All intervening selected-player observations must be unique, "
        "roster/team-consistent, finite and within court; no timing/period/clock "
        "breaks or timestamp conflicts"
    ),
    "query": (
        "Ends at selected annotation reference or indexed path endpoint; only "
        "observations at/before that endpoint; curated queries stay within curated "
        "clip bounds"
    ),
    "retrieval_exclusions": (
        "Exclude all-player candidate intervals overlapping query footage in the "
        "same game, then suppress overlapping returned footage; stable ID breaks "
        "score ties"
    ),
    "not_features": [
        "shot outcome",
        "future observations",
        "ball",
        "opponents",
        "player identity",
        "annotations",
        "play call",
        "assignments",
    ],
}
DEFINITION_HASH = hashlib.sha256(json.dumps(DEFINITION, sort_keys=True).encode()).hexdigest()


class PathFeature(Contract):
    feature_version: Literal["basketball-path-v1"] = FEATURE_VERSION
    candidate_id: str = Field(pattern=r"^path:[a-f0-9]{24}$")
    source_fingerprint: str
    game_id: str
    segment_id: str
    player_id: str
    player_name: str
    team_id: str
    period: int
    start_clock_s: float
    end_clock_s: float
    start_ms: int
    end_ms: int
    actual_duration_ms: int
    observed_frames: int = Field(ge=45, le=59)
    frame_ids: list[str] = Field(min_length=21, max_length=21)
    timestamps_ms: list[int] = Field(min_length=21, max_length=21)
    offsets_ms: list[int] = Field(min_length=21, max_length=21)
    x_ft: list[float] = Field(min_length=21, max_length=21)
    y_ft: list[float] = Field(min_length=21, max_length=21)

    @model_validator(mode="after")
    def time_contract(self):
        if (
            self.start_ms != self.timestamps_ms[0]
            or self.end_ms != self.timestamps_ms[-1]
            or self.actual_duration_ms != self.end_ms - self.start_ms
            or abs(self.actual_duration_ms - 2000) > 20
        ):
            raise ValueError("Path endpoints must preserve recorded duration within 20 ms")
        if len(set(self.frame_ids)) != 21 or any(
            a >= b for a, b in zip(self.timestamps_ms, self.timestamps_ms[1:])
        ):
            raise ValueError("Feature samples require distinct ordered source observations")
        if any(
            abs(offset) > 20 or timestamp != self.end_ms - 2000 + i * 100 + offset
            for i, (timestamp, offset) in enumerate(
                zip(self.timestamps_ms, self.offsets_ms, strict=True)
            )
        ):
            raise ValueError("Feature timing offsets disagree with the fixed sample grid")
        if any(
            not 0 <= x <= 94 or not 0 <= y <= 50 for x, y in zip(self.x_ft, self.y_ft, strict=True)
        ):
            raise ValueError("Selected-player path extends outside the source court")
        if self.candidate_id != feature_id(self.model_dump()):
            raise ValueError("Feature ID does not match the sampled geometry and provenance")
        return self


def feature_id(values: dict) -> str:
    keys = [
        "feature_version",
        "source_fingerprint",
        "game_id",
        "player_id",
        "frame_ids",
        "timestamps_ms",
        "x_ft",
        "y_ft",
    ]
    identity = {key: values[key] for key in keys}
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode())
    return f"path:{digest.hexdigest()[:24]}"


def nearest_index(times: list[int], target: int, low: int, high: int) -> int:
    insertion = bisect.bisect_left(times, target, low, high + 1)
    candidates = [i for i in (insertion - 1, insertion) if low <= i <= high]
    return min(candidates, key=lambda i: (abs(times[i] - target), times[i]))


def extract_path(
    frames: list[dict],
    game: dict,
    segment_id: str,
    player_id: str,
    end: int,
    source_fingerprint: str,
    low: int = 0,
    times: list[int] | None = None,
) -> PathFeature:
    roster = {p["player_id"]: p for p in game["players"]}
    if player_id not in roster:
        raise ValueError("Selected player is not in this source roster")
    times = times or [f["source_timestamp_ms"] for f in frames]
    end_ms = times[end]
    samples = [nearest_index(times, end_ms - 2000 + i * 100, low, end) for i in range(21)]
    offsets = [times[index] - (end_ms - 2000 + i * 100) for i, index in enumerate(samples)]
    if any(abs(offset) > 20 for offset in offsets):
        raise ValueError("Needs two seconds of observed history within the declared window")
    start = samples[0]
    positions = {}
    for i in range(start, end + 1):
        f = frames[i]
        if f["timestamp_conflict"]:
            raise ValueError("Conflicting source timestamp inside path")
        if "game_clock_out_of_range" in f["quality_flags"]:
            raise ValueError("Invalid source game clock inside path")
        if i > start and (f.get("break_before", False) or discontinuity(frames[i - 1], f)):
            raise ValueError("Timing, period or clock break inside path")
        entities = [e for e in f["entities"] if e["entity_id"] == player_id]
        if (
            len(entities) != 1
            or entities[0]["kind"] != "player"
            or entities[0]["team_id"] != roster[player_id]["team_id"]
        ):
            raise ValueError("Missing, duplicate or roster-inconsistent selected player")
        e = entities[0]
        x, y = e["x_ft"], e["y_ft"]
        if not math.isfinite(x + y) or not (0 <= x <= 94 and 0 <= y <= 50):
            raise ValueError("Selected-player position is invalid or outside court")
        positions[i] = (float(x), float(y))
    values = dict(
        feature_version=FEATURE_VERSION,
        source_fingerprint=source_fingerprint,
        game_id=game["game_id"],
        player_id=player_id,
        frame_ids=[frames[i]["frame_id"] for i in samples],
        timestamps_ms=[times[i] for i in samples],
        x_ft=[positions[i][0] for i in samples],
        y_ft=[positions[i][1] for i in samples],
    )
    return PathFeature(
        **values,
        candidate_id=feature_id(values),
        segment_id=segment_id,
        player_name=roster[player_id]["name"],
        team_id=roster[player_id]["team_id"],
        period=frames[start]["period"],
        start_clock_s=frames[start]["game_clock_s"],
        end_clock_s=frames[end]["game_clock_s"],
        start_ms=times[start],
        end_ms=end_ms,
        actual_duration_ms=end_ms - times[start],
        observed_frames=end - start + 1,
        offsets_ms=offsets,
    )


def query_path(
    source: Catalog,
    annotations_path: Path,
    seed_id: str,
    annotation_id: str | None,
    player_id: str | None,
) -> PathFeature:
    collection = AnnotationSet.model_validate_json(annotations_path.read_text())
    sequence = next((s for s in collection.sequences if s.sequence_id == seed_id), None)
    if sequence is None:
        raise KeyError("Curated query sequence not found")
    bundle = source.replay(sequence.game_id, sequence.segment_id)
    bound = bind_sequence(collection, sequence, bundle)
    anchor = next(
        (
            a
            for a in bound["annotations"]
            if a["annotation_id"] == (annotation_id or sequence.default_anchor_id)
        ),
        None,
    )
    if anchor is None:
        raise KeyError("Query annotation reference not found")
    return extract_path(
        [f.model_dump() for f in bundle.frames],
        source.game(sequence.game_id),
        sequence.segment_id,
        player_id or sequence.player_id,
        anchor["anchor_index"],
        collection.source_fingerprint,
        bound["start_index"],
    )


_COLUMNS = {
    "candidate_id": "VARCHAR",
    "feature_version": "VARCHAR",
    "source_fingerprint": "VARCHAR",
    "game_id": "VARCHAR",
    "segment_id": "VARCHAR",
    "player_id": "VARCHAR",
    "player_name": "VARCHAR",
    "team_id": "VARCHAR",
    "period": "INTEGER",
    "start_clock_s": "DOUBLE",
    "end_clock_s": "DOUBLE",
    "start_ms": "BIGINT",
    "end_ms": "BIGINT",
    "actual_duration_ms": "INTEGER",
    "observed_frames": "INTEGER",
    "frame_ids": "VARCHAR[]",
    "timestamps_ms": "BIGINT[]",
    "offsets_ms": "INTEGER[]",
    "x_ft": "DOUBLE[]",
    "y_ft": "DOUBLE[]",
}


def build_actions(source_database: Path, database: Path, lake: Path) -> dict:
    started = time.perf_counter()
    source = Catalog(source_database)
    health = source.health()
    identity = dict(
        source_database_sha256=sha256(source_database),
        definition_hash=DEFINITION_HASH,
        adapter_sha256=sha256(Path(__file__)),
        python=platform.python_version(),
        duckdb=duckdb.__version__,
    )
    fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    lake.mkdir(parents=True, exist_ok=True)
    database.parent.mkdir(parents=True, exist_ok=True)
    parquet = lake / "paths.parquet"
    checkpoint = lake / "index.json"
    if database.exists() and parquet.exists() and checkpoint.exists():
        try:
            saved = json.loads(checkpoint.read_text())
        except json.JSONDecodeError:
            saved = {}
        if (
            saved.get("index_fingerprint") == fingerprint
            and saved.get("parquet_sha256") == sha256(parquet)
            and saved.get("database_sha256") == sha256(database)
        ):
            return {**saved, "cached": True}
    games = source.games()
    reports = []
    seen = set()
    with tempfile.TemporaryDirectory() as temporary:
        rows_path = Path(temporary) / "paths.jsonl"
        with (
            rows_path.open("w") as output,
            duckdb.connect(str(source_database), read_only=True) as con,
        ):
            for game in games:
                counts = Counter()
                # Load one game's canonical observations once; source windows share these objects.
                cursor = con.execute(
                    "SELECT frame_id,source_timestamp_ms,period,game_clock_s,"
                    "timestamp_conflict,quality_flags,entities FROM frames WHERE game_id=?",
                    [game["game_id"]],
                )
                names = [c[0] for c in cursor.description]
                frames = {row[0]: dict(zip(names, row, strict=True)) for row in cursor.fetchall()}
                membership = {
                    r[0]: r[1]
                    for r in con.execute(
                        "SELECT segment_id,list(DISTINCT frame_id) FROM event_frames "
                        "WHERE game_id=? GROUP BY segment_id",
                        [game["game_id"]],
                    ).fetchall()
                }
                segments = source.segments(game["game_id"])
                for segment in segments:
                    counts["source_windows"] += 1
                    window = sorted(
                        (frames[fid] for fid in membership.get(segment["segment_id"], [])),
                        key=lambda f: (f["source_timestamp_ms"], f["period"], f["frame_id"]),
                    )
                    if not window:
                        continue
                    times = [f["source_timestamp_ms"] for f in window]
                    # Endpoints on the absolute grid, nearest observed endpoint, earlier wins ties.
                    for target in range(
                        ((times[0] + 2000 + 1999) // 2000) * 2000, times[-1] + 21, 2000
                    ):
                        end = nearest_index(times, target, 0, len(times) - 1)
                        if abs(times[end] - target) > 20:
                            continue
                        for player in game["players"]:
                            counts["attempted_paths"] += 1
                            try:
                                feature = extract_path(
                                    window,
                                    game,
                                    segment["segment_id"],
                                    player["player_id"],
                                    end,
                                    health["source_fingerprint"],
                                    times=times,
                                )
                            except ValueError as error:
                                counts[str(error)] += 1
                                continue
                            if feature.candidate_id in seen:
                                counts["duplicate_paths_removed"] += 1
                                continue
                            seen.add(feature.candidate_id)
                            counts["indexed_paths"] += 1
                            output.write(feature.model_dump_json() + "\n")
                reports.append(dict(game_id=game["game_id"], counts=dict(counts)))
                print(
                    json.dumps(
                        {"game_id": game["game_id"], "indexed_paths": counts["indexed_paths"]}
                    ),
                    flush=True,
                )
                del frames, membership, window
        if not seen:
            raise ValueError("No eligible two-second selected-player paths in this catalog")
        temporary_database = database.with_suffix(".duckdb.part")
        temporary_database.unlink(missing_ok=True)
        temporary_parquet = parquet.with_suffix(".parquet.part")
        metadata = dict(
            feature_version=FEATURE_VERSION,
            definition=DEFINITION,
            definition_hash=DEFINITION_HASH,
            index_fingerprint=fingerprint,
            source_fingerprint=health["source_fingerprint"],
            input_identity=identity,
            candidate_count=len(seen),
            games=reports,
            build_seconds=round(time.perf_counter() - started, 3),
            build_environment=dict(
                platform=platform.platform(),
                machine=platform.machine(),
                peak_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                * (1 if platform.system() == "Darwin" else 1024),
            ),
        )
        with duckdb.connect(str(temporary_database)) as con:
            con.execute(
                "CREATE TABLE paths AS SELECT *,list_transform(x_ft,x->x-x_ft[1]) dx,"
                "list_transform(y_ft,y->y-y_ft[1]) dy FROM read_json(?,columns=?)",
                [str(rows_path), _COLUMNS],
            )
            con.execute(
                "COPY paths TO ? (FORMAT PARQUET,COMPRESSION ZSTD)", [str(temporary_parquet)]
            )
            metadata["parquet_sha256"] = sha256(temporary_parquet)
            con.execute("CREATE TABLE metadata (value VARCHAR)")
            con.execute("INSERT INTO metadata VALUES (?)", [json.dumps(metadata)])
        os.replace(temporary_parquet, parquet)
        os.replace(temporary_database, database)
        metadata["database_sha256"] = sha256(database)
        pending = checkpoint.with_suffix(".json.part")
        pending.write_text(json.dumps(metadata, indent=2) + "\n")
        os.replace(pending, checkpoint)
    return {**metadata, "cached": False}


class Actions:
    def __init__(self, database: Path, source: Catalog, annotations_path: Path):
        self.database, self.source, self.annotations_path = database, source, annotations_path

    def connect(self):
        if not self.database.exists():
            raise FileNotFoundError("No action index. Run make actions after make audit.")
        con = duckdb.connect(str(self.database), read_only=True)
        meta = json.loads(con.execute("SELECT value FROM metadata").fetchone()[0])
        if (
            meta["definition_hash"] != DEFINITION_HASH
            or meta["input_identity"]["adapter_sha256"] != sha256(Path(__file__))
            or meta["input_identity"]["source_database_sha256"] != sha256(self.source.database)
        ):
            con.close()
            raise ValueError("Action index is stale. Rebuild with make actions.")
        return con, meta

    @staticmethod
    def rows(con, sql, params=None):
        cursor = con.execute(sql, params or [])
        names = [c[0] for c in cursor.description]
        return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]

    def feature(self, candidate_id: str) -> PathFeature:
        con, _ = self.connect()
        with con:
            rows = self.rows(
                con, "SELECT * EXCLUDE(dx,dy) FROM paths WHERE candidate_id=?", [candidate_id]
            )
            if not rows:
                raise KeyError("Indexed path not found")
            return PathFeature.model_validate(rows[0])

    def options(self):
        con, meta = self.connect()
        with con:
            games = self.source.games()
            collection = AnnotationSet.model_validate_json(self.annotations_path.read_text())
            seeds = []
            for sequence in collection.sequences:
                try:
                    feature = query_path(
                        self.source, self.annotations_path, sequence.sequence_id, None, None
                    )
                    seeds.append(
                        dict(
                            sequence=sequence.model_dump(),
                            status="available",
                            reason=None,
                            feature=feature.model_dump(),
                        )
                    )
                except (ValueError, KeyError) as error:
                    seeds.append(
                        dict(
                            sequence=sequence.model_dump(),
                            status="unavailable",
                            reason=str(error),
                            feature=None,
                        )
                    )
            return dict(
                **meta,
                seeds=seeds,
                collection=dict(
                    id=collection.collection_id,
                    revision=collection.revision,
                    description=collection.description,
                ),
                roster=[
                    dict(
                        game_id=g["game_id"],
                        players=g["players"],
                        home_team=g["home_team"],
                        away_team=g["away_team"],
                        game_date=str(g["game_date"]),
                    )
                    for g in games
                ],
            )

    def search(
        self,
        seed_id: str | None = None,
        annotation_id: str | None = None,
        player_id: str | None = None,
        feature_id: str | None = None,
        profile: Literal["start_relative", "court_location"] = "start_relative",
        same_player: bool = False,
        other_game: bool = False,
        limit: int = 12,
    ):
        started = time.perf_counter()
        if bool(seed_id) == bool(feature_id):
            raise ValueError("Choose exactly one curated sequence or indexed feature")
        if profile not in DEFINITION["profiles"]:
            raise ValueError("Unknown similarity profile")
        if not 1 <= limit <= 30:
            raise ValueError("Result limit must be 1–30")
        if feature_id and (annotation_id or player_id):
            raise ValueError("Indexed path queries already define their player and endpoint")
        con, meta = self.connect()
        with con:
            try:
                if feature_id:
                    rows = self.rows(
                        con, "SELECT * EXCLUDE(dx,dy) FROM paths WHERE candidate_id=?", [feature_id]
                    )
                    if not rows:
                        raise KeyError("Indexed query path not found")
                    query = PathFeature.model_validate(rows[0])
                else:
                    query = query_path(
                        self.source, self.annotations_path, seed_id, annotation_id, player_id
                    )
            except ValueError as error:
                return dict(
                    status="unavailable", reason=str(error), query=None, matches=[], metadata=meta
                )
            q = query.model_dump()
            x, y = q["x_ft"], q["y_ft"]
            columns = ("dx", "dy") if profile == "start_relative" else ("x_ft", "y_ft")
            if profile == "start_relative":
                x, y = [v - x[0] for v in x], [v - y[0] for v in y]
            clauses = ["NOT(game_id=? AND start_ms<=? AND end_ms>=?)"]
            params = [q["game_id"], q["end_ms"], q["start_ms"]]
            if same_player:
                clauses.append("player_id=?")
                params.append(q["player_id"])
            if other_game:
                clauses.append("game_id<>?")
                params.append(q["game_id"])
            where = " AND ".join(clauses)
            eligible = con.execute(f"SELECT count(*) FROM paths WHERE {where}", params).fetchone()[
                0
            ]
            overlap = con.execute(
                "SELECT count(*) FROM paths WHERE game_id=? AND start_ms<=? AND end_ms>=?",
                [q["game_id"], q["end_ms"], q["start_ms"]],
            ).fetchone()[0]
            # Order solely by paired coordinates; identity is only the deterministic tie-break.
            cursor = con.execute(
                f"""SELECT * EXCLUDE(dx,dy),sqrt(list_sum(list_transform(
                list_zip({columns[0]},{columns[1]},?,?),
                p->pow(p[1]-p[3],2)+pow(p[2]-p[4],2)))/21) rms_ft
                FROM paths WHERE {where} ORDER BY rms_ft,candidate_id""",
                [x, y, *params],
            )
            names = [c[0] for c in cursor.description]
            matches = []

            def ranked_rows():
                while batch := cursor.fetchmany(64):
                    yield from batch

            for row in ranked_rows():
                candidate = dict(zip(names, row, strict=True))
                # Avoid flooding the gallery with simultaneous views of the same footage.
                if any(
                    candidate["game_id"] == m["game_id"]
                    and candidate["start_ms"] <= m["end_ms"]
                    and candidate["end_ms"] >= m["start_ms"]
                    for m in matches
                ):
                    continue
                # Validate the content-addressed samples before exposing a stored result.
                PathFeature.model_validate({k: v for k, v in candidate.items() if k != "rms_ft"})
                matches.append(candidate)
                if len(matches) == limit:
                    break
            return dict(
                status="available",
                reason=None,
                query=q,
                matches=matches,
                profile=profile,
                eligible_paths=eligible,
                overlapping_query_paths_excluded=overlap,
                result_count=len(matches),
                request=dict(
                    seed_id=seed_id,
                    annotation_id=annotation_id,
                    player_id=player_id,
                    feature_id=feature_id,
                    profile=profile,
                    same_player=same_player,
                    other_game=other_game,
                    limit=limit,
                ),
                metadata=meta,
                search_ms=round((time.perf_counter() - started) * 1000, 2),
            )
