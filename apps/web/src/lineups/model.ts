import type { Game, Shot } from "../types";

export interface Stint {
  stint_id: string;
  period: number;
  start_clock_s: number;
  end_clock_s: number;
  duration_s: number;
  start_order: number;
  end_order: number;
  status: "available" | "unavailable";
  reasons: string[];
  lineups: Record<string, string[]>;
  score_start: number[];
  score_end: number[];
  shot_ids: string[];
  substitution_ids: string[];
  possession_ids: string[];
  possession_count: number | null;
}
export interface Options {
  schema_version: string;
  source_fingerprint: string;
  index_fingerprint: string;
  games: {
    game_id: string;
    home_team: string;
    away_team: string;
    game_date: string;
    stints: number;
    available: number;
    shots: number;
    possession_coverage: string;
  }[];
  input_identity: { sources: { id: string; url: string; sha256: string }[] };
}
export interface LineupBundle {
  schema_version: string;
  game: Game & {
    players: {
      player_id: string;
      name: string;
      team_id: string;
      jersey: string;
    }[];
  };
  stints: Stint[];
  substitutions: {
    event_id: string;
    period: number;
    game_clock_s: number;
    outgoing: string;
    incoming: string;
    team_id: string;
  }[];
  shots: Shot[];
  possessions: {
    possession_id: string;
    team_id: string;
    period: number;
    start_clock_s: number;
    end_clock_s: number;
    fga: number;
    description: string;
    start_type: string;
    stint_id: string | null;
    overlapping_stints: string[];
  }[];
  margin: {
    period: number;
    game_clock_s: number;
    order: number;
    away: number;
    home: number;
  }[];
  validation: {
    failures: string[];
    minute_checks: {
      player_id: string;
      name: string;
      reconstructed_s: number;
      gamebook_s: number;
      delta_s: number;
      tolerance_s: number;
      passed: boolean;
      event_order_score_change: number;
      official_plus_minus: number;
    }[];
    stat_checks: { player_id: string; passed: boolean }[];
    final_score: number[];
    gamebook_score: number[];
    score_allocation_note: string;
    possessions: {
      coverage: string;
      reason: string | null;
      source_rows: number;
      unique_records: number;
      allocation: string;
      team_checks: {
        team_id: string;
        provider_fga: number;
        gamebook_fga: number;
        provider_fgm: number;
        gamebook_fgm: number;
        passed: boolean;
      }[];
    };
  };
}
export function parseBundle(value: LineupBundle): LineupBundle {
  if (value.schema_version !== "basketball-lineups-v1" || !value.stints.length)
    throw new Error("Unsupported lineup context. Rebuild with make lineups.");
  const roster = new Map(
    value.game.players.map((p) => [p.player_id, p.team_id]),
  );
  const shots = new Set(value.shots.map((s) => s.shot_id));
  for (const s of value.stints) {
    if (
      !Number.isFinite(s.duration_s) ||
      s.duration_s < 0 ||
      Math.abs(s.duration_s - s.start_clock_s + s.end_clock_s) > 1e-8 ||
      s.end_order < s.start_order ||
      s.shot_ids.some((id) => !shots.has(id))
    )
      throw new Error("Lineup interval or shot binding is inconsistent.");
    if (
      s.status === "available" &&
      ([value.game.away_team_id, value.game.home_team_id].some(
        (team) =>
          s.lineups[team]?.length !== 5 ||
          new Set(s.lineups[team]).size !== 5 ||
          s.lineups[team].some((id) => roster.get(id) !== team),
      ) ||
        s.reasons.length)
    )
      throw new Error("A five-player group disagrees with the source roster.");
    if (
      s.status === "unavailable" &&
      (!s.reasons.length || Object.keys(s.lineups).length)
    )
      throw new Error("Unresolved lineup identities must remain unavailable.");
  }
  return value;
}
export function stintShots(
  bundle: LineupBundle,
  stint: Stint,
  team: string,
): Shot[] {
  if (stint.status !== "available") return [];
  const ids = new Set(stint.shot_ids);
  return bundle.shots.filter((s) => ids.has(s.shot_id) && s.team_id === team);
}
export function periodOffset(period: number) {
  return period <= 4 ? (period - 1) * 720 : 2880 + (period - 5) * 300;
}
export function elapsed(period: number, clock: number) {
  return periodOffset(period) + (period <= 4 ? 720 : 300) - clock;
}
export const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;

export interface ModelReport {
  schema_version: string;
  status: string;
  definition: {
    bootstrap_seed: number;
    unavailable_features: string[];
    features: string[];
  };
  provenance: {
    model_fingerprint: string;
    atlas_source_fingerprint: string;
    source_attempts: number;
    event_unmatched: number;
    outside: number;
  };
  split: Record<
    "train" | "calibration" | "test",
    { games: string[]; first_date: string; last_date: string; attempts: number }
  >;
  training_mean: number;
  metrics: {
    n: number;
    games: number;
    brier: number;
    baseline_brier: number;
    logloss: number;
    baseline_logloss: number;
    ece: number;
    brier_interval: number[];
    brier_difference_interval: number[];
    bootstrap_resamples: number;
    bins: {
      bin: number;
      n: number;
      made: number;
      predicted: number | null;
      observed: number | null;
      observed_interval: (number | null)[];
    }[];
  };
  cells: {
    cell: string;
    cx: number;
    cy: number;
    probability: number;
    raw_probability: number;
    train_n: number;
    calibration_n: number;
    test_n: number;
    fallback: boolean;
  }[];
  limitations: string[];
}
export function parseModel(report: ModelReport): ModelReport {
  if (report.schema_version !== "basketball-location-model-v1")
    throw new Error("Unsupported location model.");
  const sets = Object.values(report.split).map((s) => new Set(s.games));
  if (
    sets.some((s, i) =>
      sets.some((other, j) => i !== j && [...s].some((g) => other.has(g))),
    )
  )
    throw new Error("Model evaluation games overlap the fitting games.");
  if (
    report.cells.some(
      (c) =>
        !Number.isFinite(c.probability) ||
        c.probability < 0 ||
        c.probability > 1,
    )
  )
    throw new Error("Invalid modeled probability.");
  return report;
}
