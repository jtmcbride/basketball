import { describe, it, expect } from "vitest";
import fixture from "../../../../tests/fixtures/m4-paths.json";
import { parseFeature, rms, scoredPoints, searchParams } from "./model";
import { bindPath, pathFrameAt } from "./PathReplay";
import { parseReplay } from "../replay/contract";
const [a, b, c] = fixture.features.map((f) =>
  parseFeature(f as Parameters<typeof parseFeature>[0]),
);
describe("geometric paths", () => {
  it("matches analytic translated and rotated motion with real sample timing", () => {
    expect(rms(a, b, "start_relative")).toBeCloseTo(
      fixture.truth.translated_shape_rms_ft,
      10,
    );
    expect(rms(a, b, "court_location")).toBeCloseTo(
      fixture.truth.translated_location_rms_ft,
      10,
    );
    expect(rms(a, c, "start_relative")).toBeCloseTo(
      fixture.truth.rotated_shape_rms_ft,
      10,
    );
    expect(a.offsets_ms[1]).toBe(-20);
    expect(a.observed_frames).toBe(51);
    expect(scoredPoints(a, "start_relative")[0]).toEqual({ x: 0, y: 0 });
  });
  it("rejects incomplete features, nonfinite geometry and incorrect target offsets", () => {
    expect(() => parseFeature({ ...a, x_ft: [1] })).toThrow(/incomplete/);
    expect(() =>
      parseFeature({ ...a, x_ft: a.x_ft.map((v, i) => (i === 3 ? NaN : v)) }),
    ).toThrow(/coordinates/);
    expect(() =>
      parseFeature({
        ...a,
        offsets_ms: a.offsets_ms.map((v, i) => (i === 1 ? 21 : v)),
      }),
    ).toThrow(/timing/);
  });
  it("binds every scored coordinate and rejects missing history between samples", () => {
    const bundle = parseReplay(structuredClone(fixture.bundles[0]));
    expect(bindPath(a, bundle)).toEqual({ first: 0, last: 50 });
    bundle.frames[11].entities = bundle.frames[11].entities.filter(
      (e) => e.entity_id !== a.player_id,
    );
    expect(() => bindPath(a, bundle)).toThrow(/history/);
    const changed = parseReplay(structuredClone(fixture.bundles[0]));
    changed.frames[0].entities[0].x_ft += 1;
    expect(() => bindPath(a, changed)).toThrow(/coordinates/);
  });
  it("plays observed source samples without interpolation or stale end positions", () => {
    const bundle = parseReplay(fixture.bundles[0]);
    expect(pathFrameAt(bundle, 0, 50, 0)).toBe(0);
    expect(pathFrameAt(bundle, 0, 50, 19)).toBe(0);
    expect(pathFrameAt(bundle, 0, 50, 40)).toBe(1);
    expect(pathFrameAt(bundle, 0, 50, 2001)).toBeNull();
    bundle.frames[1].source_timestamp_ms += 200;
    expect(pathFrameAt(bundle, 0, 50, 46)).toBeNull();
  });
  it("keeps indexed query identity separate from curated reference/player parameters", () => {
    const base = {
      seedId: "generated-a",
      playerId: "1",
      annotationId: "catch-a",
      featureId: null,
      profile: "start_relative" as const,
      samePlayer: false,
      otherGame: false,
    };
    expect(searchParams(base)).toContain("seed_id=generated-a");
    const indexed = new URLSearchParams(
      searchParams({ ...base, featureId: b.candidate_id }),
    );
    expect(indexed.get("feature_id")).toBe(b.candidate_id);
    expect(indexed.has("seed_id")).toBe(false);
    expect(indexed.has("player_id")).toBe(false);
  });
});
