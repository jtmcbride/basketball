"""Independent raw CSV count/value/distance oracle for the installed season atlas.

No basketball normalization or aggregation helpers are used by the raw-row oracle.
Outputs aggregate evidence only; individual source records stay in ignored data/.
"""

import csv
import io
import json
import tarfile
from collections import Counter
from pathlib import Path

from bkbdata.atlas import Atlas


def main():
    config = json.loads(Path("config/atlas-sources.json").read_text())
    sources = {s["id"]: s for s in config["sources"]}
    atlas = Atlas(Path("data/db/atlas.duckdb"))
    evidence = []
    for season in config["seasons"]:
        cases = [
            dict(season=season["season"]),
            dict(season=season["season"], player_id="201939"),
            dict(season=season["season"], player_id="2544", shot_value=3),
            dict(season=season["season"], team_id="1610612744", period=1),
            dict(season=season["season"], player_id="203469", period=1, opponent="TOR"),
        ]
        oracles = [dict(n=0, made=0, points=0, distance=Counter()) for _ in cases]
        source = sources[season["shots"]]
        with tarfile.open(Path("data/raw") / source["filename"], "r:xz") as archive:
            member = next(m for m in archive if m.isfile())
            with io.TextIOWrapper(
                archive.extractfile(member), encoding="utf-8-sig", newline=""
            ) as stream:
                for row in csv.DictReader(stream):
                    for filters, oracle in zip(cases, oracles, strict=True):
                        if filters.get("player_id", row["PLAYER_ID"]) != row["PLAYER_ID"]:
                            continue
                        if filters.get("team_id", row["TEAM_ID"]) != row["TEAM_ID"]:
                            continue
                        if filters.get("period", int(row["PERIOD"])) != int(row["PERIOD"]):
                            continue
                        value = 3 if row["SHOT_TYPE"] == "3PT Field Goal" else 2
                        if filters.get("shot_value", value) != value:
                            continue
                        # Cody is a Charlotte player in these seasons, independently identified
                        # by the source TEAM_NAME; opponent TOR is the other matchup participant.
                        if "opponent" in filters and (
                            row["TEAM_NAME"] != "Charlotte Hornets"
                            or "TOR" not in (row["HTM"], row["VTM"])
                        ):
                            continue
                        made = int(row["SHOT_MADE_FLAG"])
                        oracle["n"] += 1
                        oracle["made"] += made
                        oracle["points"] += made * value
                        oracle["distance"][min(50, int(float(row["SHOT_DISTANCE"])) // 5 * 5)] += 1
        for filters, oracle in zip(cases, oracles, strict=True):
            result = atlas.summary(filters)
            for field in ["n", "made", "points"]:
                assert result[field] == oracle[field], (
                    filters,
                    field,
                    result[field],
                    oracle[field],
                )
            histogram = Counter()
            for row in result["histogram"]:
                histogram[row["distance"]] += row["n"]
            assert histogram == oracle["distance"]
            assert sum(b["n"] for b in result["bins"]) == result["n"]
            assert sum(b["made"] for b in result["bins"]) == result["made"]
            assert sum(b["points"] for b in result["bins"]) == result["points"]
            if result["n"]:
                assert abs(sum(b["frequency"] for b in result["bins"]) - 100) < 1e-10
                # Inspect several bins through paginated underlying attempts, including overflow.
                bins = sorted(result["bins"], key=lambda b: b["n"])[:3]
                if any(b["cell"] == "outside" for b in result["bins"]):
                    bins.append(next(b for b in result["bins"] if b["cell"] == "outside"))
                for cell in bins:
                    attempts = []
                    for offset in range(0, cell["n"], 100):
                        page = atlas.attempts(filters, cell["cell"], offset, 100)
                        assert page["total"] == cell["n"]
                        attempts.extend(page["attempts"])
                    assert len(attempts) == cell["n"]
                    assert sum(s["made"] for s in attempts) == cell["made"]
                    assert sum(s["made"] * s["shot_value"] for s in attempts) == cell["points"]
            evidence.append(
                dict(
                    filters=filters,
                    n=result["n"],
                    made=result["made"],
                    points=result["points"],
                    baseline_n=result["baseline"]["n"],
                    bins=len(result["bins"]),
                    raw_oracle_passed=True,
                )
            )
    coverage = atlas.options()["seasons"]
    report = dict(
        version="m2-verification-v1",
        cases=evidence,
        seasons=coverage,
        total_attempts=sum(s["attempts"] for s in coverage),
        total_games=sum(s["games"] for s in coverage),
        checks=(
            "Raw CSV counts, makes, actual field-goal points, distance bins, "
            "bin totals and paginated regions"
        ),
        limitations=[
            "Archive reconciliation is not an official schedule check",
            "Minimum sample rules are display thresholds, not confidence intervals",
        ],
    )
    Path("artifacts/m2-data-verification.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(dict(cases=len(evidence), attempts=report["total_attempts"], passed=True)))


if __name__ == "__main__":
    main()
