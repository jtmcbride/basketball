import type { Entity, ReplayBundle, SourceEvent, TrackingFrame } from '../types';

export type BasketReference = 'nearer' | 'left' | 'right';
export interface Measurement { value: number | null; reason: string | null }
export interface PlayerMetrics {
  basket: Measurement;
  defender: Measurement;
  speed: Measurement;
  defenderId: string | null;
}
export interface TeamShape {
  teamId: string;
  count: number;
  center: { x: number; y: number } | null;
  rms: number | null;
}
export interface Snapshot {
  entities: Map<string, Entity>;
  players: Map<string, PlayerMetrics>;
  teams: TeamShape[];
  issues: string[];
  conflicted: boolean;
}
export interface EventMarker {
  event: SourceEvent;
  frameIndex: number | null;
  ranges: { start: number; end: number }[];
  status: 'approximate' | 'ambiguous' | 'unavailable';
}
const available = (value: number): Measurement => ({ value, reason: null });
const unavailable = (reason: string): Measurement => ({ value: null, reason });
const distance = (a: Entity, b: Entity) => Math.hypot(a.x_ft - b.x_ft, a.y_ft - b.y_ft);

export function isBreak(previous: TrackingFrame, current: TrackingFrame): boolean {
  return current.break_before || current.period !== previous.period
    || Math.abs(current.source_timestamp_ms - previous.source_timestamp_ms - 40) > 5
    || current.game_clock_s > previous.game_clock_s + 0.1
    || previous.timestamp_conflict || current.timestamp_conflict;
}

export function frameEntities(frame: TrackingFrame, roster: Map<string, string>): Map<string, Entity> {
  if (frame.timestamp_conflict) return new Map();
  const counts = new Map<string, number>();
  for (const entity of frame.entities) counts.set(entity.entity_id, (counts.get(entity.entity_id) ?? 0) + 1);
  return new Map(frame.entities.filter((entity) => counts.get(entity.entity_id) === 1
    && (entity.kind === 'ball' || (entity.team_id !== null && roster.get(entity.entity_id) === entity.team_id)))
    .map((entity) => [entity.entity_id, entity]));
}

function basketDistance(entity: Entity, reference: BasketReference): number {
  const left = Math.hypot(entity.x_ft - 5.25, entity.y_ft - 25);
  const right = Math.hypot(entity.x_ft - 88.75, entity.y_ft - 25);
  return reference === 'left' ? left : reference === 'right' ? right : Math.min(left, right);
}

/** Five-observation, backward-looking least-squares velocity, in feet/second.
 * Actual timestamps, no imputation, no future frames, no crossing identity gaps.
 */
function speedAt(frames: TrackingFrame[], snapshots: Snapshot[], index: number, id: string): Measurement {
  if (index < 4) return unavailable('Needs five consecutive observations (about 0.16 s).');
  const points: { t: number; entity: Entity }[] = [];
  for (let i = index - 4; i <= index; i++) {
    const entity = snapshots[i].entities.get(id);
    if (!entity || snapshots[i].conflicted || (i > index - 4 && isBreak(frames[i - 1], frames[i]))) {
      return unavailable('Five-observation history crosses missing, conflicting, or discontinuous tracking.');
    }
    points.push({ t: (frames[i].source_timestamp_ms - frames[index].source_timestamp_ms) / 1000, entity });
  }
  const meanT = points.reduce((sum, p) => sum + p.t, 0) / 5;
  const meanX = points.reduce((sum, p) => sum + p.entity.x_ft, 0) / 5;
  const meanY = points.reduce((sum, p) => sum + p.entity.y_ft, 0) / 5;
  const denominator = points.reduce((sum, p) => sum + (p.t - meanT) ** 2, 0);
  if (denominator <= 0) return unavailable('Distinct source timestamps are required.');
  const vx = points.reduce((sum, p) => sum + (p.t - meanT) * (p.entity.x_ft - meanX), 0) / denominator;
  const vy = points.reduce((sum, p) => sum + (p.t - meanT) * (p.entity.y_ft - meanY), 0) / denominator;
  return available(Math.hypot(vx, vy));
}

