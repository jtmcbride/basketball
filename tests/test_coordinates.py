import math

import pytest
from bkbdata.coordinates import rotate_court, shot_basket_feet, shot_on_source_court
from bkbdata.sources import game_id


def test_independent_landmarks_and_tenths_of_feet():
    assert shot_basket_feet(220, 100) == (22, 10)
    assert shot_on_source_court(0, 0, "left", -1) == (5.25, 25)
    assert shot_on_source_court(0, 0, "right", -1) == (88.75, 25)
    assert shot_on_source_court(220 / 10, 10, "left", -1) == (15.25, 3)


def test_rotation_preserves_distance_and_is_involution():
    a, b = (12, 19), (15, 23)
    assert math.dist(a, b) == 5
    assert math.dist(rotate_court(*a), rotate_court(*b)) == 5
    assert rotate_court(*rotate_court(*a)) == a


def test_unknown_orientation_and_nonfinite_coordinates_rejected():
    with pytest.raises(ValueError):
        shot_on_source_court(0, 0, "unknown", -1)
    with pytest.raises(ValueError):
        shot_basket_feet(float("nan"), 0)


def test_game_id_restoration_is_explicit():
    assert game_id("21500492") == "0021500492"
    assert game_id("0021500492") == "0021500492"
    with pytest.raises(ValueError):
        game_id("21500492.0")
