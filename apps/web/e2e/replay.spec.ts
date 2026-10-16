import { expect, test, type Page } from '@playwright/test';
import fixture from '../../../tests/fixtures/m1-constant-motion.json' with { type: 'json' };

function generatedReplay() {
  const bundle = structuredClone(fixture.replay);
  const first = bundle.frames[0];
  bundle.frames = Array.from({ length: 30 }, (_, i) => {
    const frame = structuredClone(first);
    const t = i * 0.04;
    frame.frame_id = `generated-${i}`;
    frame.source_timestamp_ms += i * 40;
    frame.elapsed_s = t;
    frame.game_clock_s -= t;
    frame.shot_clock_s! -= t;
    frame.source_moment_indices = [i];
    for (const e of frame.entities) {
      if (e.kind === 'ball' || Number(e.entity_id) <= 6) { e.x_ft += 3 * t; e.y_ft += 4 * t; }
    }
    return frame;
  });
  return bundle;
}

async function setup(page: Page, bundle = generatedReplay()) {
  const shot = {
    shot_id: 'generated-shot', game_id: '0000000001', source_event_id: '5', player_name: 'Generated Player 1',
    player_id: '1', team_id: '100', period: 1, game_clock_s: 700, made: true, action_type: 'Generated Jump Shot',
    lateral_ft: 5, forward_ft: 9, shot_value: 2, recorded_distance_ft: 10,
    tracking_join: { status: 'matched', reason: null, segment_id: bundle.segment_id,
      clock_delta_s: 0, timing_confidence: 'event_clock_only', window_continuity: bundle.continuity },
    event_join: { status: 'matched', reason: null },
  };
  const shots = [shot, { ...shot, shot_id: 'generated-miss', made: false, source_event_id: '6',
    tracking_join: { ...shot.tracking_join, segment_id: 'sportvu:0000000001:6:1' } },
  { ...shot, shot_id: 'generated-ambiguous', source_event_id: '7', tracking_join: { ...shot.tracking_join,
    status: 'ambiguous', segment_id: null, reason: 'Multiple source event windows' } }];
  const game = {
    game_id: '0000000001', game_date: '2000-01-01', home_team: 'HOM', away_team: 'AWY',
    home_team_id: '100', away_team_id: '200', shots: 3, unique_frames: 30, source_event_windows: 2,
    continuous_windows: 1, partial_windows: 1, empty_windows: 0,
    periods: [{ period: 1, unique_frames: 30, clock_min_s: 698.8, clock_max_s: 700 }],
    joins: { shot_to_event: { matched: 3 }, shot_to_tracking: { matched: 2, ambiguous: 1 } },
    findings: [], examples: [],
  };
  await page.route('**/api/data-health', (route) => route.fulfill({ json: {
    schema_version: 'basketball-audit-v1', source_fingerprint: 'generated', games: [game], sources: [],
  } }));
  await page.route('**/api/games/*/shots?*', (route) => route.fulfill({ json: { shots, total: shots.length } }));
  await page.route('**/api/games/*/segments/*', (route) => {
    const second = decodeURIComponent(route.request().url()).includes('sportvu:0000000001:6:1');
    return route.fulfill({ json: second ? { ...bundle, source_event_id: '6', segment_id: 'sportvu:0000000001:6:1' } : bundle });
  });
  await page.goto('/');
}

