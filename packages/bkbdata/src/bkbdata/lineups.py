"""Event-ordered historical rotations with independent gamebook constraints.

No repairs, tracking-based starter guesses, causal ratings or possession estimates.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from collections import Counter, defaultdict
from pathlib import Path
from typing import Literal

import duckdb
from pydantic import Field, model_validator

from bkbdata.acquire import sha256
from bkbdata.atlas import archive_rows
from bkbdata.catalog import Catalog
from bkbdata.contracts import Contract
from bkbdata.sources import game_id, parse_clock, read_manifests, selected_csv_rows

VERSION = "basketball-lineups-v1"
DEFINITION = {
    "version": VERSION,
    "time": "Source row order within each period; game clocks determine duration, not tie order",
    "starters": "First on-court involvement or outgoing substitution before first incoming sub",
    "substitutions": "Contiguous same-clock substitutions applied together, outgoing then incoming",
    "validation": "Five unique players/team, event roles, gamebook starters/minutes/FGA/FGM/PTS",
    "rounding": "Minute tolerance: one second per stint boundary plus one gamebook rounding second",
    "score": "Recorded away-home score in source event order; not official player plus-minus",
    "possessions": "Deduplicated pbpstats records; incomplete FGA coverage withholds totals",
    "not_inferred": ["causal impact", "defensive assignments", "tracking release times"],
}


class LineupStint(Contract):
    stint_id: str
    period: int = Field(ge=1)
    start_clock_s: float = Field(ge=0)
    end_clock_s: float = Field(ge=0)
    duration_s: float = Field(ge=0)
    start_order: int = Field(ge=0)
    end_order: int = Field(ge=0)
    status: Literal["available", "unavailable"]
    reasons: list[str]
    lineups: dict[str, list[str]]
    score_start: list[int] = Field(min_length=2, max_length=2)
    score_end: list[int] = Field(min_length=2, max_length=2)
    shot_ids: list[str]
    substitution_ids: list[str]
    possession_ids: list[str] = []
    possession_count: int | None = None

    @model_validator(mode="after")
    def consistent(self):
        if abs(self.duration_s - (self.start_clock_s - self.end_clock_s)) > 1e-8:
            raise ValueError("Stint duration must agree with its recorded game clocks")
        if self.end_order < self.start_order:
            raise ValueError("Stint event order is reversed")
        if self.status == "available" and (
            self.reasons
            or len(self.lineups) != 2
            or any(len(p) != 5 or len(set(p)) != 5 for p in self.lineups.values())
        ):
            raise ValueError("Available stints require two validated unique five-player groups")
        if self.status == "unavailable" and (not self.reasons or self.lineups):
            raise ValueError("Unresolved quintets must stay unavailable with a reason")
        return self


class LineupGame(Contract):
    schema_version: Literal["basketball-lineups-v1"] = VERSION
    game: dict
    stints: list[LineupStint]
    substitutions: list[dict]
    shots: list[dict]
    possessions: list[dict]
    margin: list[dict]
    validation: dict
    box_players: list[dict]

    @model_validator(mode="after")
    def source_bindings(self):
        roster = {p["player_id"]: p["team_id"] for p in self.game["players"]}
        shots = {s["shot_id"]: s for s in self.shots}
        assigned = []
        for stint in self.stints:
            for tid, players in stint.lineups.items():
                if any(roster.get(pid) != tid for pid in players):
                    raise ValueError("Lineup identities disagree with game roster/team")
            for sid in stint.shot_ids:
                shot = shots.get(sid)
                if (
                    shot is None
                    or shot["game_id"] != self.game["game_id"]
                    or shot["period"] != stint.period
                ):
                    raise ValueError("Stint attempt does not belong to its source game/period")
            assigned.extend(stint.shot_ids)
        if len(set(assigned)) != len(assigned):
            raise ValueError("A source attempt cannot belong to multiple stints")
        return self


def parse_gamebook(text: str, game: dict) -> list[dict]:
    """First (final-box) page only. Bind by team and exact jersey, retaining 00."""
    page = text.split("\f")[0]
    if "FINAL BOX" not in page or "OFFICIAL SCORER'S REPORT" not in page:
        raise ValueError("Expected official final-box gamebook page")
    team = game["away_team_id"]
    rows = []
    for line in page.splitlines():
        if line.startswith("HOME:"):
            team = game["home_team_id"]
        match = re.match(r"^\s*(\d+)\s+(.+?)\s+(\d+:\d\d)\s+(.+)", line)
        if not match:
            continue
        jersey, name, minutes, stats = match.groups()
        players = [p for p in game["players"] if p["team_id"] == team and p["jersey"] == jersey]
        if len(players) != 1:
            raise ValueError(f"Gamebook jersey {team}/{jersey} has no unique roster identity")
        numbers = [int(x) for x in stats.split()]
        if len(numbers) != 16:
            raise ValueError("Unexpected final-box statistics columns")
        # Names are a second check, not a fuzzy identity-matching rule.
        normalized = lambda s: re.sub(r"[^a-z]", "", s.lower())  # noqa: E731
        starter = bool(re.search(r"\s[FCG]$", name))
        name = re.sub(r"\s[FCG]$", "", name)
        if normalized(name) != normalized(players[0]["name"]):
            raise ValueError("Gamebook player name disagrees with source roster")
        rows.append(
            dict(
                player_id=players[0]["player_id"],
                team_id=team,
                name=name,
                starter=starter,
                seconds=parse_clock(minutes),
                fgm=numbers[0],
                fga=numbers[1],
                points=numbers[-1],
                official_plus_minus=numbers[-2],
            )
        )
    for tid in (game["away_team_id"], game["home_team_id"]):
        if sum(p["starter"] for p in rows if p["team_id"] == tid) != 5:
            raise ValueError("Gamebook must identify five starters on each team")
    if len({p["player_id"] for p in rows}) != len(rows):
        raise ValueError("Duplicate final-box player identity")
    return rows


def participants(row: dict, roster: dict) -> list[str]:
    """Only explicit on-court roles; bench/technical fouls are not starter evidence."""
    kind, action = int(row["EVENTMSGTYPE"]), int(row["EVENTMSGACTIONTYPE"])
    slots = {1: [1, 2], 2: [1, 3], 3: [1], 4: [1], 5: [1, 2], 6: [1, 2], 10: [1, 2, 3]}.get(
        kind, []
    )
    if kind == 6 and action in {11, 12, 13, 16, 18, 19, 25, 26, 27, 30}:
        slots = []
    teams = {p["team_id"] for p in roster.values()}
    ids = []
    for i in slots:
        pid, tid = row.get(f"PLAYER{i}_ID", ""), row.get(f"PLAYER{i}_TEAM_ID", "")
        if pid in roster or (pid not in {"", "0", *teams} and tid not in {"", "0"}):
            ids.append(pid)
    return ids


def period_starters(events: list[dict], roster: dict, teams: list[str]) -> dict[str, set[str]]:
    first = {}
    for row in events:
        if int(row["EVENTMSGTYPE"]) == 8:
            for slot, incoming in ((1, False), (2, True)):
                pid = row[f"PLAYER{slot}_ID"]
                if pid in roster:
                    first.setdefault(pid, not incoming)
        else:
            for pid in participants(row, roster):
                if pid in roster:
                    first.setdefault(pid, True)
    return {
        tid: {p for p, is_on in first.items() if is_on and roster[p]["team_id"] == tid}
        for tid in teams
    }


def reconstruct(game: dict, events: list[dict], shots: list[dict], box: list[dict]) -> LineupGame:
    roster = {p["player_id"]: p for p in game["players"]}
    teams = [game["away_team_id"], game["home_team_id"]]
    if len({r["EVENTNUM"] for r in events}) != len(events):
        raise ValueError("Duplicate source event identity; cannot establish substitution order")
    stints, subs, margin, score = [], [], [], [0, 0]
    assigned = set()
    shot_events = {s["source_event_id"]: s for s in shots}
    raw_minutes, boundaries, event_plus = Counter(), Counter(), Counter()
    failures = []
    for period in sorted({int(r["PERIOD"]) for r in events}):
        es = [(i, r) for i, r in enumerate(events) if int(r["PERIOD"]) == period]
        length = 720 if period <= 4 else 300
        on = period_starters([r for _, r in es], roster, teams)
        reasons = []
        if any(len(on[t]) != 5 for t in teams):
            reasons.append(
                "Period starters are not uniquely determined by source participants/subs"
            )
        if period == 1 and any(
            on[t] != {p["player_id"] for p in box if p["team_id"] == t and p["starter"]}
            for t in teams
        ):
            reasons.append("Opening lineup disagrees with official gamebook starters")
        if not any(int(r["EVENTMSGTYPE"]) == 12 for _, r in es) or not any(
            int(r["EVENTMSGTYPE"]) == 13 for _, r in es
        ):
            reasons.append("Period start/end events are incomplete")
        current = None

        def begin(order, clock_s, changed):
            return dict(
                stint_id=f"stint:{game['game_id']}:{period}:{order}",
                period=period,
                start_clock_s=clock_s,
                end_clock_s=clock_s,
                duration_s=0,
                start_order=order,
                end_order=order,
                lineups={t: sorted(on[t]) for t in teams},
                status="available",
                reasons=[],
                score_start=score.copy(),
                score_end=score.copy(),
                shot_ids=[],
                substitution_ids=changed,
            )

        def finish(clock_s, order):
            current.update(
                end_clock_s=clock_s,
                duration_s=current["start_clock_s"] - clock_s,
                end_order=order,
                score_end=score.copy(),
            )
            current["reasons"] = list(dict.fromkeys(current["reasons"] + reasons))
            if current["reasons"]:
                current.update(status="unavailable", lineups={})
            else:
                for ids in current["lineups"].values():
                    for pid in ids:
                        raw_minutes[pid] += current["duration_s"]
                        boundaries[pid] += 2
                        delta = (score[1] - score[0]) - (
                            current["score_start"][1] - current["score_start"][0]
                        )
                        event_plus[pid] += delta * (1 if roster[pid]["team_id"] == teams[1] else -1)
            stints.append(current)

        current = begin(es[0][0], length, [])
        previous = length
        j = 0
        while j < len(es):
            order, row = es[j]
            clock_s = parse_clock(row["PCTIMESTRING"])
            if not 0 <= clock_s <= previous or clock_s > length:
                raise ValueError("Source row order has a clock reversal or invalid period clock")
            previous = clock_s
            if int(row["EVENTMSGTYPE"]) == 8:
                batch = []
                while (
                    j < len(es)
                    and int(es[j][1]["EVENTMSGTYPE"]) == 8
                    and (es[j][1]["PCTIMESTRING"] == row["PCTIMESTRING"])
                ):
                    batch.append(es[j])
                    j += 1
                finish(clock_s, order)
                outgoing, incoming = defaultdict(list), defaultdict(list)
                changed = []
                for sub_order, sub in batch:
                    a, b, tid = sub["PLAYER1_ID"], sub["PLAYER2_ID"], sub["PLAYER1_TEAM_ID"]
                    sid = f"nbastats:{game['game_id']}:{sub['EVENTNUM']}"
                    changed.append(sid)
                    subs.append(
                        dict(
                            event_id=sid,
                            order=sub_order,
                            period=period,
                            game_clock_s=clock_s,
                            team_id=tid,
                            outgoing=a,
                            incoming=b,
                        )
                    )
                    if (
                        a not in roster
                        or b not in roster
                        or tid not in teams
                        or roster[a]["team_id"] != tid
                        or roster[b]["team_id"] != tid
                        or sub["PLAYER2_TEAM_ID"] != tid
                    ):
                        reasons.append(
                            "Substitution has unknown or inconsistent roster/team identity"
                        )
                        continue
                    outgoing[tid].append(a)
                    incoming[tid].append(b)
                for tid in teams:
                    a, b = outgoing[tid], incoming[tid]
                    if len(set(a)) != len(a) or len(set(b)) != len(b) or not set(a) <= on[tid]:
                        reasons.append("Outgoing substitution is absent or duplicated")
                    remaining = on[tid] - set(a)
                    if set(b) & remaining:
                        reasons.append("Incoming substitution is already on court")
                    on[tid] = remaining | set(b)
                    if len(on[tid]) != 5:
                        reasons.append("Substitution does not preserve five unique players")
                current = begin(batch[-1][0] + 1, clock_s, changed)
                continue
            for pid in participants(row, roster):
                if pid not in roster:
                    current["reasons"].append("On-court participant has no source roster identity")
                    continue
                if any(
                    row.get(f"PLAYER{i}_ID") == pid
                    and row.get(f"PLAYER{i}_TEAM_ID") != roster[pid]["team_id"]
                    for i in (1, 2, 3)
                ):
                    current["reasons"].append("On-court participant team disagrees with roster")
                if pid not in on[roster[pid]["team_id"]]:
                    current["reasons"].append(f"On-court event participant {pid} is absent")
            if row.get("SCORE"):
                new = [int(v.strip()) for v in row["SCORE"].split("-")]
                if len(new) != 2 or any(a < b for a, b in zip(new, score, strict=True)):
                    current["reasons"].append("Score correction prevents reliable stint allocation")
                score = new
                margin.append(
                    dict(
                        period=period,
                        game_clock_s=clock_s,
                        order=order,
                        away=score[0],
                        home=score[1],
                        event_id=row["EVENTNUM"],
                    )
                )
            shot = shot_events.get(row["EVENTNUM"])
            if shot:
                if shot["event_join"]["status"] != "matched":
                    current["reasons"].append("Shot has no verified play-by-play event join")
                current["shot_ids"].append(shot["shot_id"])
                assigned.add(shot["shot_id"])
            j += 1
        finish(0, es[-1][0] + 1)
    missing = [s["shot_id"] for s in shots if s["shot_id"] not in assigned]
    minute_checks, stat_checks = [], []
    for p in box:
        pid = p["player_id"]
        tolerance = boundaries[pid] + 1
        minute_checks.append(
            dict(
                player_id=pid,
                name=p["name"],
                reconstructed_s=raw_minutes[pid],
                gamebook_s=p["seconds"],
                delta_s=raw_minutes[pid] - p["seconds"],
                tolerance_s=tolerance,
                passed=abs(raw_minutes[pid] - p["seconds"]) <= tolerance,
                event_order_score_change=event_plus[pid],
                official_plus_minus=p["official_plus_minus"],
            )
        )
        player_shots = [s for s in shots if s["player_id"] == pid]
        fts = sum(
            int(r["EVENTMSGTYPE"]) == 3
            and r["PLAYER1_ID"] == pid
            and not (r.get("HOMEDESCRIPTION", "") + r.get("VISITORDESCRIPTION", "")).startswith(
                "MISS"
            )
            for r in events
        )
        actual = dict(
            fga=len(player_shots),
            fgm=sum(s["made"] for s in player_shots),
            points=sum(s["shot_value"] * s["made"] for s in player_shots) + fts,
        )
        stat_checks.append(
            dict(
                player_id=pid,
                observed=actual,
                gamebook={k: p[k] for k in actual},
                passed=all(actual[k] == p[k] for k in actual),
            )
        )
    final_box = [sum(p["points"] for p in box if p["team_id"] == tid) for tid in teams]
    if (set(boundaries) | {s["player_id"] for s in shots}) - {p["player_id"] for p in box}:
        failures.append("An active player has no independent gamebook row")
    if score != final_box:
        failures.append("Final recorded score disagrees with official gamebook")
    if missing:
        failures.append("Some audited shots have no ordered source event")
    if not all(c["passed"] for c in minute_checks):
        failures.append("Reconstructed minutes fail independent gamebook constraints")
    if not all(c["passed"] for c in stat_checks):
        failures.append("Player field goals or points disagree with official gamebook")
    for stint in stints:
        if failures:
            stint.update(
                status="unavailable",
                lineups={},
                reasons=list(dict.fromkeys(stint["reasons"] + failures)),
            )
    validation = dict(
        minute_checks=minute_checks,
        stat_checks=stat_checks,
        final_score=score,
        gamebook_score=final_box,
        failures=failures,
        unassigned_shots=missing,
        score_allocation_note="Recorded score changes follow source row order. They can differ "
        "from official player plus-minus around dead-ball substitutions; "
        "no impact rating is inferred.",
    )
    return LineupGame(
        game=game,
        stints=stints,
        substitutions=subs,
        shots=shots,
        possessions=[],
        margin=margin,
        validation=validation,
        box_players=box,
    )


def possession_records(rows: list[dict], bundle: LineupGame) -> None:
    """Collapse exploded DESCRIPTION rows, retaining the provider's whole-record definition."""
    unique = {}
    for row in rows:
        key = tuple((k, v) for k, v in sorted(row.items()) if k not in {"DESCRIPTION", "URL"})
        unique.setdefault(key, row)
    g = bundle.game
    teams = {g["home_team"]: g["home_team_id"], g["away_team"]: g["away_team_id"]}
    records = []
    for key, row in unique.items():
        opponent = teams.get(row["OPPONENT"])
        if opponent is None:
            raise ValueError("Possession opponent does not match game teams")
        tid = next(t for t in teams.values() if t != opponent)
        start, end, period = (
            parse_clock(row["STARTTIME"]),
            parse_clock(row["ENDTIME"]),
            int(row["PERIOD"]),
        )
        if not 0 <= end <= start <= (720 if period <= 4 else 300):
            raise ValueError("Invalid provider possession interval")
        rid = "possession:" + hashlib.sha256(json.dumps(key).encode()).hexdigest()[:24]
        overlap = [
            s
            for s in bundle.stints
            if s.period == period and s.start_clock_s >= end and s.end_clock_s <= start
        ]
        # Strict interior containment avoids inventing event order at a tied sub clock.
        contained = [
            s
            for s in overlap
            if s.status == "available" and start < s.start_clock_s and end > s.end_clock_s
        ]
        records.append(
            dict(
                possession_id=rid,
                team_id=tid,
                period=period,
                start_clock_s=start,
                end_clock_s=end,
                fga=int(row["FG2A"]) + int(row["FG3A"]),
                fgm=int(row["FG2M"]) + int(row["FG3M"]),
                start_type=row["STARTTYPE"],
                description=row["EVENTS"],
                stint_id=contained[0].stint_id if len(contained) == 1 else None,
                overlapping_stints=[s.stint_id for s in overlap],
            )
        )
    records.sort(
        key=lambda r: (r["period"], -r["start_clock_s"], -r["end_clock_s"], r["possession_id"])
    )
    checks = []
    for tid in teams.values():
        source_fga = sum(r["fga"] for r in records if r["team_id"] == tid)
        box_fga = sum(p["fga"] for p in bundle.box_players if p["team_id"] == tid)
        source_fgm = sum(r["fgm"] for r in records if r["team_id"] == tid)
        box_fgm = sum(p["fgm"] for p in bundle.box_players if p["team_id"] == tid)
        checks.append(
            dict(
                team_id=tid,
                provider_fga=source_fga,
                gamebook_fga=box_fga,
                provider_fgm=source_fgm,
                gamebook_fgm=box_fgm,
                passed=source_fga == box_fga and source_fgm == box_fgm,
            )
        )
    coverage = all(c["passed"] for c in checks)
    for stint in bundle.stints:
        stint.possession_ids = [
            r["possession_id"] for r in records if stint.stint_id in r["overlapping_stints"]
        ]
        stint.possession_count = (
            sum(r["stint_id"] == stint.stint_id for r in records)
            if coverage and stint.status == "available"
            else None
        )
    bundle.possessions = records
    bundle.validation["possessions"] = dict(
        source="pbpstats archive",
        source_rows=len(rows),
        unique_records=len(records),
        coverage="reconciled_field_goals" if coverage else "incomplete",
        team_checks=checks,
        reason=None
        if coverage
        else "Provider possession field-goal totals do not reconcile "
        "with the official gamebook. Total possession counts are unavailable.",
        allocation="Only strict interior containment in one available stint; tied/crossing "
        "substitution boundaries remain unallocated. "
        "Linked record counts are not complete possessions.",
    )


