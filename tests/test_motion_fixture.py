import json
from pathlib import Path

from bkbdata.contracts import ReplayBundle


def test_shared_generated_motion_fixture_is_a_valid_replay():
    fixture = json.loads(Path("tests/fixtures/m1-constant-motion.json").read_text())
    bundle = ReplayBundle.model_validate(fixture["replay"])
    assert len(bundle.frames) == 6
    assert fixture["expected"]["speed_ft_s"] == [None, None, None, None, 5, 5]
    assert all(frame.game_clock_s > 699 for frame in bundle.frames)
    assert bundle.events[0].description == "Generated analytic event"
