import copy

from bkbdata.joins import link_shots, normalize_events, normalize_shots
from bkbdata.tracking import normalize_tracking
from conftest import event_row, shot_row


def joined(tracking_game, tmp_path, shots=None, events=None):
    _, segments, _, tracking = normalize_tracking(tracking_game, tmp_path / "frames.jsonl")
    shots = normalize_shots(shots or [shot_row()])
    events = normalize_events(events or [event_row()])
    report = link_shots(shots, events, segments, tracking["frames"])
    return shots, report


def test_verified_id_requires_player_period_result_and_clock(tracking_game, tmp_path):
    shots, report = joined(tracking_game, tmp_path)
    assert report["shot_to_event"] == {"matched": 1}
    assert shots[0]["tracking_join"]["status"] == "matched"
    for mutation in (
        {"PLAYER1_ID": "2"},
        {"PERIOD": "2"},
        {"EVENTMSGTYPE": "2"},
        {"PCTIMESTRING": "10:00"},
        {"PLAYER1_TEAM_ID": "200"},
    ):
        shots, _ = joined(tracking_game, tmp_path, events=[event_row(**mutation)])
        assert shots[0]["event_join"]["status"] == "unmatched"
        assert shots[0]["tracking_join"]["status"] == "unavailable"


def test_duplicate_event_and_shot_ids_are_ambiguous(tracking_game, tmp_path):
    shots, _ = joined(tracking_game, tmp_path, events=[event_row(), event_row()])
    assert shots[0]["event_join"]["status"] == "ambiguous"
    shots, _ = joined(tracking_game, tmp_path, shots=[shot_row(), shot_row()])
    assert shots[0]["event_join"]["status"] == "ambiguous"
    assert shots[0]["shot_id"] != shots[1]["shot_id"]


def test_tracking_clock_disagreement_does_not_get_silently_repaired(tracking_game, tmp_path):
    shots, _ = joined(
        tracking_game,
        tmp_path,
        shots=[shot_row(SECONDS_REMAINING="20")],
        events=[event_row(PCTIMESTRING="11:20")],
    )
    assert shots[0]["event_join"]["status"] == "matched"
    assert shots[0]["tracking_join"]["status"] == "unmatched"
    assert shots[0]["tracking_join"]["segment_id"] is None


def test_duplicate_tracking_window_id_is_ambiguous(tracking_game, tmp_path):
    tracking_game["events"].append(copy.deepcopy(tracking_game["events"][0]))
    shots, _ = joined(tracking_game, tmp_path)
    assert shots[0]["tracking_join"]["status"] == "ambiguous"
