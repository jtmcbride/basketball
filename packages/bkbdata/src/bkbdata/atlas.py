"""Offline season partitions and descriptive, count-reconciled shot atlas queries."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import platform
import tarfile
import tempfile
from collections import Counter
from pathlib import Path

import duckdb

from bkbdata.acquire import sha256
from bkbdata.sources import game_id, parse_clock, read_manifests

VERSION = "shot-atlas-v1"
RADIUS = 2.5
MIN_ATTEMPTS = 10
MIN_BASELINE = 25


def hex_cell(x: float, y: float) -> tuple[str, float | None, float | None]:
    """Pointy axial hexes, radius 2.5 ft, origin at the basket; cube rounding."""
    if not (-25 <= x <= 25 and -5.25 <= y <= 41.75):
        return "outside", None, None
    q, r = (math.sqrt(3) / 3 * x - y / 3) / RADIUS, 2 * y / (3 * RADIUS)
    a, b, c = round(q), round(-q - r), round(r)
    da, db, dc = abs(a - q), abs(b + q + r), abs(c - r)
    if da > db and da > dc:
        a = -b - c
    elif dc >= db:
        c = -a - b
    return f"{a}:{c}", RADIUS * math.sqrt(3) * (a + c / 2), RADIUS * 1.5 * c


def archive_rows(path: Path):
    with tarfile.open(path, "r:xz") as archive:
        members = [m for m in archive if m.isfile()]
        if len(members) != 1 or not members[0].name.endswith(".csv"):
            raise ValueError("Expected exactly one CSV member")
        with io.TextIOWrapper(
            archive.extractfile(members[0]), encoding="utf-8-sig", newline=""
        ) as stream:
            yield from csv.DictReader(stream)


def build_atlas(config: Path, raw: Path, database: Path, lake: Path) -> dict:
    """Resume at verified season boundaries. Publish catalog only after all partitions succeed."""
    definition = json.loads(config.read_text())
    sources = {s["id"]: s for s in read_manifests(config, raw)}
    lake.mkdir(parents=True, exist_ok=True)
    database.parent.mkdir(parents=True, exist_ok=True)
    reports = []
    # Adapter source participates in cache identity; edits cannot silently reuse old partitions.
    adapter = sha256(Path(__file__))
    software = dict(python=platform.python_version(), duckdb=duckdb.__version__)
    for season in definition["seasons"]:
        pair = [sources[season["shots"]], sources[season["pbp"]]]
        fingerprint = hashlib.sha256(
            json.dumps([VERSION, adapter, software, season, pair], sort_keys=True).encode()
        ).hexdigest()
        parquet = lake / f"{season['season']}.parquet"
        checkpoint = lake / f"{season['season']}.json"
        if parquet.exists() and checkpoint.exists():
            try:
                saved = json.loads(checkpoint.read_text())
            except json.JSONDecodeError:
                saved = {}
            if saved.get("fingerprint") == fingerprint and saved.get("parquet_sha256") == sha256(
                parquet
            ):
                reports.append({**saved, "cached": True})
                continue
        pbp = {}
        duplicate_pbp = set()
        pbp_rows = 0
        home_teams = {}
        for row in archive_rows(raw / pair[1]["filename"]):
            if row["EVENTMSGTYPE"] not in {"1", "2"}:
                continue
            key = (game_id(row["GAME_ID"]), row["EVENTNUM"])
            pbp_rows += 1
            if key in pbp:
                duplicate_pbp.add(key)
            pbp[key] = (
                row["PLAYER1_ID"],
                row["PLAYER1_TEAM_ID"],
                int(row["PERIOD"]),
                parse_clock(row["PCTIMESTRING"]),
                row["EVENTMSGTYPE"] == "1",
            )
            if row["HOMEDESCRIPTION"] and not row["VISITORDESCRIPTION"] and row["PLAYER1_TEAM_ID"]:
                gid = key[0]
                if gid in home_teams and home_teams[gid] != row["PLAYER1_TEAM_ID"]:
                    raise ValueError(f"Conflicting home team: {gid}")
                home_teams[gid] = row["PLAYER1_TEAM_ID"]
        keys, games, dates, teams = set(), set(), [], set()
        counts = Counter()
        with tempfile.TemporaryDirectory() as temporary:
            csv_path = Path(temporary) / "shots.csv"
            with csv_path.open("w", newline="") as output:
                writer = csv.writer(output)
                writer.writerow(
                    [
                        "season",
                        "shot_id",
                        "game_id",
                        "source_event_id",
                        "game_date",
                        "player_id",
                        "player_name",
                        "team_id",
                        "team_name",
                        "opponent",
                        "period",
                        "game_clock_s",
                        "made",
                        "shot_value",
                        "action_type",
                        "lateral_ft",
                        "forward_ft",
                        "recorded_distance_ft",
                        "cell",
                        "cx",
                        "cy",
                        "event_matched",
                    ]
                )
                for row in archive_rows(raw / pair[0]["filename"]):
                    gid, event = game_id(row["GAME_ID"]), row["GAME_EVENT_ID"]
                    key = gid, event
                    if key in keys:
                        raise ValueError(f"Duplicate shot key: {key}")
                    keys.add(key)
                    if (
                        row["SHOT_ATTEMPTED_FLAG"] != "1"
                        or row["SHOT_MADE_FLAG"] not in {"0", "1"}
                        or row["SHOT_TYPE"] not in {"2PT Field Goal", "3PT Field Goal"}
                    ):
                        raise ValueError(f"Invalid field-goal record: {key}")
                    x, y, distance = (
                        float(row["LOC_X"]) / 10,
                        float(row["LOC_Y"]) / 10,
                        float(row["SHOT_DISTANCE"]),
                    )
                    if not all(math.isfinite(v) for v in [x, y, distance]):
                        raise ValueError(f"Non-finite coordinate: {key}")
                    period, clock = (
                        int(row["PERIOD"]),
                        int(row["MINUTES_REMAINING"]) * 60 + int(row["SECONDS_REMAINING"]),
                    )
                    made = row["SHOT_MADE_FLAG"] == "1"
                    match = pbp.get(key)
                    verified = bool(
                        key not in duplicate_pbp
                        and match
                        and match[:3] == (row["PLAYER_ID"], row["TEAM_ID"], period)
                        and abs(match[3] - clock) <= 1
                        and match[4] == made
                    )
                    opponent = (
                        (row["VTM"] if row["TEAM_ID"] == home_teams.get(gid) else row["HTM"])
                        if gid in home_teams
                        else "unknown"
                    )
                    cell, cx, cy = hex_cell(x, y)
                    date = row["GAME_DATE"]
                    dates.append(date)
                    games.add(gid)
                    teams.add(row["TEAM_ID"])
                    counts["attempts"] += 1
                    counts["made"] += made
                    counts["event_matched"] += verified
                    counts["outside_half_court"] += cell == "outside"
                    counts["unknown_opponent"] += opponent == "unknown"
                    writer.writerow(
                        [
                            season["season"],
                            f"shotchart:{gid}:{event}",
                            gid,
                            event,
                            date,
                            row["PLAYER_ID"],
                            row["PLAYER_NAME"],
                            row["TEAM_ID"],
                            row["TEAM_NAME"],
                            opponent,
                            period,
                            clock,
                            int(made),
                            3 if row["SHOT_TYPE"].startswith("3") else 2,
                            row["ACTION_TYPE"],
                            x,
                            y,
                            distance,
                            cell,
                            cx,
                            cy,
                            int(verified),
                        ]
                    )
            with duckdb.connect() as con:
                con.execute(
                    "CREATE TABLE imported AS SELECT * FROM read_csv(?, all_varchar=true)",
                    [str(csv_path)],
                )
                con.execute("""CREATE TABLE normalized AS SELECT
                    season,shot_id,game_id,source_event_id,game_date,player_id,player_name,
                    team_id,team_name,opponent,period::INTEGER period,
                    game_clock_s::DOUBLE game_clock_s,made::INTEGER made,
                    shot_value::INTEGER shot_value,action_type,lateral_ft::DOUBLE lateral_ft,
                    forward_ft::DOUBLE forward_ft,
                    recorded_distance_ft::DOUBLE recorded_distance_ft,cell,cx::DOUBLE cx,
                    cy::DOUBLE cy,event_matched::INTEGER event_matched FROM imported""")
                temporary_parquet = parquet.with_suffix(".parquet.part")
                con.execute(
                    "COPY normalized TO ? (FORMAT PARQUET, COMPRESSION ZSTD)",
                    [str(temporary_parquet)],
                )
            os.replace(temporary_parquet, parquet)
        pbp_games = {key[0] for key in pbp}
        report = dict(
            season=season["season"],
            fingerprint=fingerprint,
            parquet_sha256=sha256(parquet),
            **counts,
            games=len(games),
            teams=len(teams),
            date_min=min(dates),
            date_max=max(dates),
            pbp_attempts=len(pbp),
            pbp_rows=pbp_rows,
            duplicate_pbp_keys=len(duplicate_pbp),
            pbp_games=len(pbp_games),
            shots_without_pbp_key=len(keys - pbp.keys()),
            pbp_attempts_without_shot=len(pbp.keys() - keys),
            games_without_shots=sorted(pbp_games - games),
            coverage_label=(
                "Observed regular-season archive; checked against paired play-by-play, "
                "not an official schedule"
            ),
            sources=pair,
            software=software,
            adapter_sha256=adapter,
            duplicate_pbp_examples=sorted(duplicate_pbp)[:20],
            pbp_without_shot_examples=sorted(pbp.keys() - keys)[:20],
            shot_without_pbp_examples=sorted(keys - pbp.keys())[:20],
        )
        pending_checkpoint = checkpoint.with_suffix(".json.part")
        pending_checkpoint.write_text(json.dumps(report, indent=2) + "\n")
        os.replace(pending_checkpoint, checkpoint)
        reports.append({**report, "cached": False})
    temporary_database = database.with_suffix(".duckdb.part")
    temporary_database.unlink(missing_ok=True)
    with duckdb.connect(str(temporary_database)) as con:
        paths = [str(lake / f"{s['season']}.parquet") for s in reports]
        con.execute("CREATE TABLE shots AS SELECT * FROM read_parquet(?)", [paths])
        con.execute("CREATE TABLE metadata (value VARCHAR)")
        con.execute(
            "INSERT INTO metadata VALUES (?)", [json.dumps(dict(version=VERSION, seasons=reports))]
        )
    os.replace(temporary_database, database)
    return dict(version=VERSION, seasons=reports)


class Atlas:
    def __init__(self, database: Path):
        self.database = database

    def connect(self):
        if not self.database.exists():
            raise FileNotFoundError("No shot atlas. Run make atlas-fetch and make atlas.")
        return duckdb.connect(str(self.database), read_only=True)

    @staticmethod
    def rows(con, sql, params=None):
        cursor = con.execute(sql, params or [])
        names = [column[0] for column in cursor.description]
        return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]

    def options(self):
        with self.connect() as con:
            metadata = json.loads(con.execute("SELECT value FROM metadata").fetchone()[0])
            return dict(
                **metadata,
                players=self.rows(
                    con,
                    "SELECT player_id id, min(player_name) AS name, "
                    "list(DISTINCT season ORDER BY season) seasons "
                    "FROM shots GROUP BY player_id ORDER BY name",
                ),
                teams=self.rows(
                    con,
                    "SELECT team_id id,min(team_name) AS name FROM shots "
                    "GROUP BY team_id ORDER BY name",
                ),
                opponents=[
                    r[0]
                    for r in con.execute(
                        "SELECT DISTINCT opponent FROM shots ORDER BY opponent"
                    ).fetchall()
                ],
                periods=[
                    r[0]
                    for r in con.execute(
                        "SELECT DISTINCT period FROM shots ORDER BY period"
                    ).fetchall()
                ],
                grid=dict(radius_ft=RADIUS, origin="basket", outside="outside half-court view"),
                reliability=dict(cohort=MIN_ATTEMPTS, baseline=MIN_BASELINE),
            )

    @staticmethod
    def where(filters, baseline=False):
        columns = ["season", "team_id", "opponent", "period", "shot_value"]
        if not baseline:
            columns.append("player_id")
        clauses, params = [], []
        for column in columns:
            value = filters.get(column)
            if value is not None and value != "all":
                clauses.append(f"{column} = ?")
                params.append(value)
        return " AND ".join(clauses) or "true", params

    def summary(self, filters):
        if not filters.get("season") or filters["season"] == "all":
            raise ValueError("Choose one season for a same-season baseline")
        where, params = self.where(filters)
        baseline_where, baseline_params = self.where(filters, baseline=True)
        with self.connect() as con:
            bins = self.rows(
                con,
                f"""SELECT cell, min(cx) cx,min(cy) cy,count(*) n,sum(made) made,
                sum(made*shot_value) points FROM shots WHERE {where} GROUP BY cell ORDER BY cell""",
                params,
            )
            baseline = {
                r["cell"]: r
                for r in self.rows(
                    con,
                    f"""SELECT cell,count(*) n,sum(made) made FROM shots
                WHERE {baseline_where} GROUP BY cell""",
                    baseline_params,
                )
            }
            total = sum(b["n"] for b in bins)
            for b in bins:
                base = baseline[b["cell"]]
                b.update(
                    frequency=100 * b["n"] / total,
                    fg_pct=100 * b["made"] / b["n"],
                    points_per_attempt=b["points"] / b["n"],
                    baseline_n=base["n"],
                    baseline_fg_pct=100 * base["made"] / base["n"],
                    difference_pp=(100 * b["made"] / b["n"] - 100 * base["made"] / base["n"])
                    if b["n"] >= MIN_ATTEMPTS and base["n"] >= MIN_BASELINE
                    else None,
                    reliable=b["n"] >= MIN_ATTEMPTS,
                )
            histogram = self.rows(
                con,
                f"""SELECT least(50,floor(recorded_distance_ft/5)*5)::INTEGER distance,
                cell,count(*) n FROM shots WHERE {where}
                GROUP BY distance,cell ORDER BY distance,cell""",
                params,
            )
            return dict(
                filters=filters,
                n=total,
                made=sum(b["made"] for b in bins),
                points=sum(b["points"] for b in bins),
                bins=bins,
                histogram=histogram,
                baseline=dict(
                    n=sum(b["n"] for b in baseline.values()),
                    season=filters["season"],
                    filters={k: v for k, v in filters.items() if k != "player_id"},
                    population=(
                        "All recorded players satisfying shared filters in this season, "
                        "including selected player; descriptive FG% difference, "
                        "not modeled or shot-quality adjusted"
                    ),
                ),
            )

    def attempts(self, filters, cell, offset, limit):
        where, params = self.where(filters)
        if cell is not None:
            where += " AND cell = ?"
            params.append(cell)
        with self.connect() as con:
            total = con.execute(f"SELECT count(*) FROM shots WHERE {where}", params).fetchone()[0]
            rows = self.rows(
                con,
                f"SELECT * FROM shots WHERE {where} "
                "ORDER BY game_date,game_id,source_event_id::INTEGER LIMIT ? OFFSET ?",
                [*params, limit, offset],
            )
            return dict(total=total, offset=offset, attempts=rows)
