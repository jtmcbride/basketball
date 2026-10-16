import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';

// Run after Python scripts/replay_reference.py, with API/dev/preview servers up.
const origin = process.env.BASKETBALL_ORIGIN ?? 'http://127.0.0.1:5178';
const devOrigin = process.env.BASKETBALL_DEV_ORIGIN ?? 'http://127.0.0.1:5177';
const reference = JSON.parse(await readFile('../../data/exports/m1-reference.json', 'utf8'));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(devOrigin);
await page.getByTestId('replay-panel').waitFor();
const numerical = await page.evaluate(async (reference) => {
  const { analyzeReplay, playerMetrics } = await import('/src/replay/analysis.ts');
  const maxErrors = { distance: 0, opponent: 0, speed: 0, spread: 0 };
  let compared = 0;
  let availabilityCompared = 0;
  const preparation = [];
  for (const window of reference.windows) {
    const bundle = await (await fetch(`/api/games/${window.game_id}/segments/${encodeURIComponent(window.segment_id)}`)).json();
    if (bundle.provenance.source_fingerprint !== reference.source_fingerprint) throw new Error('Reference dataset mismatch');
    const started = performance.now();
    const samples = Object.fromEntries(['left', 'right', 'nearer'].map((rim) => [rim, analyzeReplay(bundle, rim)]));
    preparation.push({ game_id: window.game_id, segment_id: window.segment_id,
      frames: bundle.frames.length, threeReferencesMs: performance.now() - started });
    const check = (actual, expected, key) => {
      availabilityCompared++;
      if ((actual === null) !== (expected === null)) throw new Error(`Availability mismatch ${key}`);
      if (actual === null) return;
      const delta = Math.abs(actual - expected);
      maxErrors[key] = Math.max(maxErrors[key], delta);
      if (delta > reference.numerical_tolerance) throw new Error(`Numerical mismatch ${key}: ${delta}`);
      compared++;
    };
    for (const sample of window.checks) {
      for (const rim of ['left', 'right', 'nearer']) {
        const m = playerMetrics(samples[rim][sample.index], sample.player_id);
        check(m.basket.value, sample.expected[rim], 'distance');
        if (rim === 'nearer') { check(m.defender.value, sample.expected.opponent, 'opponent'); check(m.speed.value, sample.expected.speed, 'speed'); }
      }
      for (const team of sample.teams) {
        const actual = samples.nearer[sample.index].teams.find((t) => t.teamId === team.team_id);
        if (actual.count !== team.count) throw new Error('Team-count mismatch');
        check(actual.rms, team.rms, 'spread');
      }
    }
  }
  return { compared, availabilityCompared, tolerance: reference.numerical_tolerance, maxErrors, preparation };
}, reference);

await page.goto(origin);
await page.getByTestId('replay-panel').waitFor();
await page.getByRole('combobox', { name: 'Inspect attempt', exact: true }).selectOption('shotchart:0021500492:5');
await page.getByRole('button', { name: 'Shot event ≈', exact: true }).click();
await page.getByRole('checkbox', { name: 'Nearest opponent', exact: true }).check();
await page.getByRole('checkbox', { name: 'Team spread', exact: true }).check();
await mkdir('../../artifacts', { recursive: true });
await page.evaluate(() => scrollTo(0, 0));
await page.screenshot({ path: '../../artifacts/m1-replay-desktop.png', fullPage: true });

// Browser callbacks target refresh cadence; observed positions still update at
// source cadence. This measures a headless local run, not GPU-presented frames.
await page.getByRole('button', { name: 'First frame', exact: true }).click();
const profile = page.evaluate(() => new Promise((resolve) => {
  const panel = document.querySelector('[data-testid="replay-panel"]');
  const intervals = [];
  const updates = [];
  const started = performance.now();
  let previous = null;
  const observer = new MutationObserver(() => updates.push({ time: performance.now() - started, index: Number(panel.dataset.frameIndex) }));
  observer.observe(panel, { attributes: true, attributeFilter: ['data-frame-index'] });
  const tick = (now) => {
    if (previous !== null) intervals.push(now - previous);
    previous = now;
    if (now - started < 3000) requestAnimationFrame(tick);
    else { observer.disconnect(); resolve({ durationMs: now - started, intervals, updates }); }
  };
  requestAnimationFrame(tick);
}));
await page.getByRole('button', { name: 'Play tracking', exact: true }).click();
const playback = await profile;
await page.getByRole('button', { name: 'Pause tracking', exact: true }).click();
const sorted = playback.intervals.toSorted((a, b) => a - b);
const percentile = (p) => sorted[Math.floor((sorted.length - 1) * p)];
const timing = { durationMs: playback.durationMs, animationCallbacks: playback.intervals.length + 1,
  medianCallbackIntervalMs: percentile(0.5), p95CallbackIntervalMs: percentile(0.95),
  callbackIntervalsOver33_4ms: playback.intervals.filter((v) => v > 33.4).length,
  observedFrameUpdates: playback.updates.length,
  note: 'One local headless Chromium production-preview run at 1x; callback cadence is not proof of presented GPU frames.' };

// Real partial-window example: find and inspect a missing-ball observation.
await page.getByRole('combobox', { name: 'Inspect attempt', exact: true }).selectOption('shotchart:0021500492:47');
await page.getByTestId('replay-panel').waitFor();
const partial = await (await page.request.get(`${origin}/api/games/0021500492/segments/${encodeURIComponent('sportvu:0021500492:47:39')}`)).json();
const missingIndex = partial.frames.findIndex((f) => !f.entities.some((e) => e.kind === 'ball'));
if (missingIndex < 0) throw new Error('Expected audited missing-ball example');
await page.getByRole('slider', { name: 'Tracking frame', exact: true }).focus();
await page.keyboard.press('Home');
for (let i = 0; i < missingIndex; i++) await page.keyboard.press('ArrowRight');
if (await page.getByTestId('tracked-ball').count() !== 0) throw new Error('Missing ball was invented');
await page.setViewportSize({ width: 390, height: 844 });
const mobileNoOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
if (!mobileNoOverflow) throw new Error('Mobile horizontal overflow');
await page.screenshot({ path: '../../artifacts/m1-replay-mobile.png', fullPage: true });
await page.getByTestId('replay-panel').screenshot({ path: '../../artifacts/m1-replay-mobile-panel.png' });
await page.getByRole('button', { name: /DEN at GSW/ }).click();
await page.getByRole('combobox', { name: 'Inspect attempt', exact: true }).selectOption('shotchart:0021500504:3');
await page.getByRole('region', { name: 'Tracking replay unavailable', exact: true }).waitFor();
if (await page.getByTestId('tracked-player').count()) throw new Error('Unavailable shot retained old players');
if (errors.length) throw new Error(errors.join('\n'));
const result = { origin, browser: await browser.version(), platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0].model, viewport: { width: 1440, height: 1100 }, source_fingerprint: reference.source_fingerprint,
  realWindowsCompared: reference.windows.length, numerical, playback: timing,
  missingBallExample: { game_id: '0021500492', source_event_id: '47', frameIndex: missingIndex },
  mobileNoHorizontalOverflow: mobileNoOverflow, unmatchedShotRetainsNoPositions: true, pageErrors: errors };
result.implementation = Object.fromEntries(await Promise.all([
  'src/replay/analysis.ts', 'src/replay/timeline.ts', 'src/replay/usePlayback.ts', 'src/replay/ReplayView.tsx', 'package-lock.json',
].map(async (path) => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
await writeFile('../../artifacts/m1-verification.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
await browser.close();