def build_lineups(source_database: Path, config: Path, raw: Path, database: Path) -> dict:
    sources = read_manifests(config, raw)
    identity = dict(
        source_database_sha256=sha256(source_database),
        adapter_sha256=sha256(Path(__file__)),
        sources=sources,
        definition=DEFINITION,
        duckdb=duckdb.__version__,
    )
    fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    if database.exists():
        with duckdb.connect(str(database), read_only=True) as con:
            saved = json.loads(con.execute("SELECT payload FROM metadata").fetchone()[0])
            if saved["index_fingerprint"] == fingerprint:
                return {**saved, "cached": True}
    catalog = Catalog(source_database)
    games = catalog.games()
    pbp = next(s for s in sources if s["kind"] == "play_by_play")
    events = selected_csv_rows(raw / pbp["filename"], {g["game_id"] for g in games})
    possession_source = next(s for s in sources if s["kind"] == "possessions")
    possessions = defaultdict(list)
    game_ids = {g["game_id"] for g in games}
    for row in archive_rows(raw / possession_source["filename"]):
        gid = game_id(row["GAMEID"])
        if gid in game_ids:
            possessions[gid].append(row)
    if shutil.which("pdftotext") is None:
        raise FileNotFoundError(
            "Offline gamebook extraction needs Poppler pdftotext (brew install poppler)."
        )
    bundles = []
    for g in games:
        source = next(s for s in sources if s.get("game_id") == g["game_id"])
        text = subprocess.run(
            ["pdftotext", "-layout", str(raw / source["filename"]), "-"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        box = parse_gamebook(text, g)
        bundle = reconstruct(
            g,
            [r for r in events if game_id(r["GAME_ID"]) == g["game_id"]],
            catalog.shots(g["game_id"]),
            box,
        )
        possession_records(possessions[g["game_id"]], bundle)
        bundles.append(bundle)
    meta = dict(
        schema_version=VERSION,
        definition=DEFINITION,
        index_fingerprint=fingerprint,
        source_fingerprint=catalog.health()["source_fingerprint"],
        input_identity=identity,
        games=[
            dict(
                game_id=b.game["game_id"],
                home_team=b.game["home_team"],
                away_team=b.game["away_team"],
                game_date=b.game["game_date"],
                stints=len(b.stints),
                available=sum(s.status == "available" for s in b.stints),
                shots=len(b.shots),
                possession_coverage=b.validation["possessions"]["coverage"],
            )
            for b in bundles
        ],
    )
    database.parent.mkdir(parents=True, exist_ok=True)
    pending = database.with_suffix(".duckdb.part")
    pending.unlink(missing_ok=True)
    with duckdb.connect(str(pending)) as con:
        con.execute("CREATE TABLE metadata (payload VARCHAR)")
        con.execute("INSERT INTO metadata VALUES (?)", [json.dumps(meta)])
        con.execute("CREATE TABLE games (game_id VARCHAR PRIMARY KEY,payload VARCHAR)")
        con.executemany(
            "INSERT INTO games VALUES (?,?)",
            [(b.game["game_id"], b.model_dump_json()) for b in bundles],
        )
    os.replace(pending, database)
    return {**meta, "cached": False}


class Lineups:
    def __init__(self, database: Path, source_database: Path):
        self.database, self.source_database = database, source_database

    def read(self, game: str | None = None):
        if not self.database.exists():
            raise FileNotFoundError("No lineup context. Run make lineup-fetch and make lineups.")
        with duckdb.connect(str(self.database), read_only=True) as con:
            meta = json.loads(con.execute("SELECT payload FROM metadata").fetchone()[0])
            identity = meta["input_identity"]
            if identity["source_database_sha256"] != sha256(self.source_database) or identity[
                "adapter_sha256"
            ] != sha256(Path(__file__)):
                raise ValueError("Lineup context is stale. Rebuild with make lineups.")
            if game is None:
                return meta
            row = con.execute("SELECT payload FROM games WHERE game_id=?", [game]).fetchone()
            if row is None:
                raise KeyError("Lineup game not found")
            return dict(bundle=LineupGame.model_validate_json(row[0]).model_dump(), metadata=meta)
