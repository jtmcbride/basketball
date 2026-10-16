import { describe, expect, it, vi, afterEach } from 'vitest';
import { getAudit, getShots, trackingDescription } from './data';
import type { Shot } from './types';

afterEach(() => vi.unstubAllGlobals());

describe('source availability boundaries', () => {
  it('does not present an unmatched event as replayable', () => {
    const shot = { tracking_join: { status: 'unmatched', reason: 'Event clock outside window' } } as Shot;
    expect(trackingDescription(shot)).toBe('Event clock outside window');
  });
  it('keeps matched but partial windows visible', () => {
    const shot = { tracking_join: { status: 'matched', window_continuity: 'partial' } } as Shot;
    expect(trackingDescription(shot)).toContain('partial tracking');
  });
  it('rejects an unsupported audit version', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schema_version: 'future-version', games: [],
    }))));
    await expect(getAudit(new AbortController().signal)).rejects.toThrow('unsupported format');
  });
  it('explains a missing catalog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(getAudit(new AbortController().signal)).rejects.toThrow('make audit');
  });
  it('does not silently display an incomplete page as a whole game', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ shots: [], total: 600 }))));
    await expect(getShots('0000000001', new AbortController().signal)).rejects.toThrow('exceeds one page');
  });
});
