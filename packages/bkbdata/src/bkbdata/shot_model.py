"""Location-only, game-disjoint temporal baseline with held-out calibration.

Fixed hexagons, training-only Beta shrinkage, December isotonic calibration,
January-April evaluation. No lineup, player, action, outcome-derived feature.
"""

from __future__ import annotations

import bisect
import hashlib
import json
import math
import os
import random
from collections import defaultdict
from pathlib import Path

import duckdb

from bkbdata.acquire import sha256

VERSION = "basketball-location-model-v1"
DEFINITION = dict(
    version=VERSION,
    season="2015-16",
    features=["lateral_ft", "forward_ft"],
    spatial_basis="Fixed M2 2.5 ft hexagons; outside half-court excluded",
    train="2015-10-27 through 2015-11-30",
    calibration="2015-12-01 through 2015-12-31",
    test="2016-01-01 through 2016-04-13",
    split_unit="whole games grouped by game date",
    estimator="Training cell (makes + 20 * training mean) / (attempts + 20)",
    calibration_method="Weighted monotone isotonic regression on calibration games only",
    probability_clip=[0.01, 0.99],
    baseline="Training overall FG% constant",
    exclusions=["event-unmatched attempts", "outside fixed half-court", "other seasons"],
    uncertainty="95% percentile intervals from 200 whole-test-game bootstrap resamples",
    bootstrap_seed=20261015,
    gate="At least 100 games/split, test ECE <= .025 and upper 95% Brier difference < 0",
    unavailable_features=["defenders", "fatigue", "passing options", "lineup", "player identity"],
)


def split_date(date: str) -> str:
    return "train" if date < "20151201" else "calibration" if date < "20160101" else "test"


def fit_isotonic(points: list[tuple[float, int, int]]) -> list[dict]:
    """Weighted PAV, grouping equal inputs; output held flat outside calibration range."""
    grouped = defaultdict(lambda: [0, 0])
    for x, made, count in points:
        grouped[x][0] += made
        grouped[x][1] += count
    blocks = []
    for x, (made, count) in sorted(grouped.items()):
        if count <= 0 or not 0 <= made <= count:
            raise ValueError("Invalid calibration counts")
        blocks.append(dict(low=x, high=x, made=made, n=count))
        while len(blocks) >= 2 and blocks[-2]["made"] / blocks[-2]["n"] > (
            blocks[-1]["made"] / blocks[-1]["n"]
        ):
            right, left = blocks.pop(), blocks.pop()
            blocks.append(
                dict(
                    low=left["low"],
                    high=right["high"],
                    made=left["made"] + right["made"],
                    n=left["n"] + right["n"],
                )
            )
    if not blocks:
        raise ValueError("No calibration data")
    return [{**b, "p": min(0.99, max(0.01, b["made"] / b["n"]))} for b in blocks]


def calibrate(p: float, blocks: list[dict]) -> float:
    # Right-boundary step function in gaps; no test-driven smoothing.
    i = bisect.bisect_left([b["high"] for b in blocks], p)
    return blocks[min(i, len(blocks) - 1)]["p"]


def loss(p: float, made: int, n: int) -> tuple[float, float]:
    return (
        made * (1 - p) ** 2 + (n - made) * p**2,
        -made * math.log(p) - (n - made) * math.log1p(-p),
    )


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    a = sorted(values)
    i = (len(a) - 1) * fraction
    low, high = math.floor(i), math.ceil(i)
    return a[low] + (a[high] - a[low]) * (i - low)


