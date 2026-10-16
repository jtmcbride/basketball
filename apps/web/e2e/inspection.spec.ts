import { expect, test } from '@playwright/test';

// Generated contract fixture. Real-data browser verification is run separately.
const shot = {
  shot_id: 'generated-shot', game_id: '0000000001', source_event_id: '5', player_name: 'Generated Player',
  player_id: '1', period: 1, game_clock_s: 700, made: true, action_type: 'Jump Shot',
  lateral_ft: 5, forward_ft: 9, shot_value: 2, recorded_distance_ft: 10,
  tracking_join: { status: 'unmatched', reason: 'Event clock outside window', segment_id: null,
    clock_delta_s: 3, timing_confidence: 'unavailable', window_continuity: null },
  event_join: { status: 'matched', reason: null },
};
const game = {
  game_id: '0000000001', game_date: '2000-01-01', home_team: 'HOM', away_team: 'AWY', shots: 1,
  unique_frames: 100, source_event_windows: 2, continuous_windows: 1, partial_windows: 1, empty_windows: 0,
  periods: [{ period: 1, unique_frames: 100, clock_min_s: 690, clock_max_s: 700 }],
  joins: { shot_to_event: { matched: 1 }, shot_to_tracking: { unmatched: 1 } },
  findings: [{ code: 'missing_ball', count: 1, severity: 'warning', description: 'Ball unavailable.' }],
  examples: [],
};

test('inspects shots, filters players, and discloses unmatched tracking', async ({ page }) => {
  await page.route('**/api/data-health', (route) => route.fulfill({ json: {
    schema_version: 'basketball-audit-v1', source_fingerprint: 'generated', games: [game], sources: [],
    boundaries: { segment_kind: 'source_event_window', possessions_reconstructed: false },
  } }));
  await page.route('**/api/games/*/shots?*', (route) => route.fulfill({ json: { shots: [shot], total: 1 } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AWY at HOM' })).toBeVisible();
  await expect(page.getByRole('img', { name: /Basket-relative shot chart/ })).toBeVisible();
  await expect(page.getByText('Event clock outside window', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Player', exact: true }).selectOption('1');
  await expect(page.getByLabel('Inspect attempt')).toHaveValue('generated-shot');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('missing catalog gives an actionable empty state', async ({ page }) => {
  await page.route('**/api/data-health', (route) => route.fulfill({ status: 503, json: { detail: 'No catalog' } }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('make fetch and make audit');
});

test('switching games resets the selected player and attempt', async ({ page }) => {
  const second = { ...game, game_id: '0000000002', home_team: 'TWO', away_team: 'NEW' };
  await page.route('**/api/data-health', (route) => route.fulfill({ json: {
    schema_version: 'basketball-audit-v1', source_fingerprint: 'generated', games: [game, second], sources: [],
  } }));
  await page.route('**/api/games/*/shots?*', (route) => {
    const isSecond = route.request().url().includes('0000000002');
    return route.fulfill({ json: { shots: [{ ...shot,
      shot_id: isSecond ? 'second-shot' : shot.shot_id,
      player_id: isSecond ? '2' : '1', player_name: isSecond ? 'Another Player' : shot.player_name,
    }], total: 1 } });
  });
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Player', exact: true }).selectOption('1');
  await page.getByRole('button', { name: /NEW at TWO/ }).click();
  await expect(page.getByRole('combobox', { name: 'Player', exact: true })).toHaveValue('all');
  await expect(page.getByLabel('Inspect attempt')).toHaveValue('second-shot');
});