export function analyzeReplay(bundle: ReplayBundle, reference: BasketReference): Snapshot[] {
  const roster = new Map(bundle.players.map((p) => [p.player_id, p.team_id]));
  const teamIds = [...new Set(bundle.players.map((p) => p.team_id))].sort();
  const snapshots: Snapshot[] = bundle.frames.map((frame) => {
    const entities = frameEntities(frame, roster);
    const players = [...entities.values()].filter((e) => e.kind === 'player');
    const issues: string[] = [];
    if (frame.timestamp_conflict) issues.push('Conflicting observations: positions and measurements unavailable.');
    else {
      if (!entities.has('ball')) issues.push('Ball observation unavailable.');
      if (players.length !== 10) issues.push(`${players.length}/10 players available.`);
      if (frame.quality_flags.includes('team_count_not_five')) issues.push('Team counts differ from five per side.');
      if (frame.quality_flags.includes('shot_clock_out_of_range')) issues.push('Source shot clock is outside its valid range.');
      if (frame.quality_flags.includes('game_clock_out_of_range')) issues.push('Source game clock is outside its period range.');
      if (frame.quality_flags.includes('ball_height_out_of_range')) issues.push('Source ball height is outside its valid range.');
      if (frame.quality_flags.includes('roster_mismatch') || frame.quality_flags.includes('duplicate_entity_ids')) {
        issues.push('Ambiguous or inconsistent identities are hidden.');
      }
      if (frame.quality_flags.includes('outside_court')) issues.push('Recorded positions extend outside court lines.');
    }
    const teams = teamIds.map((teamId): TeamShape => {
      const members = players.filter((e) => e.team_id === teamId);
      if (members.length === 0) return { teamId, count: 0, center: null, rms: null };
      const center = { x: members.reduce((sum, e) => sum + e.x_ft, 0) / members.length,
        y: members.reduce((sum, e) => sum + e.y_ft, 0) / members.length };
      const rms = members.length < 2 ? null : Math.sqrt(members.reduce((sum, e) => sum
        + (e.x_ft - center.x) ** 2 + (e.y_ft - center.y) ** 2, 0) / members.length);
      return { teamId, count: members.length, center, rms };
    });
    return { entities, players: new Map(), teams, issues, conflicted: frame.timestamp_conflict };
  });
  for (const [i, snapshot] of snapshots.entries()) {
    for (const [id, entity] of snapshot.entities) {
      if (entity.kind !== 'player') continue;
      const opponents = [...snapshot.entities.values()].filter((e) => e.kind === 'player'
        && e.team_id !== entity.team_id);
      const nearest = opponents.reduce<Entity | null>((best, candidate) => !best
        || distance(entity, candidate) < distance(entity, best) ? candidate : best, null);
      const completeOpponents = teamIds.length === 2 && opponents.length === 5;
      snapshot.players.set(id, {
        basket: available(basketDistance(entity, reference)),
        defender: completeOpponents && nearest ? available(distance(entity, nearest))
          : unavailable(`Needs five tracked opponents (${opponents.length}/5 available).`),
        defenderId: completeOpponents ? nearest?.entity_id ?? null : null,
        speed: speedAt(bundle.frames, snapshots, i, id),
      });
    }
  }
  return snapshots;
}

export function playerMetrics(snapshot: Snapshot, id: string): PlayerMetrics {
  return snapshot.players.get(id) ?? {
    basket: unavailable(snapshot.conflicted ? 'Conflicting timestamp observations.' : 'Selected player unavailable in this frame.'),
    defender: unavailable(snapshot.conflicted ? 'Conflicting timestamp observations.' : 'Selected player unavailable in this frame.'),
    speed: unavailable(snapshot.conflicted ? 'Conflicting timestamp observations.' : 'Selected player unavailable in this frame.'),
    defenderId: null,
  };
}

export function eventMarker(frames: TrackingFrame[], event: SourceEvent): EventMarker {
  const ranges: EventMarker['ranges'] = [];
  let previous = -2;
  let closest: number | null = null;
  let delta = Infinity;
  for (const [i, frame] of frames.entries()) {
    if (frame.period !== event.period || Math.abs(frame.game_clock_s - event.game_clock_s) > 1
      || frame.timestamp_conflict) continue;
    if (i !== previous + 1 || (i > 0 && isBreak(frames[i - 1], frame))) ranges.push({ start: i, end: i });
    else ranges[ranges.length - 1].end = i;
    previous = i;
    const d = Math.abs(frame.game_clock_s - event.game_clock_s);
    if (d < delta) { closest = i; delta = d; }
  }
  return { event, ranges, frameIndex: ranges.length === 1 ? closest : null,
    status: ranges.length === 1 ? 'approximate' : ranges.length > 1 ? 'ambiguous' : 'unavailable' };
}

/** Only observed points; never draw a trail across an absent player or time gap. */
export function trailPoints(frames: TrackingFrame[], snapshots: Snapshot[], index: number, id: string, startIndex = 0): Entity[] {
  const points: Entity[] = [];
  for (let i = index; i >= startIndex; i--) {
    if (frames[index].elapsed_s - frames[i].elapsed_s > 1.2) break;
    const entity = snapshots[i].entities.get(id);
    if (!entity) break;
    points.unshift(entity);
    if (i > 0 && isBreak(frames[i - 1], frames[i])) break;
  }
  return points;
}
