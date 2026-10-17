export interface Sample {
  frame_id: string;
  t_ms: number;
  s_ft: number;
  h_ft: number;
  z_ft: number;
  phase: "flight" | "after";
}
interface AttemptContext {
  shot_id: string;
  game_id: string;
  segment_id: string;
  matchup: string;
  player_id: string;
  player_name: string;
  team_id: string;
  period: number;
  game_clock_s: number;
  made: boolean;
  shot_value: number;
  action_type: string;
  recorded_distance_ft: number;
  window_continuity: string | null;
  candidates: number;
}
export interface Arc extends AttemptContext {
  status: "available";
  rim: "left" | "right";
  release_frame_id: string;
  arrival_frame_id: string;
  release_clock_s: number;
  release_height_ft: number;
  release_distance_ft: number;
  apex_height_ft: number;
  apex_t_ms: number;
  flight_ms: number;
  entry_angle_deg: number | null;
  rim_crossing_ft: number | null;
  samples: Sample[];
}
export interface Unavailable extends AttemptContext {
  status: "unavailable";
  reason: string;
}
interface CheckGroup {
  flights: number;
  crossings: number;
  median_ft: number | null;
  within_1_5_ft: number;
  values: number[];
}
export interface ArcReport {
  schema_version: string;
  definition: Record<string, string | string[]>;
  coverage: {
    matched_attempts: number;
    available: number;
    unavailable: Record<string, number>;
  };
  height_check: {
    passed: boolean;
    rule: string;
    made: CheckGroup;
    missed: CheckGroup;
  };
  arcs: Arc[];
  unavailable: Unavailable[];
  provenance: { arc_fingerprint: string; source_fingerprint: string };
}

export const REASONS: Record<string, string> = {
  no_rim_arrival: "Ball never observed at a rim near the event clock",
  no_free_flight:
    "Ball stayed with the shooter to the rim (dunks, tips, contact layups)",
  interrupted: "Tracking break between release and rim",
  missing_observation: "Ball or shooter missing during the flight",
  low_ball: "Ball below 6 ft during the flight (pass or bounce)",
  implausible_duration: "Flight longer than 2.5 s",
  distance_disagrees:
    "Release distance differs from the shot chart by over 4 ft",
};

export type Band = "all" | "close" | "mid" | "three";
export const BANDS: Record<Band, string> = {
  all: "All distances",
  close: "Under 10 ft",
  mid: "10–21 ft",
  three: "22 ft and beyond",
};
export const band = (feet: number): Exclude<Band, "all"> =>
  feet < 10 ? "close" : feet < 22 ? "mid" : "three";

export type Metric =
  "apex_height_ft" | "entry_angle_deg" | "release_height_ft" | "flight_ms";
export const METRICS: Record<
  Metric,
  { label: string; unit: string; basis: string }
> = {
  apex_height_ft: { label: "Peak height", unit: "ft", basis: "Recorded" },
  entry_angle_deg: { label: "Entry angle", unit: "°", basis: "Derived" },
  release_height_ft: {
    label: "Height at candidate release",
    unit: "ft",
    basis: "Recorded",
  },
  flight_ms: { label: "Flight time", unit: "ms", basis: "Recorded" },
};

export function parseReport(report: ArcReport): ArcReport {
  if (report.schema_version !== "basketball-arc-v1") {
    throw new Error(
      "Ball flights use an unsupported format. Rebuild with make arcs.",
    );
  }
  const ids = new Set<string>();
  for (const arc of report.arcs) {
    if (ids.has(arc.shot_id))
      throw new Error("Duplicate attempt in ball flights");
    ids.add(arc.shot_id);
    const flight = arc.samples.filter((s) => s.phase === "flight");
    if (
      flight.length < 2 ||
      flight[0].t_ms !== 0 ||
      flight[0].frame_id !== arc.release_frame_id ||
      flight[flight.length - 1].frame_id !== arc.arrival_frame_id ||
      flight[flight.length - 1].t_ms !== arc.flight_ms
    ) {
      throw new Error(
        "A ball flight disagrees with its release and arrival frames",
      );
    }
    if (
      arc.samples.some((s, i) => i > 0 && s.t_ms <= arc.samples[i - 1].t_ms)
    ) {
      throw new Error("Ball flight samples must keep recorded time order");
    }
  }
  const unavailable = Object.values(report.coverage.unavailable).reduce(
    (a, b) => a + b,
    0,
  );
  if (
    report.coverage.available !== report.arcs.length ||
    unavailable !== report.unavailable.length ||
    report.coverage.matched_attempts !== report.arcs.length + unavailable
  ) {
    throw new Error("Ball flight coverage does not reconcile");
  }
  return report;
}

export function filterArcs(
  arcs: Arc[],
  result: "all" | "made" | "missed",
  distance: Band,
  gameId: string,
): Arc[] {
  return arcs.filter(
    (a) =>
      (result === "all" || a.made === (result === "made")) &&
      (distance === "all" || band(a.recorded_distance_ft) === distance) &&
      (gameId === "all" || a.game_id === gameId),
  );
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
