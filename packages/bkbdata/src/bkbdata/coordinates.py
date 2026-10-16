"""Explicit transforms; the source frame never acquires an inferred direction."""

from __future__ import annotations

import math

COURT_LENGTH_FT = 94.0
COURT_WIDTH_FT = 50.0
RIM_OFFSET_FT = 5.25


def shot_basket_feet(loc_x: float, loc_y: float) -> tuple[float, float]:
    """NBA shotchart tenths of feet -> lateral/forward feet relative to rim."""
    if not math.isfinite(loc_x) or not math.isfinite(loc_y):
        raise ValueError("Shot coordinates must be finite")
    return loc_x / 10, loc_y / 10


def rotate_court(x_ft: float, y_ft: float) -> tuple[float, float]:
    """180 degree rigid rotation; use only with an established attacking basket."""
    return COURT_LENGTH_FT - x_ft, COURT_WIDTH_FT - y_ft


def shot_on_source_court(
    lateral_ft: float, forward_ft: float, basket: str, lateral_sign: int
) -> tuple[float, float]:
    """Candidate mapping for an explicit basket and lateral-axis convention.

    The audit evaluates both sign conventions; this never guesses orientation.
    """
    if basket not in {"left", "right"} or lateral_sign not in {-1, 1}:
        raise ValueError("An explicit basket and lateral sign are required")
    left = (RIM_OFFSET_FT + forward_ft, 25 + lateral_sign * lateral_ft)
    return left if basket == "left" else rotate_court(*left)
