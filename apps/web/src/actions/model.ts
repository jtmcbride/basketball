export type Profile = "start_relative" | "court_location";
export interface PathFeature {
  feature_version: "basketball-path-v1";
  candidate_id: string;
  source_fingerprint: string;
  game_id: string;
  segment_id: string;
  player_id: string;
  player_name: string;
  team_id: string;
  period: number;
  start_clock_s: number;
  end_clock_s: number;
  start_ms: number;
  end_ms: number;
  actual_duration_ms: number;
  observed_frames: number;
  frame_ids: string[];
  timestamps_ms: number[];
  offsets_ms: number[];
  x_ft: number[];
  y_ft: number[];
}
export interface Match extends PathFeature {
  rms_ft: number;
}
export interface Seed {
  sequence: {
    sequence_id: string;
    title: string;
    game_id: string;
    player_id: string;
    default_anchor_id: string;
    annotations: { annotation_id: string; label: string; confidence: string }[];
  };
  status: "available" | "unavailable";
  reason: string | null;
  feature: PathFeature | null;
}
export interface Metadata {
  feature_version: string;
  definition_hash: string;
  index_fingerprint: string;
  source_fingerprint: string;
  candidate_count: number;
  definition: Record<string, unknown>;
  games: { game_id: string; counts: Record<string, number> }[];
  build_seconds: number;
}
export interface Options extends Metadata {
  seeds: Seed[];
  collection: { id: string; revision: number; description: string };
  roster: {
    game_id: string;
    home_team: string;
    away_team: string;
    game_date: string;
    players: {
      player_id: string;
      team_id: string;
      name: string;
      jersey: string;
      position: string | null;
    }[];
  }[];
}
export interface Search {
  status: "available" | "unavailable";
  reason: string | null;
  query: PathFeature | null;
  matches: Match[];
  metadata: Metadata;
  profile: Profile;
  eligible_paths: number;
  overlapping_query_paths_excluded: number;
  result_count: number;
  search_ms: number;
}
export interface SearchState {
  seedId: string;
  playerId: string;
  annotationId: string;
  featureId: string | null;
  profile: Profile;
  samePlayer: boolean;
  otherGame: boolean;
}
export function searchParams(state: SearchState): string {
  const params = new URLSearchParams({
    profile: state.profile,
    same_player: String(state.samePlayer),
    other_game: String(state.otherGame),
    limit: "8",
  });
  if (state.featureId) params.set("feature_id", state.featureId);
  else {
    params.set("seed_id", state.seedId);
    params.set("player_id", state.playerId);
    params.set("annotation_id", state.annotationId);
  }
  return params.toString();
}
export function parseFeature(value: PathFeature): PathFeature {
  if (
    value.feature_version !== "basketball-path-v1" ||
    ![
      value.x_ft,
      value.y_ft,
      value.timestamps_ms,
      value.offsets_ms,
      value.frame_ids,
    ].every((a) => Array.isArray(a) && a.length === 21)
  )
    throw new Error(
      "Unsupported or incomplete path feature. Rebuild the action index.",
    );
  if (
    !value.x_ft.every((v) => Number.isFinite(v) && v >= 0 && v <= 94) ||
    !value.y_ft.every((v) => Number.isFinite(v) && v >= 0 && v <= 50) ||
    value.start_ms !== value.timestamps_ms[0] ||
    value.end_ms !== value.timestamps_ms[20] ||
    Math.abs(value.actual_duration_ms - 2000) > 20 ||
    value.actual_duration_ms !== value.end_ms - value.start_ms ||
    new Set(value.frame_ids).size !== 21 ||
    value.timestamps_ms.some(
      (v, i) =>
        !Number.isSafeInteger(v) ||
        (i > 0 && v <= value.timestamps_ms[i - 1]) ||
        v !== value.end_ms - 2000 + i * 100 + value.offsets_ms[i] ||
        Math.abs(value.offsets_ms[i]) > 20,
    )
  )
    throw new Error(
      "Invalid coordinates or sample timing in this path feature.",
    );
  return value;
}
export function scoredPoints(
  feature: PathFeature,
  profile: Profile,
): { x: number; y: number }[] {
  const x0 = profile === "start_relative" ? feature.x_ft[0] : 0,
    y0 = profile === "start_relative" ? feature.y_ft[0] : 0;
  return feature.x_ft.map((x, i) => ({ x: x - x0, y: feature.y_ft[i] - y0 }));
}
export function pairedDistances(
  query: PathFeature,
  candidate: PathFeature,
  profile: Profile,
): number[] {
  const q = scoredPoints(query, profile),
    c = scoredPoints(candidate, profile);
  return q.map((p, i) => Math.hypot(p.x - c[i].x, p.y - c[i].y));
}
export function rms(
  query: PathFeature,
  candidate: PathFeature,
  profile: Profile,
): number {
  return Math.sqrt(
    pairedDistances(query, candidate, profile).reduce(
      (sum, d) => sum + d * d,
      0,
    ) / 21,
  );
}
