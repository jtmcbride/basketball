export type JoinStatus = 'matched' | 'ambiguous' | 'unmatched' | 'unavailable';
export interface TrackingJoin {
  status: JoinStatus;
  reason: string | null;
  segment_id: string | null;
  clock_delta_s: number | null;
  timing_confidence: 'event_clock_only' | 'unavailable';
  window_continuity: 'continuous' | 'partial' | null;
}
export interface Shot {
  shot_id: string;
  game_id: string;
  source_event_id: string;
  player_name: string;
  player_id: string;
  team_id: string;
  period: number;
  game_clock_s: number;
  made: boolean;
  action_type: string;
  lateral_ft: number;
  forward_ft: number;
  shot_value: 2 | 3;
  recorded_distance_ft: number;
  tracking_join: TrackingJoin;
  event_join: { status: JoinStatus; reason: string | null };
}
export interface Game {
  game_id: string;
  game_date: string;
  home_team: string;
  away_team: string;
  home_team_id: string;
  away_team_id: string;
  shots: number;
  unique_frames: number;
  source_event_windows: number;
  continuous_windows: number;
  partial_windows: number;
  empty_windows: number;
  periods: { period: number; unique_frames: number; clock_min_s: number; clock_max_s: number }[];
  joins: { shot_to_event: Partial<Record<JoinStatus, number>>; shot_to_tracking: Partial<Record<JoinStatus, number>> };
  findings: { code: string; count: number; description: string; severity: string }[];
  examples: { shot_id: string; segment_id?: string; continuity?: string }[];
}

export interface Entity {
  entity_id: string;
  team_id: string | null;
  kind: 'player' | 'ball';
  x_ft: number;
  y_ft: number;
  z_ft: number | null;
}
export interface TrackingFrame {
  frame_id: string;
  period: number;
  source_timestamp_ms: number;
  elapsed_s: number;
  game_clock_s: number;
  shot_clock_s: number | null;
  break_before: boolean;
  timestamp_conflict: boolean;
  quality_flags: string[];
  source_moment_indices: number[];
  entities: Entity[];
}
export interface SourceEvent {
  event_id: string;
  source_event_id: string;
  game_id: string;
  period: number;
  game_clock_s: number;
  description: string;
  event_type: number;
}
export interface ReplayBundle {
  schema_version: 'basketball-replay-v1';
  game_id: string;
  segment_id: string;
  source_event_id: string;
  segment_kind: 'source_event_window';
  continuity: 'continuous' | 'partial';
  frames: TrackingFrame[];
  players: { player_id: string; team_id: string; name: string; jersey: string; position: string | null }[];
  events: SourceEvent[];
  quality_findings: { code: string; count: number; description: string; severity: string }[];
  provenance: {
    source_fingerprint: string;
    pipeline_version: string;
    sources: Audit['sources'];
    coordinate_system: 'sportvu_source_court_feet';
    attacking_direction: 'unavailable';
    time_basis: 'source_timestamp_ms';
    nominal_hz: number;
    release_timing: 'unavailable';
  };
}
export interface Audit {
  schema_version: 'basketball-audit-v1';
  source_fingerprint: string;
  games: Game[];
  sources: { id: string; filename: string; url: string; sha256: string; acquired_at: string }[];
  boundaries: { segment_kind: string; possessions_reconstructed: boolean; attacking_direction: string };
}
