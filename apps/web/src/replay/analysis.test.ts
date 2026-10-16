import { describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/m1-constant-motion.json';
import { analyzeReplay, eventMarker, playerMetrics, trailPoints } from './analysis';
import { parseReplay } from './contract';
import { advance, frameAtTime } from './timeline';

const sample = () => parseReplay(structuredClone(fixture.replay));

describe('independent analytic geometry fixture', () => {
  it('matches Decimal-based distance, spread, and analytic 3–4–5 velocity fixtures', () => {
    const bundle = sample();
    const snapshots = analyzeReplay(bundle, 'left');
    for (const [i, snapshot] of snapshots.entries()) {
      const m = playerMetrics(snapshot, '1');
      expect(m.basket.value).toBeCloseTo(fixture.expected.left_rim_distance_ft[i], 10);
      expect(m.defender.value).toBeCloseTo(fixture.expected.nearest_opponent_distance_ft[i], 10);
      if (fixture.expected.speed_ft_s[i] === null) expect(m.speed.value).toBeNull();
      else expect(m.speed.value).toBeCloseTo(fixture.expected.speed_ft_s[i]!, 10);
      expect(snapshot.teams.find((team) => team.teamId === '100')?.rms).toBeCloseTo(fixture.expected.home_rms_ft, 10);
    }
    expect(playerMetrics(analyzeReplay(bundle, 'right')[0], '1').basket.value)
      .toBeCloseTo(fixture.expected.right_rim_distance_at_start_ft, 10);
  });
  it('uses source timestamps even while the game clock is stopped', () => {
    const bundle = sample();
    bundle.frames.forEach((frame) => { frame.game_clock_s = 700; });
    expect(playerMetrics(analyzeReplay(bundle, 'nearer')[5], '1').speed.value).toBeCloseTo(5, 10);
  });
  it('does not use future motion when measuring current speed', () => {
    const bundle = sample();
    const before = analyzeReplay(bundle, 'left')[4];
    bundle.frames[5].entities.find((e) => e.entity_id === '1')!.x_ft += 100;
    expect(playerMetrics(analyzeReplay(bundle, 'left')[4], '1').speed.value).toBe(playerMetrics(before, '1').speed.value);
  });
  it('retains zero stationary speed as a measured value', () => {
    expect(playerMetrics(analyzeReplay(sample(), 'left')[5], '7').speed.value).toBe(0);
  });
});

describe('availability and discontinuities', () => {
  it('missing player is unavailable and breaks its trail/history', () => {
    const bundle = sample();
    bundle.frames[3].entities = bundle.frames[3].entities.filter((e) => e.entity_id !== '1');
    const snapshots = analyzeReplay(bundle, 'left');
    expect(playerMetrics(snapshots[3], '1').basket.value).toBeNull();
    expect(playerMetrics(snapshots[5], '1').speed.value).toBeNull();
    expect(trailPoints(bundle.frames, snapshots, 5, '1')).toHaveLength(2);
    expect(snapshots[3].teams.find((t) => t.teamId === '100')?.count).toBe(4);
  });
  it('missing opponents do not produce a falsely exact nearest-defender distance', () => {
    const bundle = sample();
    bundle.frames[5].entities = bundle.frames[5].entities.filter((e) => e.entity_id !== '6');
    const m = playerMetrics(analyzeReplay(bundle, 'left')[5], '1');
    expect(m.defender.value).toBeNull();
    expect(m.defender.reason).toContain('4/5');
    expect(m.defenderId).toBeNull();
  });
  it('hides conflicting positions rather than choosing a timestamp variant', () => {
    const bundle = sample();
    bundle.frames[4].timestamp_conflict = true;
    const snapshots = analyzeReplay(bundle, 'left');
    expect(snapshots[4].entities.size).toBe(0);
    expect(playerMetrics(snapshots[4], '1').basket.value).toBeNull();
    expect(playerMetrics(snapshots[5], '1').speed.value).toBeNull();
    expect(trailPoints(bundle.frames, snapshots, 5, '1')).toHaveLength(1);
  });
  it('hides duplicate identities and mismatched roster teams', () => {
    const bundle = sample();
    bundle.frames[5].entities.push({ ...bundle.frames[5].entities[0] });
    bundle.frames[5].entities[1].team_id = '200';
    const snapshot = analyzeReplay(bundle, 'left')[5];
    expect(snapshot.entities.has('1')).toBe(false);
    expect(snapshot.entities.has('2')).toBe(false);
  });
  it('gaps stop playback even on a tick that skips several frames', () => {
    const bundle = sample();
    bundle.frames[3].break_before = true;
    const snapshots = analyzeReplay(bundle, 'left');
    expect(advance(bundle.frames, 1, 10)).toEqual({ index: 3, stoppedAtBreak: true, ended: false });
    expect(playerMetrics(snapshots[5], '1').speed.value).toBeNull();
    expect(trailPoints(bundle.frames, snapshots, 5, '1')).toHaveLength(3);
  });
  it('pauses when an observation gap starts instead of holding a stale player for missing time', () => {
    const frames = sample().frames;
    for (let i = 3; i < frames.length; i++) { frames[i].elapsed_s += 10; frames[i].source_timestamp_ms += 10000; }
    frames[3].break_before = true;
    expect(advance(frames, 2, 0.13)).toEqual({ index: 3, stoppedAtBreak: true, ended: false });
  });
  it('missing ball does not invent a ball or remove valid player measurements', () => {
    const bundle = sample();
    bundle.frames[5].entities = bundle.frames[5].entities.filter((e) => e.kind !== 'ball');
    const snapshot = analyzeReplay(bundle, 'nearer')[5];
    expect(snapshot.entities.has('ball')).toBe(false);
    expect(snapshot.issues).toContain('Ball observation unavailable.');
    expect(playerMetrics(snapshot, '1').speed.value).toBeCloseTo(5, 10);
  });
});

describe('time and event-clock mapping', () => {
  it('seeks using observed elapsed time with endpoints clamped', () => {
    const frames = sample().frames;
    expect(frameAtTime(frames, -100)).toBe(0);
    expect(frameAtTime(frames, 0.079)).toBe(1);
    expect(frameAtTime(frames, 100)).toBe(5);
    expect(advance(frames, 0, 100)).toEqual({ index: 5, ended: true, stoppedAtBreak: false });
  });
  it('reports a range, not an exact release instant', () => {
    const bundle = sample();
    const marker = eventMarker(bundle.frames, bundle.events[0]);
    expect(marker.status).toBe('approximate');
    expect(marker.ranges).toEqual([{ start: 0, end: 5 }]);
  });
  it('does not choose between disjoint event-clock ranges', () => {
    const bundle = sample();
    bundle.frames[3].break_before = true;
    const marker = eventMarker(bundle.frames, bundle.events[0]);
    expect(marker.status).toBe('ambiguous');
    expect(marker.frameIndex).toBeNull();
  });
  it('does not map an event outside the period or observed clocks', () => {
    const bundle = sample();
    expect(eventMarker(bundle.frames, { ...bundle.events[0], period: 2 }).status).toBe('unavailable');
    expect(eventMarker(bundle.frames, { ...bundle.events[0], game_clock_s: 100 }).frameIndex).toBeNull();
  });
});

describe('replay data contract', () => {
  it('rejects bad versions, nonfinite coordinates and inconsistent time before analytics', () => {
    const version = structuredClone(fixture.replay);
    version.schema_version = 'unknown';
    expect(() => parseReplay(version)).toThrow('unsupported');
    const nonfinite = sample();
    nonfinite.frames[1].entities[0].x_ft = Infinity;
    expect(() => parseReplay(nonfinite)).toThrow('invalid');
    const time = sample();
    time.frames[1].elapsed_s = 100;
    expect(() => parseReplay(time)).toThrow('invalid');
  });
});
