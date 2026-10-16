import { useEffect, useMemo, useState } from "react";
import { getReplay, trackingClock } from "../data";
import { analyzeReplay, isBreak } from "../replay/analysis";
import { ReplayCourt, courtMarkings } from "../replay/ReplayCourt";
import { useComparison } from "../offball/useComparison";
import type { Game, ReplayBundle } from "../types";
import type { PathFeature } from "./model";
const selectNoop = () => {};

export function bindPath(
  feature: PathFeature,
  bundle: ReplayBundle,
): { first: number; last: number } {
  if (
    bundle.game_id !== feature.game_id ||
    bundle.segment_id !== feature.segment_id ||
    bundle.provenance.source_fingerprint !== feature.source_fingerprint
  )
    throw new Error("Path feature and replay source do not match.");
  const map = new Map(bundle.frames.map((f, i) => [f.frame_id, i]));
  const indices = feature.frame_ids.map((id, i) => {
    const index = map.get(id);
    if (index === undefined)
      throw new Error(
        "A scored observation is absent from this source window.",
      );
    const frame = bundle.frames[index],
      players = frame.entities.filter((e) => e.entity_id === feature.player_id);
    if (
      frame.timestamp_conflict ||
      frame.source_timestamp_ms !== feature.timestamps_ms[i] ||
      players.length !== 1 ||
      players[0].team_id !== feature.team_id ||
      players[0].x_ft !== feature.x_ft[i] ||
      players[0].y_ft !== feature.y_ft[i]
    )
      throw new Error("Scored coordinates disagree with the current replay.");
    return index;
  });
  for (let i = indices[0]; i <= indices[20]; i++) {
    const frame = bundle.frames[i],
      players = frame.entities.filter((e) => e.entity_id === feature.player_id);
    if (
      frame.timestamp_conflict ||
      frame.quality_flags.includes("game_clock_out_of_range") ||
      (i > indices[0] && isBreak(bundle.frames[i - 1], frame)) ||
      players.length !== 1 ||
      players[0].team_id !== feature.team_id ||
      players[0].x_ft < 0 ||
      players[0].x_ft > 94 ||
      players[0].y_ft < 0 ||
      players[0].y_ft > 50
    )
      throw new Error(
        "The scored path history is no longer complete and continuous.",
      );
  }
  return { first: indices[0], last: indices[20] };
}
export function pathFrameAt(
  bundle: ReplayBundle,
  first: number,
  last: number,
  ms: number,
): number | null {
  const target = bundle.frames[first].source_timestamp_ms + ms;
  if (
    target < bundle.frames[first].source_timestamp_ms ||
    target > bundle.frames[last].source_timestamp_ms
  )
    return null;
  let lo = first,
    hi = last;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bundle.frames[mid].source_timestamp_ms <= target) lo = mid;
    else hi = mid - 1;
  }
  return target - bundle.frames[lo].source_timestamp_ms < 45 ? lo : null;
}
export function PathReplay({
  features,
  games,
  active,
}: {
  features: PathFeature[];
  games: Game[];
  active: boolean;
}) {
  const key = features
    .map((f) => `${f.candidate_id}:${f.segment_id}`)
    .join("|");
  const [data, setData] = useState<{
    key: string;
    bundles?: ReplayBundle[];
    error?: string;
  }>({ key: "" });
  useEffect(() => {
    const controller = new AbortController(),
      pending = new Map<string, Promise<ReplayBundle>>();
    Promise.all(
      features.map((f) => {
        const id = `${f.game_id}:${f.segment_id}`;
        if (!pending.has(id))
          pending.set(
            id,
            getReplay(f.game_id, f.segment_id, controller.signal),
          );
        return pending.get(id)!;
      }),
    )
      .then((bundles) => {
        features.forEach((f, i) => bindPath(f, bundles[i]));
        if (!controller.signal.aborted) setData({ key, bundles });
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setData({ key, error: e.message });
      });
    return () => controller.abort();
  }, [key]);
  if (data.key !== key || !data.bundles)
    return (
      <section
        className="action-replay-empty"
        role={data.key === key && data.error ? "alert" : "status"}
      >
        {data.key === key && data.error
          ? data.error
          : "Loading the two observed source windows…"}
      </section>
    );
  return (
    <ObservedPaths
      key={key}
      features={features}
      bundles={data.bundles}
      games={games}
      active={active}
    />
  );
}
function ObservedPaths({
  features,
  bundles,
  games,
  active,
}: {
  features: PathFeature[];
  bundles: ReplayBundle[];
  games: Game[];
  active: boolean;
}) {
  const prepared = useMemo(
    () =>
      features.map((f, i) => ({
        ...bindPath(f, bundles[i]),
        snapshots: analyzeReplay(bundles[i], "nearer"),
      })),
    [features, bundles],
  );
  const duration = Math.max(...features.map((f) => f.actual_duration_ms));
  const barriers = useMemo(
    () =>
      prepared
        .flatMap((p, j) =>
          bundles[j].frames.flatMap((f, i) =>
            i > p.first && i <= p.last && isBreak(bundles[j].frames[i - 1], f)
              ? [
                  Math.min(
                    f.source_timestamp_ms,
                    bundles[j].frames[i - 1].source_timestamp_ms + 45,
                  ) - features[j].start_ms,
                ]
              : [],
          ),
        )
        .sort((a, b) => a - b),
    [prepared, bundles, features],
  );
  const playback = useComparison(0, duration, barriers),
    { time, seek, pause } = playback;
  useEffect(() => {
    if (!active) pause();
  }, [active, pause]);
  const times = useMemo(
    () =>
      [
        ...new Set(
          prepared.flatMap((p, j) =>
            bundles[j].frames
              .slice(p.first, p.last + 1)
              .map((f) => f.source_timestamp_ms - features[j].start_ms),
          ),
        ),
      ].sort((a, b) => a - b),
    [prepared, bundles, features],
  );
  return (
    <section
      className="action-observed"
      data-testid="action-replay"
      data-time-ms={Math.round(time)}
      aria-label="Observed query and matched path replays"
    >
      <div className="action-replay-heading">
        <div>
          <p className="eyebrow">Observed source frames</p>
          <h3>Replay the two paths.</h3>
        </div>
        <strong>{(time / 1000).toFixed(3)} s from each observed start</strong>
      </div>
      <div className="action-transport">
        <button type="button" onClick={() => seek(0)}>
          Replay starts
        </button>
        <button
          type="button"
          aria-label="Previous path observation"
          onClick={() => seek([...times].reverse().find((t) => t < time) ?? 0)}
          disabled={time <= 0}
        >
          ‹
        </button>
        <button
          type="button"
          aria-label={
            playback.playing ? "Pause path comparison" : "Play path comparison"
          }
          onClick={playback.toggle}
          aria-pressed={playback.playing}
        >
          {playback.playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          aria-label="Next path observation"
          onClick={() => seek(times.find((t) => t > time) ?? duration)}
          disabled={time >= duration}
        >
          ›
        </button>
        <label>
          Play rate
          <select
            aria-label="Path replay rate"
            value={playback.speed}
            onChange={(e) => playback.setSpeed(Number(e.target.value))}
          >
            {[0.25, 0.5, 1, 2].map((n) => (
              <option key={n} value={n}>
                {n}×
              </option>
            ))}
          </select>
        </label>
      </div>
      <input
        type="range"
        aria-label="Path comparison time"
        min="0"
        max={duration}
        step="1"
        value={Math.round(time)}
        onChange={(e) => seek(Number(e.target.value))}
      />
      {playback.pausedAtBreak && (
        <p className="tracking-notice" role="status">
          Paused at a source tracking break. No motion is reconstructed across
          gaps.
        </p>
      )}
      <div className="action-replay-panes">
        {features.map((f, j) => {
          const p = prepared[j],
            bundle = bundles[j],
            index = pathFrameAt(bundle, p.first, p.last, time),
            frame = index === null ? null : bundle.frames[index];
          return (
            <article
              key={j}
              className="action-replay-pane"
              data-testid={`action-replay-${j}`}
              data-frame-index={index ?? "unavailable"}
            >
              <div className="path-source-heading">
                <span className={`cohort-letter ${j ? "b" : "a"}`}>
                  {j ? "B" : "A"}
                </span>
                <div>
                  <strong>
                    {j ? "Match" : "Query"} · {f.player_name}
                  </strong>
                  <span>
                    {games[j]?.away_team} at {games[j]?.home_team} ·{" "}
                    {games[j]?.game_date}
                  </span>
                </div>
              </div>
              <p>
                {frame
                  ? `Q${frame.period} ${frame.quality_flags.includes("game_clock_out_of_range") ? "Clock unavailable" : trackingClock(frame.game_clock_s)} · window +${frame.elapsed_s.toFixed(3)} s`
                  : "No observed positions at this comparison time"}
              </p>
              {index !== null && games[j] ? (
                <ReplayCourt
                  bundle={bundle}
                  game={games[j]}
                  snapshots={p.snapshots}
                  index={index}
                  selectedPlayer={f.player_id}
                  onSelect={selectNoop}
                  trails
                  connector={false}
                  spread={false}
                  focus
                  interactive={false}
                  trailStart={p.first}
                />
              ) : (
                <svg
                  viewBox="-3 -5 100 60"
                  className="replay-court"
                  role="img"
                  aria-label="Path positions unavailable"
                >
                  <rect width="94" height="50" fill="#cfb58d" />
                  {courtMarkings}
                  <text
                    x="47"
                    y="25"
                    textAnchor="middle"
                    className="conflict-caption"
                  >
                    No observed sample in this interval
                  </text>
                </svg>
              )}
              <p>
                {frame
                  ? `${Math.round(frame.source_timestamp_ms - f.start_ms)} ms observed · offset ${Math.round(frame.source_timestamp_ms - f.start_ms - time)} ms. ${p.snapshots[index!].issues.join(" ")}`
                  : "The recorded path has ended; its last positions are not retained."}
              </p>
              <small>
                {f.observed_frames} observed frames · actual span{" "}
                {(f.actual_duration_ms / 1000).toFixed(3)} s · scoring uses 21
                samples.
              </small>
            </article>
          );
        })}
      </div>
      <p className="definition">
        Replays align actual observed starts and preserve each recorded
        duration. No time warping, position interpolation, or
        attacking-direction normalization. The feature samples lie on nominal
        100 ms targets within 20 ms; playback uses the original source cadence.
      </p>
    </section>
  );
}
