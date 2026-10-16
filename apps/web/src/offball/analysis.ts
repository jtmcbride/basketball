import type { Entity } from "../types";
import {
  analyzeReplay,
  isBreak,
  type Measurement,
  type Snapshot,
} from "../replay/analysis";
import type { BoundSequence } from "./model";

export interface MovementPoint {
  index: number;
  timeMs: number;
  opponent: Measurement;
  ball: Measurement;
  heading: Measurement;
}
export interface MovementSequence extends BoundSequence {
  snapshots: Snapshot[];
  points: MovementPoint[];
  barriers: number[];
  anchorMs: number;
}
const missing = (reason: string): Measurement => ({ value: null, reason });
const measured = (value: number): Measurement => ({ value, reason: null });

/** Heading is source-axis velocity, not attacking direction; five backward samples. */
export function headingAt(
  bound: BoundSequence,
  snapshots: Snapshot[],
  index: number,
): Measurement {
  if (index - bound.sequence.start_index < 4)
    return missing("Needs five consecutive player observations.");
  const points: { t: number; p: Entity }[] = [];
  for (let i = index - 4; i <= index; i++) {
    const p = snapshots[i].entities.get(bound.sequence.player_id);
    if (
      !p ||
      (i > index - 4 &&
        isBreak(bound.bundle.frames[i - 1], bound.bundle.frames[i]))
    )
      return missing(
        "Heading history crosses missing, conflicting or discontinuous tracking.",
      );
    points.push({
      t:
        (bound.bundle.frames[i].source_timestamp_ms -
          bound.bundle.frames[index].source_timestamp_ms) /
        1000,
      p,
    });
  }
  const meanT = points.reduce((sum, p) => sum + p.t, 0) / 5;
  const meanX = points.reduce((sum, p) => sum + p.p.x_ft, 0) / 5;
  const meanY = points.reduce((sum, p) => sum + p.p.y_ft, 0) / 5;
  const denominator = points.reduce((sum, p) => sum + (p.t - meanT) ** 2, 0);
  if (denominator <= 0) return missing("Distinct sample timestamps required.");
  const vx =
    points.reduce((sum, p) => sum + (p.t - meanT) * (p.p.x_ft - meanX), 0) /
    denominator;
  const vy =
    points.reduce((sum, p) => sum + (p.t - meanT) * (p.p.y_ft - meanY), 0) /
    denominator;
  if (Math.hypot(vx, vy) < 1)
    return missing(
      "Heading withheld below 1 ft/s; direction is unstable near rest.",
    );
  return measured((Math.atan2(vy, vx) * 180) / Math.PI);
}
export function analyzeMovement(bound: BoundSequence): MovementSequence {
  const snapshots = analyzeReplay(bound.bundle, "nearer");
  const anchorMs =
    bound.bundle.frames[bound.annotation.anchor_index].source_timestamp_ms;
  const points: MovementPoint[] = [];
  const barriers: number[] = [];
  for (let i = bound.sequence.start_index; i <= bound.sequence.end_index; i++) {
    const frame = bound.bundle.frames[i],
      snapshot = snapshots[i],
      player = snapshot.entities.get(bound.sequence.player_id),
      ball = snapshot.entities.get("ball");
    const timeMs = frame.source_timestamp_ms - anchorMs;
    points.push({
      index: i,
      timeMs,
      opponent:
        snapshot.players.get(bound.sequence.player_id)?.defender ??
        missing("Selected player unavailable."),
      ball:
        player && ball
          ? measured(
              Math.hypot(player.x_ft - ball.x_ft, player.y_ft - ball.y_ft),
            )
          : missing("Player or ball observation unavailable."),
      heading: headingAt(bound, snapshots, i),
    });
    if (
      i > bound.sequence.start_index &&
      isBreak(bound.bundle.frames[i - 1], frame)
    ) {
      const previous =
        bound.bundle.frames[i - 1].source_timestamp_ms - anchorMs;
      barriers.push(Math.min(timeMs, previous + 45));
    }
  }
  return { ...bound, snapshots, points, barriers, anchorMs };
}
/** Last observed sample, less than 45 ms old. No interpolation or stale positions across gaps. */
export function sampleAt(
  sequence: MovementSequence,
  timeMs: number,
): MovementPoint | null {
  const points = sequence.points;
  if (
    !points.length ||
    timeMs < points[0].timeMs ||
    timeMs > points.at(-1)!.timeMs
  )
    return null;
  let low = 0,
    high = points.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (points[mid].timeMs <= timeMs) low = mid;
    else high = mid - 1;
  }
  return timeMs - points[low].timeMs < 45 ? points[low] : null;
}
export function observedTimes(
  sequences: MovementSequence[],
  start: number,
  end: number,
): number[] {
  return [
    ...new Set(
      sequences
        .flatMap((s) => s.points.map((p) => p.timeMs))
        .filter((t) => t >= start && t <= end),
    ),
  ].sort((a, b) => a - b);
}
export function nextTime(
  times: number[],
  current: number,
  direction: 1 | -1,
): number {
  return direction === 1
    ? (times.find((t) => t > current) ?? current)
    : ([...times].reverse().find((t) => t < current) ?? current);
}
export function advanceComparison(
  current: number,
  target: number,
  barriers: number[],
  end: number,
) {
  const barrier = barriers.find((t) => t > current && t <= target);
  return {
    time: barrier ?? Math.min(target, end),
    pausedAtBreak: barrier !== undefined,
    ended: target >= end,
  };
}
export const signedSeconds = (ms: number) =>
  `${ms > 0 ? "+" : ""}${(ms / 1000).toFixed(2)} s`;
