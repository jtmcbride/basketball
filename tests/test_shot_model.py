import copy
import json
import math
from pathlib import Path

import pytest
from bkbdata.shot_model import calibrate, evaluate, fit_isotonic, fit_report, split_date

F = json.loads(Path("tests/fixtures/m5-lineups.json").read_text())


def test_temporal_boundaries_keep_whole_games_in_one_split():
    assert [split_date(d) for d in ["20151130", "20151201", "20151231", "20160101"]] == [
        "train",
        "calibration",
        "calibration",
        "test",
    ]
    rows = copy.deepcopy(F["model_rows"])
    rows[-1]["game_id"] = rows[0]["game_id"]
    with pytest.raises(ValueError, match="multiple dates"):
        fit_report(rows, {})


def test_isotonic_weighted_pooling_and_extrapolation_have_known_solution():
    blocks = fit_isotonic([(0.2, 8, 10), (0.4, 2, 10), (0.6, 9, 10)])
    assert [b["p"] for b in blocks] == [0.5, 0.9]
    assert blocks[0]["n"] == 20
    assert calibrate(0, blocks) == 0.5 and calibrate(1, blocks) == 0.9
    assert fit_isotonic([(0.4, 0, 5), (0.4, 5, 5)])[0]["p"] == 0.5


def test_test_outcomes_cannot_change_either_fitting_stage():
    a = fit_report(F["model_rows"], {})
    rows = copy.deepcopy(F["model_rows"])
    for r in rows:
        if split_date(r["game_date"]) == "test":
            r["made"] = r["n"] - r["made"]
    b = fit_report(rows, {})
    assert a["training_mean"] == b["training_mean"]
    assert a["isotonic_blocks"] == b["isotonic_blocks"]
    assert [c["probability"] for c in a["cells"]] == [c["probability"] for c in b["cells"]]
    assert a["metrics"]["brier"] != b["metrics"]["brier"]
    assert a["status"] == "evaluation_only"  # insufficient whole games


def test_losses_calibration_and_game_bootstrap_match_direct_observations():
    rows = [dict(game_id="a", cell="x", n=4, made=3), dict(game_id="b", cell="x", n=4, made=1)]
    m = evaluate(rows, {"x": 0.75}, 0.5, bootstrap_count=40)
    outcomes = [1, 1, 1, 0, 1, 0, 0, 0]
    assert m["brier"] == pytest.approx(sum((v - 0.75) ** 2 for v in outcomes) / 8)
    assert m["logloss"] == pytest.approx(-sum(math.log(0.75 if v else 0.25) for v in outcomes) / 8)
    assert m["ece"] == 0.25 and m["baseline_brier"] == 0.25
    assert m["bins"][7]["observed_interval"] == [0.25, 0.75]
    assert m == evaluate(rows, {"x": 0.75}, 0.5, bootstrap_count=40)


def test_unseen_training_cell_falls_back_before_calibration():
    rows = copy.deepcopy(F["model_rows"])
    rows.append(
        dict(game_id="test-game", game_date="20160101", cell="new", cx=1, cy=1, n=1, made=1)
    )
    report = fit_report(rows, {})
    cell = next(c for c in report["cells"] if c["cell"] == "new")
    assert cell["fallback"] and cell["raw_probability"] == report["training_mean"]
