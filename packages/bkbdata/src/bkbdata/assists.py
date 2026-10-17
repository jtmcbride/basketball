"""Recorded assists on made field goals, joined to atlas shot locations.

Assists exist only on makes, so every share here is of made field goals, never
of attempts. An assist names a passer; it does not record the pass location.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import tempfile
from collections import Counter
from pathlib import Path

import duckdb

from bkbdata.acquire import sha256
from bkbdata.atlas import archive_rows
from bkbdata.sources import game_id, read_manifests

VERSION = "basketball-assists-v1"
MIN_MAKES = 10
NETWORK_SIZE = 8
DEFINITION = dict(
    version=VERSION,
    population="Atlas made field goals with a verified play-by-play event",
    assisted="Made-shot event with PLAYER2 present, a matching '(Name N AST)' description, "
    "and PLAYER2 on the shooter's team and not the shooter",
    unassisted="Made-shot event with no PLAYER2 and no assist text",
    unverified="PLAYER2 and description disagree, other-team or self assister, or duplicate "
    "event key; excluded from every share",
    share="Assisted makes / verified makes in the cell or cohort; never per attempt",
    passer_map="Locations of made shots credited to the passer; not where the pass started",
    reliability=f"Cells below {MIN_MAKES} verified makes fade and are not compared",
    network=f"Top {NETWORK_SIZE} team players by assists plus assisted makes in the season",
    not_claimed=["pass origin", "potential assists", "hockey assists", "causal creation"],
)
DEFINITION_HASH = hashlib.sha256(json.dumps(DEFINITION, sort_keys=True).encode()).hexdigest()
ASSIST_TEXT = re.compile(r"\((.+?) \d+ AST\)")


def classify(row: dict) -> tuple[str, str | None]:
    """Return (status, reason) for one made-shot play-by-play row."""
    description = " ".join(
        row[k] for k in ("HOMEDESCRIPTION", "NEUTRALDESCRIPTION", "VISITORDESCRIPTION") if row[k]
    )
    field = row["PLAYER2_ID"] not in ("", "0")
    text = bool(ASSIST_TEXT.search(description))
    if field != text:
        return "unverified", "field_text_disagree"
    if not field:
        return "unassisted", None
    if row["PLAYER2_TEAM_ID"] != row["PLAYER1_TEAM_ID"]:
        return "unverified", "other_team"
    if row["PLAYER2_ID"] == row["PLAYER1_ID"]:
        return "unverified", "self"
    return "assisted", None


def build_assists(config: Path, raw: Path, atlas_database: Path, database: Path) -> dict:
    definition = json.loads(config.read_text())
    sources = {s["id"]: s for s in read_manifests(config, raw)}
    pbp = [(season["season"], sources[season["pbp"]]) for season in definition["seasons"]]
    identity = dict(
        definition_hash=DEFINITION_HASH,
        atlas_sha256=sha256(atlas_database),
        adapter_sha256=sha256(Path(__file__)),
        pbp_sha256={season: source["sha256"] for season, source in pbp},
    )
    fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    if database.exists():
        with duckdb.connect(str(database), read_only=True) as con:
            saved = json.loads(con.execute("SELECT value FROM metadata").fetchone()[0])
        if saved["fingerprint"] == fingerprint:
            return dict(cached=True, fingerprint=fingerprint, coverage=saved["coverage"])
    checks: dict[str, Counter] = {}
    database.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=database.parent) as temporary:
        events = Path(temporary) / "events.csv"
        with events.open("w", newline="") as output:
            writer = csv.writer(output)
            writer.writerow(
                ["season", "game_id", "source_event_id", "status", "passer_id", "passer_name"]
            )
            for season, source in pbp:
                counts, keys, rows = Counter(), Counter(), []
                for row in archive_rows(raw / source["filename"]):
                    if row["EVENTMSGTYPE"] != "1":
                        continue
                    status, reason = classify(row)
                    counts[status] += 1
                    if reason:
                        counts[reason] += 1
                    key = (game_id(row["GAME_ID"]), row["EVENTNUM"])
                    keys[key] += 1
                    rows.append((key, status, row))
                for key, status, row in rows:
                    if keys[key] > 1:
                        counts["duplicate_key"] += 1
                        status = "unverified"
                    assisted = status == "assisted"
                    writer.writerow(
                        [
                            season,
                            *key,
                            status,
                            row["PLAYER2_ID"] if assisted else None,
                            row["PLAYER2_NAME"] if assisted else None,
                        ]
                    )
                checks[season] = counts
        pending = Path(temporary) / "assists.duckdb"
        with duckdb.connect(str(pending)) as con:
            # ATTACH takes no bound parameters; quote the local path literally.
            quoted = str(atlas_database).replace("'", "''")
            con.execute(f"ATTACH '{quoted}' AS atlas (READ_ONLY)")
            con.execute(
                "CREATE TABLE events AS SELECT * FROM read_csv(?, all_varchar=true)", [str(events)]
            )
            con.execute(
                """CREATE TABLE makes AS SELECT s.season, s.shot_id, s.game_id, s.team_id,
                s.team_name, s.player_id, s.player_name, s.shot_value, s.cell, s.cx, s.cy,
                coalesce(e.status, 'unmatched') status, e.passer_id, e.passer_name
                FROM atlas.shots s LEFT JOIN events e ON e.season = s.season
                AND e.game_id = s.game_id AND e.source_event_id = s.source_event_id
                WHERE s.made AND s.event_matched"""
            )
            coverage = {}
            for season, *_ in pbp:
                atlas_makes, unmatched_event = con.execute(
                    "SELECT count(*) FILTER (WHERE made), "
                    "count(*) FILTER (WHERE made AND NOT event_matched) "
                    "FROM atlas.shots WHERE season = ?",
                    [season],
                ).fetchone()
                statuses = dict(
                    con.execute(
                        "SELECT status, count(*) FROM makes WHERE season = ? GROUP BY status",
                        [season],
                    ).fetchall()
                )
                if sum(statuses.values()) != atlas_makes - unmatched_event:
                    raise ValueError(f"Assist join does not reconcile with atlas makes: {season}")
                coverage[season] = dict(
                    atlas_makes=atlas_makes,
                    event_unmatched=unmatched_event,
                    assisted=statuses.get("assisted", 0),
                    unassisted=statuses.get("unassisted", 0),
                    unverified=statuses.get("unverified", 0) + statuses.get("unmatched", 0),
                    pbp_checks=dict(sorted(checks[season].items())),
                )
            con.execute("DETACH atlas")
            con.execute("DROP TABLE events")
            con.execute("CREATE TABLE metadata(value VARCHAR)")
            metadata = dict(
                schema_version=VERSION,
                definition=DEFINITION,
                fingerprint=fingerprint,
                input_identity=identity,
                coverage=coverage,
            )
            con.execute("INSERT INTO metadata VALUES (?)", [json.dumps(metadata)])
        os.replace(pending, database)
    return dict(cached=False, fingerprint=fingerprint, coverage=coverage)


class Assists:
    def __init__(self, database: Path, atlas_database: Path):
        self.database, self.atlas_database = database, atlas_database

    def connect(self):
        if not self.database.exists():
            raise FileNotFoundError("No assist index. Run make assists after make atlas.")
        con = duckdb.connect(str(self.database), read_only=True)
        metadata = json.loads(con.execute("SELECT value FROM metadata").fetchone()[0])
        identity = metadata["input_identity"]
        if (
            identity["atlas_sha256"] != sha256(self.atlas_database)
            or identity["adapter_sha256"] != sha256(Path(__file__))
            or identity["definition_hash"] != DEFINITION_HASH
        ):
            con.close()
            raise ValueError("Assist index is stale. Rebuild with make assists.")
        return con, metadata

    @staticmethod
    def rows(con, sql, params=None):
        cursor = con.execute(sql, params or [])
        names = [column[0] for column in cursor.description]
        return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]

    def options(self) -> dict:
        con, metadata = self.connect()
        with con:
            teams = self.rows(
                con,
                "SELECT season, team_id id, min(team_name) AS name, count(*) makes FROM makes "
                "GROUP BY season, team_id ORDER BY season, name",
            )
        return dict(**metadata, teams=teams)

    def summary(
        self, season: str, team_id: str, player_id: str | None = None, role: str = "shooter"
    ) -> dict:
        if role not in {"shooter", "passer"}:
            raise ValueError("Role must be shooter or passer")
        if role == "passer" and player_id is None:
            raise ValueError("A passer map requires a player")
        con, metadata = self.connect()
        verified = "status IN ('assisted','unassisted')"
        team = f"season = ? AND team_id = ? AND {verified}"
        with con:
            if not con.execute(
                "SELECT count(*) FROM makes WHERE season = ? AND team_id = ?", [season, team_id]
            ).fetchone()[0]:
                raise KeyError("No made field goals for this team and season")
            players = self.rows(
                con,
                f"""WITH shooting AS (SELECT player_id, min(player_name) AS name, count(*) makes,
                count(*) FILTER (WHERE status = 'assisted') assisted FROM makes WHERE {team}
                GROUP BY player_id), passing AS (SELECT passer_id player_id,
                min(passer_name) AS name, count(*) assists FROM makes
                WHERE {team} AND status = 'assisted' GROUP BY passer_id)
                SELECT player_id id, coalesce(s.name, p.name) AS name, coalesce(makes, 0) makes,
                coalesce(assisted, 0) assisted, coalesce(assists, 0) assists
                FROM shooting s FULL JOIN passing p USING (player_id)
                ORDER BY assists + assisted DESC, name""",
                [season, team_id, season, team_id],
            )
            if player_id is not None and player_id not in {p["id"] for p in players}:
                raise KeyError("Player has no verified makes or assists for this team")
            if role == "passer":
                cohort, params = f"{team} AND passer_id = ?", [season, team_id, player_id]
            elif player_id is not None:
                cohort, params = f"{team} AND player_id = ?", [season, team_id, player_id]
            else:
                cohort, params = team, [season, team_id]
            cells = self.rows(
                con,
                f"""SELECT cell, min(cx) cx, min(cy) cy, count(*) makes,
                count(*) FILTER (WHERE status = 'assisted') assisted FROM makes
                WHERE {cohort} AND cell <> 'outside' GROUP BY cell ORDER BY cell""",
                params,
            )
            totals = self.rows(
                con,
                f"""SELECT shot_value, count(*) makes,
                count(*) FILTER (WHERE status = 'assisted') assisted FROM makes
                WHERE {cohort} GROUP BY shot_value ORDER BY shot_value""",
                params,
            )
            league = self.rows(
                con,
                f"""SELECT shot_value, count(*) makes,
                count(*) FILTER (WHERE status = 'assisted') assisted FROM makes
                WHERE season = ? AND {verified} GROUP BY shot_value ORDER BY shot_value""",
                [season],
            )
            league_cells = {
                r["cell"]: r
                for r in self.rows(
                    con,
                    f"""SELECT cell, count(*) makes,
                    count(*) FILTER (WHERE status = 'assisted') assisted FROM makes
                    WHERE season = ? AND {verified} AND cell <> 'outside' GROUP BY cell""",
                    [season],
                )
            }
            core = [p["id"] for p in players[:NETWORK_SIZE]]
            if player_id is not None and player_id not in core:
                core = [*core[:-1], player_id]
            links = self.rows(
                con,
                f"""SELECT passer_id, player_id shooter_id, count(*) makes FROM makes
                WHERE {team} AND status = 'assisted' GROUP BY passer_id, player_id""",
                [season, team_id],
            )
            unverified = con.execute(
                "SELECT count(*) FROM makes WHERE season = ? AND team_id = ? "
                "AND status NOT IN ('assisted','unassisted')",
                [season, team_id],
            ).fetchone()[0]
        cohort_makes = sum(c["makes"] for c in cells)
        for c in cells:
            base = league_cells.get(c["cell"], {"makes": 0, "assisted": 0})
            c["reliable"] = c["makes"] >= MIN_MAKES
            c["per_100"] = 100 * c["makes"] / cohort_makes
            c["share"] = c["assisted"] / c["makes"] if c["makes"] else None
            c["league_makes"] = base["makes"]
            c["league_share"] = base["assisted"] / base["makes"] if base["makes"] else None
        names = {p["id"]: p["name"] for p in players}
        core_set = set(core)
        network = dict(
            players=[{"id": i, "name": names[i]} for i in core],
            links=[link for link in links if {link["passer_id"], link["shooter_id"]} <= core_set],
            outside_core=sum(
                link["makes"]
                for link in links
                if not {link["passer_id"], link["shooter_id"]} <= core_set
            ),
        )
        partners = None
        if player_id is not None:
            partners = dict(
                passers=sorted(
                    (
                        dict(
                            id=link["passer_id"],
                            name=names.get(link["passer_id"]),
                            makes=link["makes"],
                        )
                        for link in links
                        if link["shooter_id"] == player_id
                    ),
                    key=lambda p: -p["makes"],
                )[:5],
                targets=sorted(
                    (
                        dict(
                            id=link["shooter_id"],
                            name=names.get(link["shooter_id"]),
                            makes=link["makes"],
                        )
                        for link in links
                        if link["passer_id"] == player_id
                    ),
                    key=lambda p: -p["makes"],
                )[:5],
            )
        return dict(
            schema_version=VERSION,
            filters=dict(season=season, team_id=team_id, player_id=player_id, role=role),
            cells=cells,
            totals=totals,
            league=league,
            players=players,
            network=network,
            partners=partners,
            unverified_team_makes=unverified,
            fingerprint=metadata["fingerprint"],
        )
