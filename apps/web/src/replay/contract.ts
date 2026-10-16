import type { ReplayBundle } from '../types';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate the numerical boundary before rendering or deriving measurements. */
export function parseReplay(value: unknown): ReplayBundle {
  const invalid = () => new Error('This tracking window has an unsupported or invalid format. Re-export it with the current data tools.');
  if (!record(value) || value.schema_version !== 'basketball-replay-v1'
    || value.segment_kind !== 'source_event_window' || typeof value.game_id !== 'string'
    || typeof value.segment_id !== 'string' || !Array.isArray(value.frames) || !value.frames.length
    || !Array.isArray(value.players) || !record(value.provenance)
    || value.provenance.coordinate_system !== 'sportvu_source_court_feet'
    || value.provenance.time_basis !== 'source_timestamp_ms'
    || value.provenance.attacking_direction !== 'unavailable'
    || typeof value.provenance.source_fingerprint !== 'string'
    || typeof value.provenance.pipeline_version !== 'string'
    || value.provenance.nominal_hz !== 25 || !Array.isArray(value.provenance.sources)
    || !Array.isArray(value.quality_findings)
    || !['continuous', 'partial'].includes(String(value.continuity))) throw invalid();
  let previousTimestamp = -Infinity;
  let origin = 0;
  const ids = new Set<string>();
  for (const [i, frame] of value.frames.entries()) {
    if (!record(frame) || typeof frame.frame_id !== 'string' || ids.has(frame.frame_id)
      || !Number.isInteger(frame.period) || Number(frame.period) < 1
      || !finite(frame.source_timestamp_ms) || !Number.isSafeInteger(frame.source_timestamp_ms)
      || !finite(frame.elapsed_s) || frame.elapsed_s < 0 || !finite(frame.game_clock_s) || frame.game_clock_s < 0
      || (frame.shot_clock_s !== null && !finite(frame.shot_clock_s))
      || typeof frame.break_before !== 'boolean' || typeof frame.timestamp_conflict !== 'boolean'
      || !Array.isArray(frame.quality_flags) || !frame.quality_flags.every((flag) => typeof flag === 'string')
      || !Array.isArray(frame.source_moment_indices) || !frame.source_moment_indices.length
      || !frame.source_moment_indices.every((j) => Number.isInteger(j) && j >= 0)
      || !Array.isArray(frame.entities)) throw invalid();
    if (i === 0) origin = frame.source_timestamp_ms;
    if (i === 0 && frame.break_before) throw invalid();
    if (frame.source_timestamp_ms < previousTimestamp
      || Math.abs(frame.elapsed_s - (frame.source_timestamp_ms - origin) / 1000) > 1e-8) throw invalid();
    for (const entity of frame.entities) {
      if (!record(entity) || !['player', 'ball'].includes(String(entity.kind))
        || typeof entity.entity_id !== 'string'
        || (entity.team_id !== null && typeof entity.team_id !== 'string')
        || (entity.kind === 'ball' && (entity.entity_id !== 'ball' || entity.team_id !== null))
        || (entity.kind === 'player' && (entity.entity_id === 'ball' || entity.team_id === null))
        || !finite(entity.x_ft) || !finite(entity.y_ft)
        || (entity.z_ft !== null && !finite(entity.z_ft))) throw invalid();
    }
    previousTimestamp = frame.source_timestamp_ms;
    ids.add(frame.frame_id);
  }
  for (const player of value.players) {
    if (!record(player) || typeof player.player_id !== 'string'
      || typeof player.team_id !== 'string' || typeof player.name !== 'string'
      || typeof player.jersey !== 'string') throw invalid();
  }
  if (value.events !== undefined && !Array.isArray(value.events)) throw invalid();
  for (const event of (value.events ?? []) as unknown[]) {
    if (!record(event) || typeof event.event_id !== 'string' || typeof event.source_event_id !== 'string'
      || event.game_id !== value.game_id || !Number.isInteger(event.period)
      || !finite(event.game_clock_s) || typeof event.description !== 'string') throw invalid();
  }
  for (const finding of value.quality_findings) {
    if (!record(finding) || typeof finding.code !== 'string' || !finite(finding.count)
      || typeof finding.description !== 'string') throw invalid();
  }
  return { ...value, events: value.events ?? [] } as unknown as ReplayBundle;
}
