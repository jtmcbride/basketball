import { describe, expect, it } from "vitest";
import fixture from "../../../../tests/fixtures/m5-lineups.json";
import { elapsed, parseBundle, parseModel, stintShots } from "./model";
import type { LineupBundle, ModelReport } from "./model";

const bundle = () => structuredClone(fixture.bundle) as LineupBundle;
describe("lineup source contracts", () => {
  it("links tied-clock shots by event ownership and separates team filters", () => {
    const b = parseBundle(bundle());
    expect(stintShots(b, b.stints[0], "10").map((s) => s.shot_id)).toEqual([
      fixture.truth.before_sub_shot,
    ]);
    expect(stintShots(b, b.stints[0], "20")).toEqual([]);
    expect(stintShots(b, b.stints[1], "10")[0].shot_id).toEqual(
      fixture.truth.after_sub_shot,
    );
    expect(elapsed(5, 300)).toBe(2880);
    expect(elapsed(5, 0)).toBe(3180);
  });
  it("rejects stale roster geometry and withholds unresolved stints", () => {
    const b = bundle();
    b.stints[0].lineups["10"][0] = "201";
    expect(() => parseBundle(b)).toThrow(/roster/);
    const unavailable = bundle();
    unavailable.stints[0].status = "unavailable";
    unavailable.stints[0].lineups = {};
    unavailable.stints[0].reasons = ["Unresolved period starters"];
    expect(
      stintShots(parseBundle(unavailable), unavailable.stints[0], "10"),
    ).toEqual([]);
  });
  it("rejects reversed durations, unknown attempts and hidden stale groups", () => {
    for (const change of [
      (b: LineupBundle) => {
        b.stints[0].duration_s = -1;
      },
      (b: LineupBundle) => {
        b.stints[0].shot_ids.push("unknown");
      },
      (b: LineupBundle) => {
        b.stints[0].status = "unavailable";
      },
    ]) {
      const b = bundle();
      change(b);
      expect(() => parseBundle(b)).toThrow();
    }
  });
  it("rejects model split leakage and invalid probabilities", () => {
    const model = structuredClone(fixture.model) as ModelReport;
    expect(parseModel(model).status).toBe("evaluation_only");
    model.split.test.games.push(model.split.train.games[0]);
    expect(() => parseModel(model)).toThrow(/overlap/);
    const invalid = structuredClone(fixture.model) as ModelReport;
    invalid.cells[0].probability = NaN;
    expect(() => parseModel(invalid)).toThrow(/probability/);
  });
});
