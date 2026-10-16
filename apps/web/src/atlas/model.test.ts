import { describe, expect, it } from "vitest";
import { color, query, scaleMax, valueLabel } from "./model";
import type { Bin, Summary } from "./model";
const bin: Bin = {
  cell: "0:0",
  cx: 0,
  cy: 0,
  n: 5,
  made: 3,
  points: 7,
  frequency: 10,
  fg_pct: 60,
  points_per_attempt: 1.4,
  difference_pp: null,
  baseline_n: 20,
  baseline_fg_pct: 50,
  reliable: false,
};
describe("atlas display semantics", () => {
  it("encodes shared filters without leaking all into typed API fields", () => {
    expect(
      query({
        season: "2015-16",
        player_id: "all",
        team_id: "all",
        opponent: "GSW",
        period: "all",
        shot_value: "3",
      }),
    ).toBe("season=2015-16&opponent=GSW&shot_value=3");
  });
  it("uses absolute efficiency scales and one shared frequency scale", () => {
    const summaries = [
      { bins: [bin] },
      { bins: [{ ...bin, frequency: 20 }] },
    ] as Summary[];
    expect(scaleMax("frequency", summaries)).toBe(20);
    expect(scaleMax("fg_pct", summaries)).toBe(100);
    expect(scaleMax("points_per_attempt", summaries)).toBe(3);
    expect(scaleMax("difference_pp", summaries)).toBe(30);
    expect(color(200, "fg_pct", 100)).toBe(color(100, "fg_pct", 100));
  });
  it("withholds sparse efficiency while preserving observed frequency", () => {
    expect(valueLabel(bin, "fg_pct")).toMatch(/Unavailable/);
    expect(valueLabel(bin, "frequency")).toBe("10.0 per 100 attempts");
    expect(valueLabel({ ...bin, reliable: true }, "difference_pp")).toMatch(
      /Unavailable/,
    );
    expect(valueLabel({ ...bin, reliable: true }, "points_per_attempt")).toBe(
      "1.40 points / attempt",
    );
  });
});
