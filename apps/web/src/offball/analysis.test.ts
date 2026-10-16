import { describe, expect, it } from "vitest";
import fixture from "../../../../tests/fixtures/m3-annotated-motion.json";
import { parseReplay } from "../replay/contract";
import type { AnnotationSet } from "./model";
import { bindClient } from "./model";
import {
  advanceComparison,
  analyzeMovement,
  nextTime,
  observedTimes,
  sampleAt,
} from "./analysis";
const collection = fixture.index as AnnotationSet;
function movements() {
  return fixture.bundles.map((b, i) =>
    analyzeMovement(
      bindClient(
        collection,
        collection.sequences[i],
        parseReplay(structuredClone(b)),
        collection.sequences[i].default_anchor_id,
      ),
    ),
  );
}
describe("source-aligned movement", () => {
  it("aligns annotations without normalizing duration or using game clocks as time", () => {
    const [a, b] = movements();
    expect(sampleAt(a, 0)?.index).toBe(50);
    expect(sampleAt(b, 0)?.index).toBe(60);
    expect(sampleAt(a, -1000)?.index).toBe(25);
    expect(sampleAt(b, -1000)?.index).toBe(35);
    expect(sampleAt(a, 2000)).toBeNull();
    expect(sampleAt(b, 1600)).toBeNull();
    expect(a.points[0].timeMs).toBe(-2000);
    expect(b.points[0].timeMs).toBe(-2400);
  });
  it("matches independent 3-4-5 heading truth and source distances", () => {
    const a = movements()[0];
    expect(sampleAt(a, 0)!.heading.value).toBeCloseTo(
      fixture.truth.heading_degrees,
      10,
    );
    expect(a.points.slice(0, 4).every((p) => p.heading.value === null)).toBe(
      true,
    );
    expect(sampleAt(a, 0)!.ball.value).toBeCloseTo(0.8, 10);
    expect(sampleAt(a, 0)!.opponent.value).toBeGreaterThan(0);
  });
  it("never interpolates and discloses last-observation sample offsets", () => {
    const a = movements()[0];
    expect(sampleAt(a, 19)!.timeMs).toBe(0);
    expect(sampleAt(a, 39)!.index).toBe(50);
    a.points = a.points.filter((p) => p.index < 51 || p.index > 60);
    expect(sampleAt(a, 45)).toBeNull();
    expect(sampleAt(a, 46)).toBeNull();
    expect(sampleAt(a, 300)).toBeNull();
    expect(sampleAt(a, 440)?.index).toBe(61);
  });
  it("withholds ball and heading at identity gaps, conflicts, and near rest", () => {
    const b = parseReplay(structuredClone(fixture.bundles[0]));
    b.frames[50].entities = b.frames[50].entities.filter(
      (e) => e.kind !== "ball",
    );
    b.frames[51].timestamp_conflict = true;
    const bound = bindClient(collection, collection.sequences[0], b, "catch-a");
    const a = analyzeMovement(bound);
    expect(sampleAt(a, 0)!.ball.value).toBeNull();
    expect(sampleAt(a, 40)!.opponent.value).toBeNull();
    expect(sampleAt(a, 80)!.heading.value).toBeNull();
    for (let i = 40; i < 60; i++) {
      const p = b.frames[i].entities.find((e) => e.entity_id === "1")!;
      p.x_ft = 20;
      p.y_ft = 20;
    }
    const stationary = analyzeMovement(bound);
    expect(sampleAt(stationary, -80)!.heading.value).toBeNull();
  });
  it("rejects changed sources and invalid annotation indices", () => {
    const b = parseReplay(structuredClone(fixture.bundles[0]));
    b.provenance.source_fingerprint = "wrong";
    expect(() =>
      bindClient(collection, collection.sequences[0], b, "catch-a"),
    ).toThrow(/source/);
    const seq = structuredClone(collection.sequences[0]);
    seq.annotations[0].anchor_index = 51;
    expect(() =>
      bindClient(collection, seq, parseReplay(fixture.bundles[0]), "catch-a"),
    ).toThrow(/reference/);
  });
  it("steps recorded relative times and pauses at the first gap on slow ticks", () => {
    const times = observedTimes(movements(), -1000, 1000);
    expect(nextTime(times, 0, 1)).toBe(40);
    expect(nextTime(times, 0, -1)).toBe(-40);
    expect(advanceComparison(0, 500, [45, 100, 200], 1000)).toEqual({
      time: 45,
      pausedAtBreak: true,
      ended: false,
    });
    expect(advanceComparison(45, 500, [45, 100, 200], 1000).time).toBe(100);
    expect(advanceComparison(500, 1200, [], 1000)).toEqual({
      time: 1000,
      pausedAtBreak: false,
      ended: true,
    });
  });
});
