"""Offline source conservation and independent SQL checks for Milestone 5."""

import json
import math
from collections import Counter
from pathlib import Path

import duckdb
from bkbdata.catalog import Catalog
from bkbdata.lineups import Lineups, build_lineups
from bkbdata.shot_model import build_shot_model
from bkbdata.sources import game_id, selected_csv_rows


def main():
    source = Path("data/db/basketball.duckdb")
    index = Lineups(Path("data/db/lineups.duckdb"), source)
    meta = index.read()
    catalog = Catalog(source)
    rows = selected_csv_rows(
        Path("data/raw/nbastats_2015.tar.xz"), {g["game_id"] for g in meta["games"]}
    )
    evidence = dict(
        source_fingerprint=meta["source_fingerprint"],
        lineup_fingerprint=meta["index_fingerprint"],
        games=[],
    )
    for game in meta["games"]:
        gid = game["game_id"]
        bundle = index.read(gid)["bundle"]
        stints = bundle["stints"]
        shots = catalog.shots(gid)
        assert all(s["status"] == "available" for s in stints)
        assert sorted(s["shot_id"] for s in shots) == sorted(
            sid for stint in stints for sid in stint["shot_ids"]
        )
        events = [r for r in rows if game_id(r["GAME_ID"]) == gid]
        subs = [r for r in events if r["EVENTMSGTYPE"] == "8"]
        assert {s["event_id"].rsplit(":", 1)[1] for s in bundle["substitutions"]} == {
            r["EVENTNUM"] for r in subs
        }
        # Every shot must agree with its reconstructed event-order boundary.
        for order, row in enumerate(events):
            owning = [s for s in stints if s["start_order"] <= order < s["end_order"]]
            if row["EVENTMSGTYPE"] in {"1", "2"}:
                assert len(owning) == 1
                pid, tid = row["PLAYER1_ID"], row["PLAYER1_TEAM_ID"]
                assert pid in owning[0]["lineups"][tid]
                shot = next(s for s in shots if s["source_event_id"] == row["EVENTNUM"])
                assert shot["shot_id"] in owning[0]["shot_ids"]
        minutes = Counter()
        for stint in stints:
            assert len(set(pid for ids in stint["lineups"].values() for pid in ids)) == 10
            for ids in stint["lineups"].values():
                for pid in ids:
                    minutes[pid] += stint["start_clock_s"] - stint["end_clock_s"]
        duration = sum(720 if p <= 4 else 300 for p in {s["period"] for s in stints})
        assert sum(s["duration_s"] for s in stints) == duration
        assert sum(minutes.values()) == duration * 10
        for p in bundle["box_players"]:
            check = next(
                c for c in bundle["validation"]["minute_checks"] if c["player_id"] == p["player_id"]
            )
            assert abs(minutes[p["player_id"]] - p["seconds"]) <= check["tolerance_s"]
            player_shots = [s for s in shots if s["player_id"] == p["player_id"]]
            assert len(player_shots) == p["fga"]
            assert sum(s["made"] for s in player_shots) == p["fgm"]
        assert all(c["passed"] for c in bundle["validation"]["stat_checks"])
        coverage = bundle["validation"]["possessions"]
        assert coverage["coverage"] == "incomplete"
        assert all(s["possession_count"] is None for s in stints)
        evidence["games"].append(
            dict(
                game_id=gid,
                stints=len(stints),
                shots=len(shots),
                substitutions=len(subs),
                active_players=len(bundle["box_players"]),
                game_clock_seconds=duration,
                reconstructed_player_seconds=sum(minutes.values()),
                max_gamebook_minute_error_s=max(
                    abs(c["delta_s"]) for c in bundle["validation"]["minute_checks"]
                ),
                final_score=bundle["validation"]["final_score"],
                possession_validation=coverage,
                score_allocation_discrepancies=[
                    dict(
                        player_id=c["player_id"],
                        event_order=c["event_order_score_change"],
                        official=c["official_plus_minus"],
                    )
                    for c in bundle["validation"]["minute_checks"]
                    if c["event_order_score_change"] != c["official_plus_minus"]
                ],
            )
        )
    report = json.loads(Path("data/models/location-v1.json").read_text())
    cells = report["cells"]
    with duckdb.connect("data/db/atlas.duckdb", read_only=True) as con:
        con.execute("CREATE TEMP TABLE predictions(cell VARCHAR, p DOUBLE)")
        con.executemany(
            "INSERT INTO predictions VALUES (?,?)", [(c["cell"], c["probability"]) for c in cells]
        )
        # This per-shot SQL calculation is independent of the Python grouped-loss evaluator.
        n, brier, logloss, base = con.execute(
            "SELECT count(*),avg(pow(s.made::INT-p.p,2)),"
            "avg(CASE WHEN s.made THEN -ln(p.p) ELSE -ln(1-p.p) END),"
            "avg(pow(s.made::INT-?,2)) FROM shots s JOIN predictions p USING(cell) "
            "WHERE s.season='2015-16' AND s.event_matched AND s.cell<>'outside' "
            "AND s.game_date>='20160101'",
            [report["training_mean"]],
        ).fetchone()
        assert n == report["metrics"]["n"]
        for key, value in [("brier", brier), ("logloss", logloss), ("baseline_brier", base)]:
            assert math.isclose(value, report["metrics"][key], abs_tol=1e-12)
        split_ids = {}
        for split, clause in [
            ("train", "game_date<'20151201'"),
            ("calibration", "game_date>='20151201' AND game_date<'20160101'"),
            ("test", "game_date>='20160101'"),
        ]:
            ids = [
                r[0]
                for r in con.execute(
                    "SELECT DISTINCT game_id FROM shots WHERE season='2015-16' AND event_matched "
                    f"AND cell<>'outside' AND {clause} ORDER BY game_id"
                ).fetchall()
            ]
            assert ids == report["split"][split]["games"]
            split_ids[split] = set(ids)
        assert not any(
            split_ids[a] & split_ids[b]
            for a, b in [("train", "test"), ("calibration", "test"), ("train", "calibration")]
        )
    evidence["model"] = dict(
        model_fingerprint=report["provenance"]["model_fingerprint"],
        status=report["status"],
        split={
            k: dict(
                games=len(v["games"]),
                attempts=v["attempts"],
                first_date=v["first_date"],
                last_date=v["last_date"],
            )
            for k, v in report["split"].items()
        },
        metrics=report["metrics"],
        independent_sql=dict(
            n=n, brier=brier, logloss=logloss, baseline_brier=base, tolerance=1e-12
        ),
        limitations=report["limitations"],
    )
    assert build_lineups(
        source, Path("config/lineup-sources.json"), Path("data/raw"), Path("data/db/lineups.duckdb")
    )["cached"]
    assert build_shot_model(Path("data/db/atlas.duckdb"), Path("data/models/location-v1.json"))[
        "cached"
    ]
    evidence["cached_rebuilds_verified"] = True
    evidence["all_checks_passed"] = True
    Path("artifacts/m5-data-verification.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(
        json.dumps(
            dict(
                stints=sum(g["stints"] for g in evidence["games"]),
                shots=sum(g["shots"] for g in evidence["games"]),
                model_test_attempts=n,
                all_checks_passed=True,
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