test('loads a matched shot, steps, selects players, and synchronizes charts', async ({ page }) => {
  await setup(page);
  const replay = page.getByTestId('replay-panel');
  await expect(page.getByTestId('tracked-player')).toHaveCount(10);
  await expect(page.getByTestId('tracked-ball')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Next frame', exact: true }).click();
  await expect(replay).toHaveAttribute('data-frame-index', '1');
  for (const cursor of await page.getByTestId('chart-cursor').all()) await expect(cursor).toHaveAttribute('data-frame-index', '1');
  await replay.focus();
  await page.keyboard.press('End');
  await expect(replay).toHaveAttribute('data-frame-index', '29');
  await expect(page.getByTestId('chart-movement-speed')).toContainText('5.0');
  await page.getByRole('button', { name: 'Select Generated Player 7', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Tracked player', exact: true })).toHaveValue('7');
  await expect(page.getByTestId('chart-movement-speed')).toContainText('0.0');
  await page.getByRole('checkbox', { name: 'Team spread', exact: true }).check();
  await expect(page.locator('.spread-readout')).toContainText('5/5 tracked');
});

test('chart seeking and keyboard controls share one frame state', async ({ page }) => {
  await setup(page);
  const replay = page.getByTestId('replay-panel');
  await expect(replay).toBeVisible();
  await replay.focus();
  await page.keyboard.press('ArrowRight');
  await expect(replay).toHaveAttribute('data-frame-index', '1');
  const slider = page.getByRole('slider', { name: 'Tracking frame', exact: true });
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(replay).toHaveAttribute('data-frame-index', '2');
  const chart = page.getByRole('img', { name: /Distance to nearer rim over/ });
  const bounds = (await chart.boundingBox())!;
  await chart.click({ position: { x: bounds.width * 0.6, y: bounds.height * 0.5 } });
  const index = Number(await replay.getAttribute('data-frame-index'));
  expect(index).toBeGreaterThan(2);
  expect(index).toBeLessThan(29);
  await expect(slider).toHaveValue(String(index));
  for (const cursor of await page.getByTestId('chart-cursor').all()) await expect(cursor).toHaveAttribute('data-frame-index', String(index));
  await page.getByRole('button', { name: 'First frame', exact: true }).click();
  await page.getByRole('combobox', { name: 'Basket reference', exact: true }).selectOption('right');
  await expect(page.getByTestId('chart-distance-to-right-rim')).toContainText('80.6');
  await page.getByRole('button', { name: 'Shot event ≈', exact: true }).click();
  await expect(replay).toHaveAttribute('data-frame-index', '0');
});

test('playback pauses at gaps and missing/conflicting observations remain unavailable', async ({ page }) => {
  const bundle = generatedReplay();
  bundle.continuity = 'partial';
  for (let i = 8; i < bundle.frames.length; i++) {
    bundle.frames[i].source_timestamp_ms += 1000;
    bundle.frames[i].elapsed_s += 1;
  }
  bundle.frames[8].break_before = true;
  bundle.frames[8].entities = bundle.frames[8].entities.filter((e) => e.entity_id !== '1' && e.kind !== 'ball');
  bundle.frames[9].timestamp_conflict = true;
  await setup(page, bundle);
  await page.getByRole('combobox', { name: 'Playback speed', exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Play tracking', exact: true }).click();
  await expect(page.getByTestId('replay-panel')).toHaveAttribute('data-frame-index', '8', { timeout: 4000 });
  await expect(page.getByRole('status')).toContainText('Paused at a tracking break');
  await expect(page.getByTestId('tracked-player')).toHaveCount(9);
  await expect(page.getByTestId('tracked-ball')).toHaveCount(0);
  await expect(page.getByTestId('chart-distance-to-nearer-rim')).toContainText('Unavailable');
  await page.getByRole('button', { name: 'Next frame', exact: true }).click();
  await expect(page.getByTestId('tracked-player')).toHaveCount(0);
  await expect(page.getByText('Conflicting timestamp observations', { exact: true })).toBeVisible();
  await expect(page.getByTestId('chart-movement-speed')).toContainText('Unavailable');
  await expect(page.getByRole('button', { name: 'Shot event ≈', exact: true })).toBeDisabled();
});

test('result filtering changes the replay and ambiguous shots cannot retain old positions', async ({ page }) => {
  await setup(page);
  await expect(page.getByTestId('tracked-player')).toHaveCount(10);
  await page.getByRole('combobox', { name: 'Shot result', exact: true }).selectOption('missed');
  await expect(page.getByRole('combobox', { name: 'Inspect attempt', exact: true })).toHaveValue('generated-miss');
  await expect(page.getByTestId('tracked-player')).toHaveCount(10);
  await page.getByRole('combobox', { name: 'Shot result', exact: true }).selectOption('all');
  await page.getByRole('combobox', { name: 'Inspect attempt', exact: true }).selectOption('generated-ambiguous');
  await expect(page.getByRole('region', { name: 'Tracking replay unavailable', exact: true })).toContainText('Multiple source event windows');
  await expect(page.getByTestId('tracked-player')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('invalid replay data is rejected before rendering measurements', async ({ page }) => {
  const bundle = generatedReplay();
  bundle.frames[3].elapsed_s = 100;
  await setup(page, bundle);
  await expect(page.getByRole('alert')).toContainText('unsupported or invalid format');
  await expect(page.getByTestId('tracked-player')).toHaveCount(0);
});
