import type { TrackingFrame } from '../types';
import { isBreak } from './analysis';

export function frameAtTime(frames: TrackingFrame[], elapsed: number): number {
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (frames[mid].elapsed_s <= elapsed) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Pause at the first observed frame after a break, even on a slow browser tick. */
export function advance(frames: TrackingFrame[], from: number, elapsed: number): {
  index: number; stoppedAtBreak: boolean; ended: boolean;
} {
  const target = frameAtTime(frames, elapsed);
  for (let i = from + 1; i <= target; i++) {
    if (isBreak(frames[i - 1], frames[i])) return { index: i, stoppedAtBreak: true, ended: false };
  }
  if (target + 1 < frames.length && isBreak(frames[target], frames[target + 1])
    && elapsed > frames[target].elapsed_s + 0.045) {
    return { index: target + 1, stoppedAtBreak: true, ended: false };
  }
  return { index: Math.max(from, target), stoppedAtBreak: false, ended: target === frames.length - 1 };
}