def evaluate(
    rows: list[dict], probabilities: dict[str, float], baseline: float, bootstrap_count: int = 200
) -> dict:
    games = defaultdict(
        lambda: dict(n=0, brier=0.0, base=0.0, logloss=0.0, bins=[[0, 0, 0.0] for _ in range(10)])
    )
    for r in rows:
        p = probabilities[r["cell"]]
        n, made = r["n"], r["made"]
        g = games[r["game_id"]]
        g["n"] += n
        brier, logloss = loss(p, made, n)
        g["brier"] += brier
        g["base"] += loss(baseline, made, n)[0]
        g["logloss"] += logloss
        b = g["bins"][min(9, int(p * 10))]
        b[0] += n
        b[1] += made
        b[2] += p * n
    gs = [games[k] for k in sorted(games)]
    if not gs:
        raise ValueError("No held-out evaluation games")
    n = sum(g["n"] for g in gs)
    bins = []
    for i in range(10):
        count = sum(g["bins"][i][0] for g in gs)
        made = sum(g["bins"][i][1] for g in gs)
        predicted = sum(g["bins"][i][2] for g in gs)
        bins.append(
            dict(
                bin=i,
                n=count,
                made=made,
                predicted=predicted / count if count else None,
                observed=made / count if count else None,
            )
        )
    rng = random.Random(DEFINITION["bootstrap_seed"])
    diffs, briers, observed = [], [], [[] for _ in bins]
    for _ in range(bootstrap_count):
        sample = [gs[rng.randrange(len(gs))] for _ in gs]
        denominator = sum(g["n"] for g in sample)
        diffs.append(sum(g["brier"] - g["base"] for g in sample) / denominator)
        briers.append(sum(g["brier"] for g in sample) / denominator)
        for i in range(10):
            count = sum(g["bins"][i][0] for g in sample)
            if count:
                observed[i].append(sum(g["bins"][i][1] for g in sample) / count)
    interval = lambda values: [percentile(values, 0.025), percentile(values, 0.975)]  # noqa: E731
    for i, b in enumerate(bins):
        b["observed_interval"] = interval(observed[i])
    return dict(
        n=n,
        games=len(gs),
        brier=sum(g["brier"] for g in gs) / n,
        baseline_brier=sum(g["base"] for g in gs) / n,
        logloss=sum(g["logloss"] for g in gs) / n,
        baseline_logloss=sum(loss(baseline, r["made"], r["n"])[1] for r in rows) / n,
        brier_interval=interval(briers),
        brier_difference_interval=interval(diffs),
        ece=sum(b["n"] * abs(b["observed"] - b["predicted"]) for b in bins if b["n"]) / n,
        bins=bins,
        bootstrap_resamples=bootstrap_count,
    )


def fit_report(rows: list[dict], provenance: dict) -> dict:
    """Input has cell counts by game. Fit paths never consume the test counts."""
    seen = {}
    splits = {s: [] for s in ("train", "calibration", "test")}
    for row in rows:
        gid, date = row["game_id"], row["game_date"]
        if gid in seen and seen[gid] != date:
            raise ValueError("One game cannot appear on multiple dates/splits")
        seen[gid] = date
        if row["n"] <= 0 or not 0 <= row["made"] <= row["n"]:
            raise ValueError("Invalid outcome counts")
        splits[split_date(date)].append(row)
    if not all(splits.values()):
        raise ValueError("Training, calibration and test games are all required")
    by_cell = {s: defaultdict(lambda: [0, 0]) for s in splits}
    coordinates = {}
    for s, records in splits.items():
        for r in records:
            by_cell[s][r["cell"]][0] += r["made"]
            by_cell[s][r["cell"]][1] += r["n"]
            coordinates[r["cell"]] = (r["cx"], r["cy"])
    train = by_cell["train"]
    mean = sum(v[0] for v in train.values()) / sum(v[1] for v in train.values())
    raw_probability = {
        cell: (train[cell][0] + 20 * mean) / (train[cell][1] + 20) for cell in coordinates
    }
    blocks = fit_isotonic(
        [(raw_probability[r["cell"]], r["made"], r["n"]) for r in splits["calibration"]]
    )
    probabilities = {cell: calibrate(p, blocks) for cell, p in raw_probability.items()}
    metrics = evaluate(splits["test"], probabilities, mean)
    split_info = {
        s: dict(
            games=sorted({r["game_id"] for r in rs}),
            first_date=min(r["game_date"] for r in rs),
            last_date=max(r["game_date"] for r in rs),
            attempts=sum(r["n"] for r in rs),
        )
        for s, rs in splits.items()
    }
    passed = (
        all(len(v["games"]) >= 100 for v in split_info.values())
        and metrics["ece"] <= 0.025
        and metrics["brier_difference_interval"][1] < 0
    )
    return dict(
        schema_version=VERSION,
        definition=DEFINITION,
        provenance=provenance,
        split=split_info,
        training_mean=mean,
        isotonic_blocks=blocks,
        status="held_out_gate_passed" if passed else "evaluation_only",
        metrics=metrics,
        cells=[
            dict(
                cell=c,
                cx=coordinates[c][0],
                cy=coordinates[c][1],
                probability=probabilities[c],
                raw_probability=raw_probability[c],
                train_made=by_cell["train"][c][0],
                train_n=by_cell["train"][c][1],
                calibration_n=by_cell["calibration"][c][1],
                test_n=by_cell["test"][c][1],
                fallback=by_cell["train"][c][1] == 0,
            )
            for c in sorted(coordinates)
        ],
        limitations=[
            "Location only; no defenders, fatigue, player identity or passing options",
            "One historical season; temporal held-out results do not establish modern transfer",
            "Bootstrap intervals describe held-out game variation, "
            "not an individual shot's uncertainty",
            "No movement prediction overlay: two tracking games; no evaluated learned forecast",
        ],
    )


