import { describe, expect, it } from "vitest";
import { combine, linkMatrix, parseSummary, ramp, share } from "./model";
import type { AssistSummary } from "./model";

const filters = {
  season: "2015-16",
  team_id: "10",
  player_id: null,
  role: "shooter" as const,
};
const summary = (): AssistSummary => ({
  schema_version: "basketball-assists-v1",
  filters,
  cells: [
    {
      cell: "0:0",
      cx: 0,
      cy: 0,
      makes: 12,
      assisted: 6,
      reliable: true,
      share: 0.5,
      per_100: 100,
      league_makes: 13,
      league_share: 7 / 13,
    },
  ],
  totals: [
    { shot_value: 2, makes: 13, assisted: 6 },
    { shot_value: 3, makes: 6, assisted: 6 },
  ],
  league: [],
  players: [],
  network: {
    players: [],
    links: [
      { passer_id: "1", shooter_id: "2", makes: 4 },
      { passer_id: "2", shooter_id: "1", makes: 6 },
    ],
    outside_core: 0,
  },
  partners: null,
  unverified_team_makes: 0,
  fingerprint: "f",
});

describe("assist summary contract", () => {
  it("accepts a reconciled summary for the requested selection", () => {
    expect(parseSummary(summary(), filters).cells).toHaveLength(1);
  });
  it("rejects stale selections and impossible counts", () => {
    expect(() =>
      parseSummary(summary(), { ...filters, team_id: "20" }),
    ).toThrow(/selection/);
    const over = summary();
    over.cells[0].assisted = 13;
    expect(() => parseSummary(over, filters)).toThrow(/reconcile/);
    const extra = summary();
    extra.cells[0].makes = 40;
    expect(() => parseSummary(extra, filters)).toThrow(/reconcile/);
  });
});

describe("assist helpers", () => {
  it("shares are of makes, never attempts, and absent without makes", () => {
    expect(combine(summary().totals)).toEqual({ makes: 19, assisted: 12 });
    expect(share({ makes: 19, assisted: 12 })).toBeCloseTo(12 / 19);
    expect(share({ makes: 0, assisted: 0 })).toBeNull();
    expect(share(undefined)).toBeNull();
  });
  it("reads directed passer-to-shooter counts", () => {
    const m = linkMatrix(summary().network);
    expect(m.at("1", "2")).toBe(4);
    expect(m.at("2", "1")).toBe(6);
    expect(m.at("1", "1")).toBe(0);
    expect(m.max).toBe(6);
  });
  it("clamps the sequential ramp and greys unavailable values", () => {
    expect(ramp(0)).toBe("rgb(224,234,236)");
    expect(ramp(2)).toBe(ramp(1));
    expect(ramp(null)).toBe("#9ca8ae");
  });
});
