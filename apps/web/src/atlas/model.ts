export type Metric =
  | "frequency"
  | "fg_pct"
  | "points_per_attempt"
  | "difference_pp";
export interface Filters {
  season: string;
  player_id: string;
  team_id: string;
  opponent: string;
  period: string;
  shot_value: string;
}
export interface Bin {
  cell: string;
  cx: number | null;
  cy: number | null;
  n: number;
  made: number;
  points: number;
  frequency: number;
  fg_pct: number;
  points_per_attempt: number;
  difference_pp: number | null;
  baseline_n: number;
  baseline_fg_pct: number;
  reliable: boolean;
}
export interface Summary {
  filters: Filters;
  n: number;
  made: number;
  points: number;
  bins: Bin[];
  histogram: { distance: number; cell: string; n: number }[];
  baseline: { n: number; season: string; population: string };
}
export interface Coverage {
  season: string;
  attempts: number;
  games: number;
  teams: number;
  date_min: string;
  date_max: string;
  event_matched: number;
  pbp_attempts: number;
  pbp_rows: number;
  duplicate_pbp_keys: number;
  pbp_attempts_without_shot: number;
  shots_without_pbp_key: number;
  unknown_opponent: number;
  outside_half_court: number;
  fingerprint: string;
  sources: { id: string; url: string; filename: string; sha256: string }[];
}
export interface Options {
  version: string;
  seasons: Coverage[];
  players: { id: string; name: string; seasons: string[] }[];
  teams: { id: string; name: string }[];
  opponents: string[];
  periods: number[];
}
export interface Attempt {
  shot_id: string;
  game_id: string;
  game_date: string;
  source_event_id: string;
  player_name: string;
  period: number;
  game_clock_s: number;
  made: number;
  shot_value: number;
  action_type: string;
  recorded_distance_ft: number;
  event_matched: number;
  tracking_status: string;
  tracking_reason: string | null;
}
export interface Attempts {
  total: number;
  offset: number;
  attempts: Attempt[];
}
export const metrics: {
  id: Metric;
  label: string;
  unit: string;
  max: number;
}[] = [
  {
    id: "frequency",
    label: "Shot frequency",
    unit: "per 100 attempts",
    max: 0,
  },
  { id: "fg_pct", label: "Field-goal percentage", unit: "% made", max: 100 },
  {
    id: "points_per_attempt",
    label: "Field-goal points / attempt",
    unit: "points / attempt",
    max: 3,
  },
  {
    id: "difference_pp",
    label: "Difference from same-season baseline",
    unit: "percentage points",
    max: 30,
  },
];
export function query(filters: Filters): string {
  return new URLSearchParams(
    Object.entries(filters).filter(([, v]) => v !== "all"),
  ).toString();
}
export function scaleMax(metric: Metric, summaries: Summary[]): number {
  return (
    metrics.find((m) => m.id === metric)!.max ||
    Math.max(1, ...summaries.flatMap((s) => s.bins.map((b) => b.frequency)))
  );
}
export function color(
  value: number | null,
  metric: Metric,
  max: number,
): string {
  if (value === null) return "#9ca8ae";
  const t = Math.min(1, Math.abs(value) / max);
  const start = metric === "difference_pp" ? [237, 239, 232] : [224, 234, 236];
  const end =
    metric === "difference_pp" && value < 0 ? [181, 81, 54] : [32, 100, 131];
  return `rgb(${start.map((v, i) => Math.round(v + (end[i] - v) * t)).join(",")})`;
}
export function valueLabel(bin: Bin, metric: Metric): string {
  const v = bin[metric];
  if (v === null || (metric !== "frequency" && !bin.reliable))
    return "Unavailable: sparse sample";
  return `${v.toFixed(metric === "points_per_attempt" ? 2 : 1)} ${metrics.find((m) => m.id === metric)!.unit}`;
}
