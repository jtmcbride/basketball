"""Versioned boundary models. Tracking segments do not imply possessions."""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

REPLAY_VERSION = "basketball-replay-v1"
AUDIT_VERSION = "basketball-audit-v1"
PIPELINE_VERSION = "m0-v1"

JoinStatus = Literal["matched", "ambiguous", "unmatched", "unavailable"]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Finding(Contract):
    code: str
    severity: Literal["info", "warning", "error"]
    count: int = Field(ge=0)
    description: str


class Entity(Contract):
    entity_id: str
    team_id: str | None
    kind: Literal["player", "ball"]
    x_ft: float
    y_ft: float
    z_ft: float | None


class Frame(Contract):
    frame_id: str
    period: int = Field(ge=1)
    source_timestamp_ms: int
    elapsed_s: float = Field(ge=0)
    game_clock_s: float = Field(ge=0)
    shot_clock_s: float | None
    break_before: bool
    timestamp_conflict: bool
    quality_flags: list[str]
    source_moment_indices: list[int] = Field(min_length=1)
    entities: list[Entity]


class Join(Contract):
    status: JoinStatus
    method: str
    reason: str | None = None
    segment_id: str | None = None
    clock_delta_s: float | None = None
    timing_confidence: Literal["event_clock_only", "unavailable"] = "unavailable"
    window_continuity: Literal["continuous", "partial"] | None = None


class EventJoin(Contract):
    status: JoinStatus
    method: str
    reason: str | None


class Shot(Contract):
    shot_id: str
    duplicate_source_key: bool
    game_id: str = Field(pattern=r"^\d{10}$")
    source_game_id: str
    source_event_id: str
    player_id: str
    player_name: str
    team_id: str
    period: int = Field(ge=1)
    game_clock_s: float = Field(ge=0)
    made: bool
    action_type: str
    shot_value: Literal[2, 3]
    loc_x: float
    loc_y: float
    lateral_ft: float
    forward_ft: float
    recorded_distance_ft: float = Field(ge=0)
    event_join: EventJoin
    tracking_join: Join


class SourceEvent(Contract):
    game_id: str = Field(pattern=r"^\d{10}$")
    source_game_id: str
    event_id: str
    source_event_id: str
    period: int = Field(ge=1)
    game_clock_s: float = Field(ge=0)
    event_type: int
    player_id: str
    team_id: str | None
    description: str
    score: str | None


class Provenance(Contract):
    source_fingerprint: str
    pipeline_version: str
    sources: list[dict]
    coordinate_system: Literal["sportvu_source_court_feet"] = "sportvu_source_court_feet"
    attacking_direction: Literal["unavailable"] = "unavailable"
    time_basis: Literal["source_timestamp_ms"] = "source_timestamp_ms"
    nominal_hz: int = 25
    release_timing: Literal["unavailable"] = "unavailable"
    redistribution: Literal["not_established"] = "not_established"


class ReplayBundle(Contract):
    schema_version: Literal["basketball-replay-v1"] = REPLAY_VERSION
    game_id: str
    segment_id: str
    source_event_id: str
    segment_kind: Literal["source_event_window"] = "source_event_window"
    continuity: Literal["continuous", "partial"]
    ordering_policy: Literal["timestamp_with_source_indices"] = "timestamp_with_source_indices"
    quality_findings: list[Finding]
    frames: list[Frame]
    players: list[dict]
    events: list[SourceEvent] = Field(default_factory=list)
    provenance: Provenance

    @field_validator("frames")
    @classmethod
    def ordered_frames(cls, frames: list[Frame]) -> list[Frame]:
        if not frames:
            raise ValueError("A replay must contain observed frames")
        origin = frames[0].source_timestamp_ms
        if frames[0].elapsed_s != 0 or frames[0].break_before:
            raise ValueError("The first observed frame must define elapsed time zero")
        if len({frame.frame_id for frame in frames}) != len(frames):
            raise ValueError("Duplicate frame IDs in replay")
        for frame in frames:
            if abs(frame.elapsed_s - (frame.source_timestamp_ms - origin) / 1000) > 1e-9:
                raise ValueError("Elapsed time must agree with source timestamps")
            if any(index < 0 for index in frame.source_moment_indices):
                raise ValueError("Source moment indices must be nonnegative")
        for previous, current in zip(frames, frames[1:]):
            if current.elapsed_s < previous.elapsed_s:
                raise ValueError("Frames must be in source timestamp order")
            if not math.isfinite(current.elapsed_s):
                raise ValueError("Invalid elapsed time")
        return frames
