import { useEffect, useMemo, useState } from "react";
import { clock, getReplay, trackingClock } from "../data";
import type { Game, ReplayBundle, Shot, SourceEvent } from "../types";
import {
  analyzeReplay,
  eventMarker,
  isBreak,
  playerMetrics,
  type BasketReference,
} from "./analysis";
import { MetricChart } from "./MetricChart";
import { ReplayCourt } from "./ReplayCourt";
import { usePlayback } from "./usePlayback";

export function ReplayLoader({ shot, game }: { shot: Shot; game: Game }) {
  const [bundle, setBundle] = useState<ReplayBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const segment = shot.tracking_join.segment_id;
  useEffect(() => {
    if (shot.tracking_join.status !== "matched" || !segment) return;
    const controller = new AbortController();
    getReplay(game.game_id, segment, controller.signal)
      .then((data) => {
        if (data.source_event_id !== shot.source_event_id)
          throw new Error(
            "The window source event does not match this attempt.",
          );
        setBundle(data);
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [game.game_id, segment, shot.tracking_join.status, shot.source_event_id]);
  if (shot.tracking_join.status !== "matched" || !segment)
    return (
      <section
        className="replay-empty"
        aria-label="Tracking replay unavailable"
      >
        <p className="eyebrow">Tracking replay</p>
        <h2>Tracking match unavailable</h2>
        <p>
          {shot.tracking_join.reason ??
            "This attempt has no verified tracking window."}
        </p>
        <small>
          {shot.tracking_join.status === "ambiguous"
            ? "Ambiguous source matches require inspection."
            : "Select another attempt or one of the audited examples."}
        </small>
      </section>
    );
  if (error)
    return (
      <section className="replay-empty" role="alert">
        <h2>Tracking window unavailable</h2>
        <p>{error}</p>
      </section>
    );
  if (!bundle)
    return (
      <section className="replay-empty" role="status">
        Loading the observed tracking window…
      </section>
    );
  return <ReplayView bundle={bundle} shot={shot} game={game} />;
}

function ReplayView({
  bundle,
  shot,
  game,
}: {
  bundle: ReplayBundle;
  shot: Shot;
  game: Game;
}) {
  const [selectedPlayer, setSelectedPlayer] = useState(shot.player_id);
  const [reference, setReference] = useState<BasketReference>("nearer");
  const [trails, setTrails] = useState(true);
  const [connector, setConnector] = useState(false);
  const [spread, setSpread] = useState(false);
  const [focus, setFocus] = useState(false);
  const playback = usePlayback(bundle.frames);
  const { index, seek } = playback;
  const snapshots = useMemo(
    () => analyzeReplay(bundle, reference),
    [bundle, reference],
  );
  const observedPlayers = useMemo(() => {
    const observed = new Set(
      bundle.frames.flatMap((f) =>
        f.entities.filter((e) => e.kind === "player").map((e) => e.entity_id),
      ),
    );
    return bundle.players.filter(
      (p) => observed.has(p.player_id) || p.player_id === shot.player_id,
    );
  }, [bundle, shot.player_id]);
  const shotEvent: SourceEvent = useMemo(
    () =>
      bundle.events.find((e) => e.source_event_id === shot.source_event_id) ?? {
        event_id: shot.shot_id,
        source_event_id: shot.source_event_id,
        game_id: shot.game_id,
        period: shot.period,
        game_clock_s: shot.game_clock_s,
        description: `${shot.player_name} · ${shot.action_type}`,
        event_type: shot.made ? 1 : 2,
      },
    [bundle.events, shot],
  );
  const marker = useMemo(
    () => eventMarker(bundle.frames, shotEvent),
    [bundle.frames, shotEvent],
  );
  const eventMarkers = useMemo(
    () => bundle.events.map((e) => eventMarker(bundle.frames, e)),
    [bundle],
  );
  const series = useMemo(
    () => snapshots.map((s) => playerMetrics(s, selectedPlayer)),
    [snapshots, selectedPlayer],
  );
  const basketSeries = useMemo(() => series.map((s) => s.basket), [series]);
  const defenderSeries = useMemo(() => series.map((s) => s.defender), [series]);
  const speedSeries = useMemo(() => series.map((s) => s.speed), [series]);
  const frame = bundle.frames[index];
  const snapshot = snapshots[index];
  const ball = snapshot.entities.get("ball");
  const player = bundle.players.find((p) => p.player_id === selectedPlayer);
  const breaks = useMemo(
    () =>
      bundle.frames.flatMap((f, i) =>
        i > 0 && isBreak(bundle.frames[i - 1], f) ? [i] : [],
      ),
    [bundle.frames],
  );
  const nextBreak = breaks.find((i) => i > index);
  const duration = bundle.frames[bundle.frames.length - 1].elapsed_s;
  const timeExtent = duration || 0.04;
  return (
    <section
      className="replay-panel"
      aria-label="Tracking replay"
      tabIndex={0}
      data-testid="replay-panel"
      data-frame-index={index}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('input, select, textarea, button, [role="button"]'))
          return;
        if (event.key === " ") {
          event.preventDefault();
          playback.toggle();
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          seek(index + (event.shiftKey ? 10 : 1));
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          seek(index - (event.shiftKey ? 10 : 1));
        }
        if (event.key === "Home") {
          event.preventDefault();
          seek(0);
        }
        if (event.key === "End") {
          event.preventDefault();
          seek(bundle.frames.length - 1);
        }
      }}
    >
      <div className="replay-heading">
        <div>
          <p className="eyebrow">Observed movement · Nominal 25 Hz</p>
          <h2>Tracking replay</h2>
        </div>
        <span className={`window-badge ${bundle.continuity}`}>
          {bundle.continuity === "continuous"
            ? "Continuous window"
            : "Partial window"}
        </span>
      </div>
      <div className="replay-scoreboard">
        <span>
          {frame.period > 4 ? `OT${frame.period - 4}` : `Q${frame.period}`}{" "}
          <strong>
            {frame.quality_flags.includes("game_clock_out_of_range")
              ? "Unavailable"
              : trackingClock(frame.game_clock_s)}
          </strong>
        </span>
        <span>
          Shot clock{" "}
          <strong>
            {frame.shot_clock_s === null ||
            frame.quality_flags.includes("shot_clock_out_of_range")
              ? "Unavailable"
              : frame.shot_clock_s.toFixed(1)}
          </strong>
        </span>
        <span>
          Ball height{" "}
          <strong>
            {ball?.z_ft == null ||
            frame.quality_flags.includes("ball_height_out_of_range")
              ? "Unavailable"
              : `${ball.z_ft.toFixed(1)} ft`}
          </strong>
        </span>
      </div>
      <ReplayCourt
        bundle={bundle}
        game={game}
        snapshots={snapshots}
        index={index}
        selectedPlayer={selectedPlayer}
        onSelect={setSelectedPlayer}
        trails={trails}
        connector={connector}
        spread={spread}
        focus={focus}
      />
      <div className="team-legend">
        <span>
          <i className="team-away" />
          {game.away_team}
        </span>
        <span>
          <i className="team-home" />
          {game.home_team}
        </span>
        <span>
          <i className="ball-dot" />
          Ball
        </span>
        <span>
          {snapshot.issues.length
            ? snapshot.issues.join(" ")
            : "10 players + ball observed"}
        </span>
      </div>
      <div className="playback-controls">
        <div className="transport">
          <button
            type="button"
            onClick={() => seek(0)}
            aria-label="First frame"
            title="First frame (Home)"
          >
            |‹
          </button>
          <button
            type="button"
            onClick={() => seek(index - 1)}
            disabled={index === 0}
            aria-label="Previous frame"
            title="Previous frame (←)"
          >
            ‹
          </button>
          <button
            type="button"
            className="play-button"
            onClick={playback.toggle}
            aria-pressed={playback.playing}
            aria-label={playback.playing ? "Pause tracking" : "Play tracking"}
          >
            {playback.playing ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            onClick={() => seek(index + 1)}
            disabled={index === bundle.frames.length - 1}
            aria-label="Next frame"
            title="Next frame (→)"
          >
            ›
          </button>
          <button
            type="button"
            onClick={() => seek(bundle.frames.length - 1)}
            aria-label="Last frame"
            title="Last frame (End)"
          >
            ›|
          </button>
        </div>
        <label className="speed-control">
          Speed
          <select
            aria-label="Playback speed"
            value={playback.speed}
            onChange={(e) => playback.setSpeed(Number(e.target.value))}
          >
            {[0.25, 0.5, 1, 2].map((speed) => (
              <option key={speed} value={speed}>
                {speed}×
              </option>
            ))}
          </select>
        </label>
        <span className="elapsed-time">
          {frame.elapsed_s.toFixed(2)} / {duration.toFixed(2)} s
        </span>
      </div>
      <div className="frame-timeline">
        <div className="timeline-markers" aria-hidden="true">
          {breaks.map((i) => (
            <i
              key={i}
              style={{
                left: `${(bundle.frames[i].elapsed_s / timeExtent) * 100}%`,
              }}
            />
          ))}
          {marker.ranges.map((range, i) => (
            <span
              key={i}
              style={{
                left: `${(bundle.frames[range.start].elapsed_s / timeExtent) * 100}%`,
                width: `${Math.max(0.4, ((bundle.frames[range.end].elapsed_s - bundle.frames[range.start].elapsed_s) / timeExtent) * 100)}%`,
              }}
            />
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={bundle.frames.length - 1}
          value={index}
          step={1}
          aria-label="Tracking frame"
          aria-valuetext={`Frame ${index + 1} of ${bundle.frames.length}, ${frame.elapsed_s.toFixed(2)} elapsed seconds`}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <div className="frame-caption">
          <span>
            Frame {index + 1} / {bundle.frames.length}
          </span>
          <span>
            Amber: approximate event-clock range · Rust: tracking breaks
          </span>
        </div>
      </div>
      {playback.pausedAtBreak && (
        <p className="tracking-notice" role="status">
          Paused at a tracking break. No movement is reconstructed across the
          break. Step or press Play to continue.
        </p>
      )}
      {index > 0 &&
        isBreak(bundle.frames[index - 1], frame) &&
        !playback.pausedAtBreak && (
          <p className="tracking-notice">
            This observation follows a tracking break.
          </p>
        )}
      <div className="event-jumps">
        <button
          type="button"
          onClick={() => marker.frameIndex !== null && seek(marker.frameIndex)}
          disabled={marker.frameIndex === null}
        >
          Shot event ≈
        </button>
        <button
          type="button"
          onClick={() => nextBreak !== undefined && seek(nextBreak)}
          disabled={nextBreak === undefined}
        >
          Next break
        </button>
        <label>
          Event jump
          <select
            aria-label="Jump to event clock"
            value=""
            onChange={(e) => {
              const selected = eventMarkers.find(
                (m) => m.event.event_id === e.target.value,
              );
              if (
                selected?.frameIndex !== null &&
                selected?.frameIndex !== undefined
              )
                seek(selected.frameIndex);
            }}
          >
            <option value="">Choose a recorded event</option>
            {eventMarkers.map((m) => (
              <option
                key={m.event.event_id}
                value={m.event.event_id}
                disabled={m.frameIndex === null}
              >
                {clock(m.event.game_clock_s)} ·{" "}
                {m.event.description || `Event ${m.event.source_event_id}`}
                {m.frameIndex === null ? ` (${m.status})` : " ≈"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="timing-note">
        Event clocks are approximate (±1 s), not shot-release annotations.
        {marker.status !== "approximate"
          ? ` This shot's event-clock mapping is ${marker.status}.`
          : ""}{" "}
        Space: play/pause · ←/→: frame · Shift: 10 frames.
      </p>
      <div className="analysis-controls">
        <label>
          Tracked player
          <select
            aria-label="Tracked player"
            value={selectedPlayer}
            onChange={(e) => setSelectedPlayer(e.target.value)}
          >
            {observedPlayers.map((p) => (
              <option key={p.player_id} value={p.player_id}>
                {p.name} · #{p.jersey}
              </option>
            ))}
          </select>
        </label>
        <label>
          Basket reference
          <select
            aria-label="Basket reference"
            value={reference}
            onChange={(e) => setReference(e.target.value as BasketReference)}
          >
            <option value="nearer">Nearer rim</option>
            <option value="left">Left rim</option>
            <option value="right">Right rim</option>
          </select>
        </label>
      </div>
      <div className="overlay-controls">
        <label>
          <input
            type="checkbox"
            checked={focus}
            onChange={(e) => setFocus(e.target.checked)}
          />
          Focus selected player
        </label>
        <label>
          <input
            type="checkbox"
            checked={trails}
            onChange={(e) => setTrails(e.target.checked)}
          />
          Movement trails
        </label>
        <label>
          <input
            type="checkbox"
            checked={connector}
            onChange={(e) => setConnector(e.target.checked)}
          />
          Nearest opponent
        </label>
        <label>
          <input
            type="checkbox"
            checked={spread}
            onChange={(e) => setSpread(e.target.checked)}
          />
          Team spread
        </label>
      </div>
      <div className="selected-player-heading">
        <strong>{player?.name ?? "Player unavailable"}</strong>
        <span>Derived from recorded positions</span>
      </div>
      <div className="metric-grid">
        <MetricChart
          label={
            reference === "nearer"
              ? "Distance to nearer rim"
              : `Distance to ${reference} rim`
          }
          unit="ft"
          values={basketSeries}
          frames={bundle.frames}
          index={index}
          marker={marker}
          onSeek={seek}
        />
        <MetricChart
          label="Nearest tracked opponent"
          unit="ft"
          values={defenderSeries}
          frames={bundle.frames}
          index={index}
          marker={marker}
          onSeek={seek}
        />
        <MetricChart
          label="Movement speed"
          unit="ft/s"
          values={speedSeries}
          frames={bundle.frames}
          index={index}
          marker={marker}
          onSeek={seek}
        />
      </div>
      {spread && (
        <div className="spread-readout">
          {snapshot.teams.map((team) => (
            <span key={team.teamId}>
              <strong>
                {team.teamId === game.home_team_id
                  ? game.home_team
                  : game.away_team}
              </strong>{" "}
              {team.count}/5 tracked · RMS spread{" "}
              {team.rms === null ? "unavailable" : `${team.rms.toFixed(1)} ft`}
            </span>
          ))}
          <small>
            Circle radius is RMS distance from the tracked team centroid. Dashed
            circles use partial teams.
          </small>
        </div>
      )}
      <a className="view-replay-link" href="#movement">
        Explore annotated off-ball sequences →
      </a>
      <details className="replay-data-notes">
        <summary>Window quality & measurement definitions</summary>
        <p>
          {bundle.segment_id} · Source event {bundle.source_event_id} ·{" "}
          {bundle.frames.length} observed frames.
        </p>
        <ul>
          {bundle.quality_findings.map((f) => (
            <li key={f.code}>
              {f.count}: {f.description}
            </li>
          ))}
        </ul>
        <p>
          Speed uses a backward-looking linear fit to five consecutive
          observations (about 0.16 s). Gaps, missing player history, and
          conflicts make it unavailable. Distances are in source court feet.
          Opposing-team proximity does not establish a defensive assignment or
          contest quality.
        </p>
        <p>
          Positions advance at their recorded sample times without
          interpolation. Missing entities disappear; conflicting timestamp
          positions are hidden. Attacking direction and exact shot release
          remain unavailable.
        </p>
        <p>
          Source fingerprint{" "}
          <code>{bundle.provenance.source_fingerprint.slice(0, 20)}…</code> ·{" "}
          {bundle.provenance.pipeline_version}
        </p>
      </details>
    </section>
  );
}
