import { describe, expect, it } from "vitest";
import { band, filterArcs, median, parseReport } from "./model";
import type { Arc, ArcReport } from "./model";

const arc = (
  id: string,
  made: boolean,
  distance: number,
  game = "g1",
): Arc => ({
  shot_id: id,
  game_id: game,
  segment_id: "s",
  matchup: "A at B",
  player_id: "7",
  player_name: "Generated 7",
  team_id: "10",
  period: 1,
  game_clock_s: 600,
  made,
  shot_value: distance >= 22 ? 3 : 2,
  action_type: "Jump Shot",
  recorded_distance_ft: distance,
  window_continuity: "continuous",
  candidates: 1,
  status: "available",
  rim: "left",
  release_frame_id: `${id}:0`,
  arrival_frame_id: `${id}:1`,
  release_clock_s: 601,
  release_height_ft: 9,
  release_distance_ft: distance,
  apex_height_ft: 14,
  apex_t_ms: 400,
  flight_ms: 920,
  entry_angle_deg: 40,
  rim_crossing_ft: made ? 0.3 : 2,
  samples: [
    {
      frame_id: `${id}:0`,
      t_ms: 0,
      s_ft: distance,
      h_ft: distance,
      z_ft: 9,
      phase: "flight",
    },
    {
      frame_id: `${id}:1`,
      t_ms: 920,
      s_ft: 1.6,
      h_ft: 1.6,
      z_ft: 11,
      phase: "flight",
    },
    {
      frame_id: `${id}:2`,
      t_ms: 960,
      s_ft: 0.8,
      h_ft: 0.8,
      z_ft: 10.2,
      phase: "after",
    },
  ],
});
const report = (): ArcReport => ({
  schema_version: "basketball-arc-v1",
  definition: {},
  coverage: {
    matched_attempts: 3,
    available: 2,
    unavailable: { no_free_flight: 1 },
  },
  height_check: {
    passed: true,
    rule: "",
    made: {
      flights: 1,
      crossings: 1,
      median_ft: 0.3,
      within_1_5_ft: 1,
      values: [0.3],
    },
    missed: {
      flights: 1,
      crossings: 1,
      median_ft: 2,
      within_1_5_ft: 0,
      values: [2],
    },
  },
  arcs: [arc("a", true, 4), arc("b", false, 24, "g2")],
  unavailable: [
    { ...arc("c", true, 0), status: "unavailable", reason: "no_free_flight" },
  ],
  provenance: { arc_fingerprint: "x", source_fingerprint: "y" },
});

describe("recorded ball flight contract", () => {
  it("accepts a reconciled report and rejects unknown versions", () => {
    expect(parseReport(report()).arcs).toHaveLength(2);
    expect(() =>
      parseReport({ ...report(), schema_version: "basketball-arc-v2" }),
    ).toThrow(/unsupported/);
  });
  it("rejects flights whose samples disagree with the declared release or order", () => {
    const moved = report();
    moved.arcs[0].release_frame_id = "elsewhere";
    expect(() => parseReport(moved)).toThrow(/release and arrival/);
    const reordered = report();
    reordered.arcs[0].samples[2].t_ms = 900;
    expect(() => parseReport(reordered)).toThrow(/time order/);
    const duration = report();
    duration.arcs[0].flight_ms = 1000;
    expect(() => parseReport(duration)).toThrow(/release and arrival/);
  });
  it("rejects coverage that hides unavailable attempts", () => {
    const hidden = report();
    hidden.unavailable = [];
    expect(() => parseReport(hidden)).toThrow(/reconcile/);
  });
});

describe("flight filters", () => {
  it("bands shot-chart distances at 10 and 22 ft", () => {
    expect([9.9, 10, 21.9, 22].map(band)).toEqual([
      "close",
      "mid",
      "mid",
      "three",
    ]);
  });
  it("combines result, distance and game filters", () => {
    const arcs = report().arcs;
    expect(
      filterArcs(arcs, "made", "all", "all").map((a) => a.shot_id),
    ).toEqual(["a"]);
    expect(
      filterArcs(arcs, "all", "three", "all").map((a) => a.shot_id),
    ).toEqual(["b"]);
    expect(filterArcs(arcs, "all", "all", "g1").map((a) => a.shot_id)).toEqual([
      "a",
    ]);
    expect(filterArcs(arcs, "missed", "close", "all")).toEqual([]);
  });
  it("takes a median without mutating input", () => {
    const values = [3, 1, 2, 10];
    expect(median(values)).toBe(2.5);
    expect(values).toEqual([3, 1, 2, 10]);
    expect(median([])).toBeNull();
  });
});
