import type { Audit, ReplayBundle, Shot } from './types';
import { parseReplay } from './replay/contract';

export async function getAudit(signal: AbortSignal): Promise<Audit> {
  const response = await fetch('/api/data-health', { signal });
  if (!response.ok) throw new Error(response.status === 503
    ? 'Import the sample with make fetch and make audit, then reload.'
    : 'The local data service is unavailable. Start it with make api, then reload.');
  const result: Audit = await response.json();
  if (result.schema_version !== 'basketball-audit-v1' || !Array.isArray(result.games)) {
    throw new Error('This data audit uses an unsupported format. Rebuild it with make audit.');
  }
  return result;
}

export async function getShots(gameId: string, signal: AbortSignal): Promise<Shot[]> {
  const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/shots?limit=500`, { signal });
  if (!response.ok) throw new Error('Shots could not be loaded. Check the local data service and reload.');
  const result: { shots: Shot[]; total: number } = await response.json();
  if (result.total > result.shots.length) {
    throw new Error('The inspection sample exceeds one page. Use the API to inspect the complete game.');
  }
  return result.shots;
}

export async function getReplay(gameId: string, segmentId: string, signal: AbortSignal): Promise<ReplayBundle> {
  const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/segments/${encodeURIComponent(segmentId)}`, { signal });
  if (!response.ok) throw new Error(response.status === 404
    ? 'This tracking window is unavailable in the current catalog.'
    : 'The tracking window could not be loaded. Check the local data service.');
  const bundle = parseReplay(await response.json());
  if (bundle.game_id !== gameId || bundle.segment_id !== segmentId) {
    throw new Error('The returned tracking window does not match the selected attempt.');
  }
  return bundle;
}

export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

export function trackingClock(seconds: number): string {
  const ticks = Math.round(seconds * 100);
  return `${Math.floor(ticks / 6000)}:${String(Math.floor(ticks / 100) % 60).padStart(2, '0')}.${String(ticks % 100).padStart(2, '0')}`;
}

export function trackingDescription(shot: Shot): string {
  if (shot.tracking_join.status !== 'matched') {
    return shot.tracking_join.reason ?? 'Tracking match unavailable';
  }
  return shot.tracking_join.window_continuity === 'partial'
    ? 'Matched event window · partial tracking'
    : 'Matched event window · continuous tracking';
}
