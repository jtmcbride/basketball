import copy

from bkbdata.tracking import normalize_tracking
from conftest import moment


def test_overlap_deduplicates_but_retains_membership(tracking_game, tmp_path):
    game, segments, references, result = normalize_tracking(
        tracking_game, tmp_path / "frames.jsonl"
    )
    assert game["unique_frames"] == 4
    assert len(references) == 6
    assert result["diagnostics"]["counts"]["duplicate_moments"] == 2
    assert [s["continuity"] for s in segments] == ["continuous", "partial"]
    assert segments[1]["entity_problem_frames"] == 1
    assert segments[1]["discontinuities"] == 1


def test_conflicting_timestamp_keeps_both_observations(tracking_game, tmp_path):
    tracking_game["events"][1]["moments"][0][5][0][2] = 30.0
    game, segments, _, result = normalize_tracking(tracking_game, tmp_path / "frames.jsonl")
    assert game["unique_frames"] == 5
    assert result["diagnostics"]["counts"]["timestamp_conflict_keys"] == 1
    assert sum(f["timestamp_conflict"] for f in result["frames"].values()) == 2
    assert all(s["continuity"] == "partial" for s in segments)


def test_stopped_game_clock_does_not_stop_elapsed_time(tracking_game, tmp_path):
    event = tracking_game["events"][0]
    event["moments"] = [moment(1000000, 700), moment(1000040, 700), moment(1000080, 700)]
    tracking_game["events"] = [event]
    _, segments, _, result = normalize_tracking(tracking_game, tmp_path / "frames.jsonl")
    assert segments[0]["continuity"] == "continuous"
    assert result["diagnostics"]["counts"]["stopped_clock_steps"] == 2


def test_clock_reset_and_nonfinite_positions_are_partial(tracking_game, tmp_path):
    data = copy.deepcopy(tracking_game)
    data["events"][0]["moments"][1][2] = 710
    data["events"][1]["moments"][0][5][0][2] = float("nan")
    _, segments, _, result = normalize_tracking(data, tmp_path / "frames.jsonl")
    assert segments[0]["continuity"] == "partial"
    assert result["diagnostics"]["counts"]["malformed_moments"] == 1


def test_entity_order_does_not_create_false_conflict(tracking_game, tmp_path):
    tracking_game["events"][1]["moments"][0][5].reverse()
    _, _, _, result = normalize_tracking(tracking_game, tmp_path / "frames.jsonl")
    assert result["diagnostics"]["counts"]["timestamp_conflict_keys"] == 0