def build_shot_model(atlas_database: Path, output: Path) -> dict:
    identity = dict(
        atlas_sha256=sha256(atlas_database),
        adapter_sha256=sha256(Path(__file__)),
        definition=DEFINITION,
        duckdb=duckdb.__version__,
    )
    fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    if output.exists():
        saved = json.loads(output.read_text())
        if saved["provenance"]["model_fingerprint"] == fingerprint:
            return dict(cached=True, model_fingerprint=fingerprint, status=saved["status"])
    with duckdb.connect(str(atlas_database), read_only=True) as con:
        source = json.loads(con.execute("SELECT value FROM metadata").fetchone()[0])
        result = con.execute(
            "SELECT game_id,game_date,cell,any_value(cx) cx,any_value(cy) cy,"
            "count(*) n,sum(made::INT) made FROM shots WHERE season='2015-16' "
            "AND event_matched AND cell<>'outside' GROUP BY game_id,game_date,cell "
            "ORDER BY game_id,cell"
        )
        names = [c[0] for c in result.description]
        rows = [dict(zip(names, r, strict=True)) for r in result.fetchall()]
        exclusions = con.execute(
            "SELECT count(*),count(*) FILTER(WHERE NOT event_matched),"
            "count(*) FILTER(WHERE cell='outside') FROM shots WHERE season='2015-16'"
        ).fetchone()
    provenance = dict(
        input_identity=identity,
        model_fingerprint=fingerprint,
        atlas_source_fingerprint=hashlib.sha256(
            json.dumps(source, sort_keys=True).encode()
        ).hexdigest(),
        source_attempts=exclusions[0],
        event_unmatched=exclusions[1],
        outside=exclusions[2],
    )
    report = fit_report(rows, provenance)
    output.parent.mkdir(parents=True, exist_ok=True)
    pending = output.with_suffix(".json.part")
    pending.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    os.replace(pending, output)
    return dict(
        cached=False,
        model_fingerprint=fingerprint,
        status=report["status"],
        metrics=report["metrics"],
    )


class ShotModel:
    def __init__(self, path: Path, atlas_database: Path):
        self.path, self.atlas_database = path, atlas_database

    def read(self):
        if not self.path.exists():
            raise FileNotFoundError(
                "No evaluated shot model. Run make shot-model after make atlas."
            )
        data = json.loads(self.path.read_text())
        identity = data["provenance"]["input_identity"]
        if identity["atlas_sha256"] != sha256(self.atlas_database) or identity[
            "adapter_sha256"
        ] != sha256(Path(__file__)):
            raise ValueError("Shot model is stale. Rebuild with make shot-model.")
        return data
