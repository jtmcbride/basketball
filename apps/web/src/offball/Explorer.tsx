import { useEffect, useMemo, useState } from "react";
import { getReplay, trackingClock } from "../data";
import type { Audit, Game, ReplayBundle } from "../types";
import { ReplayCourt, courtMarkings } from "../replay/ReplayCourt";
import {
  analyzeMovement,
  nextTime,
  observedTimes,
  sampleAt,
  signedSeconds,
  type MovementSequence,
} from "./analysis";
import {
  bindClient,
  type AnnotationSet,
  type BoundSequence,
  type Sequence,
} from "./model";
import { ComparisonChart } from "./ComparisonChart";
import { useComparison } from "./useComparison";
import "./movement.css";

export function OffballExplorer({
  audit,
  auditError,
}: {
  audit: Audit | null;
  auditError: string | null;
}) {
  const [index, setIndex] = useState<AnnotationSet | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/annotations", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 503
              ? "Load the tracking sample with make fetch and make audit, and keep annotations/curated-v1.json available."
              : "The annotation catalog could not be loaded. Check the local source and annotation format.",
          );
        const data: AnnotationSet = await response.json();
        if (
          data.schema_version !== "basketball-annotations-v1" ||
          !Array.isArray(data.sequences)
        )
          throw new Error("Unsupported annotation format.");
        if (!controller.signal.aborted) setIndex(data);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  if (error || auditError)
    return (
      <section className="empty-state" role="alert">
        <h2>Off-ball explorer unavailable</h2>
        <p>{error ?? auditError}</p>
      </section>
    );
  if (!index || !audit)
    return (
      <p className="message" role="status">
        Checking annotated source windows…
      </p>
    );
  if (!index.sequences.some((s) => s.status === "available"))
    return (
      <section className="empty-state">
        <h2>No annotations match this source</h2>
        {index.sequences.map((s) => (
          <p key={s.sequence_id}>
            {s.title}: {s.reason}
          </p>
        ))}
      </section>
    );
  return <SequenceChooser collection={index} audit={audit} />;
}
function SequenceChooser({
  collection,
  audit,
}: {
  collection: AnnotationSet;
  audit: Audit;
}) {
  const available = collection.sequences.filter(
    (s) => s.status === "available",
  );
  const [a, setA] = useState({
    id: available[0].sequence_id,
    anchor: available[0].default_anchor_id,
  });
  const [b, setB] = useState({
    id: (available[1] ?? available[0]).sequence_id,
    anchor: (available[1] ?? available[0]).default_anchor_id,
  });
  const sequences = [
    collection.sequences.find((s) => s.sequence_id === a.id)!,
    collection.sequences.find((s) => s.sequence_id === b.id)!,
  ];
  const [loaded, setLoaded] = useState<{
    key: string;
    bundles?: ReplayBundle[];
    error?: string;
  }>({ key: "" });
  const key = sequences.map((s) => `${s.game_id}/${s.segment_id}`).join("|");
  useEffect(() => {
    const controller = new AbortController(),
      pending = new Map<string, Promise<ReplayBundle>>();
    const promises = sequences.map((s) => {
      const id = `${s.game_id}/${s.segment_id}`;
      if (!pending.has(id))
        pending.set(id, getReplay(s.game_id, s.segment_id, controller.signal));
      return pending.get(id)!;
    });
    Promise.all(promises)
      .then((bundles) => {
        if (!controller.signal.aborted) setLoaded({ key, bundles });
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setLoaded({ key, error: e.message });
      });
    return () => controller.abort();
  }, [key]);
  let bound: BoundSequence[] | null = null,
    bindingError: string | null = null;
  if (loaded.key === key && loaded.bundles) {
    try {
      bound = sequences.map((s, i) =>
        bindClient(collection, s, loaded.bundles![i], i ? b.anchor : a.anchor),
      );
    } catch (e) {
      bindingError = (e as Error).message;
    }
  }
  const error = bindingError ?? (loaded.key === key ? loaded.error : null);
  return (
    <div className="movement-explorer">
      <div className="movement-intro">
        <div>
          <p className="eyebrow">Off-ball movement explorer</p>
          <h2>Before the ball arrives.</h2>
        </div>
        <p>
          Follow one player through recorded positions, then compare the
          approach to a second annotated reference.
        </p>
      </div>
      <p className="curation-notice">
        <strong>
          {collection.dataset_kind === "synthetic"
            ? "Generated fixture"
            : "Tracking-review annotations"}{" "}
          · revision {collection.revision}.
        </strong>{" "}
        {collection.description} Reference zero is a selected frame inside the
        reviewer’s uncertainty interval; it is not proof of a catch, possession,
        or shot release.
      </p>
      <div className="sequence-selectors">
        {sequences.map((s, i) => (
          <section key={i} aria-label={`Sequence ${i ? "B" : "A"} selection`}>
            <label>
              Sequence {i ? "B" : "A"}
              <select
                aria-label={`Sequence ${i ? "B" : "A"}`}
                value={s.sequence_id}
                onChange={(e) => {
                  const next = collection.sequences.find(
                    (v) => v.sequence_id === e.target.value,
                  )!;
                  (i ? setB : setA)({
                    id: next.sequence_id,
                    anchor: next.default_anchor_id,
                  });
                }}
              >
                {collection.sequences.map((v) => (
                  <option
                    key={v.sequence_id}
                    value={v.sequence_id}
                    disabled={v.status !== "available"}
                  >
                    {v.title}
                    {v.status !== "available" ? ` — ${v.reason}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Alignment reference {i ? "B" : "A"}
              <select
                aria-label={`Alignment reference ${i ? "B" : "A"}`}
                value={i ? b.anchor : a.anchor}
                onChange={(e) =>
                  (i ? setB : setA)({
                    id: s.sequence_id,
                    anchor: e.target.value,
                  })
                }
              >
                {s.annotations.map((v) => (
                  <option key={v.annotation_id} value={v.annotation_id}>
                    {v.label} · {v.confidence}
                  </option>
                ))}
              </select>
            </label>
          </section>
        ))}
      </div>
      {error ? (
        <section className="empty-state" role="alert">
          <h3>Comparison unavailable</h3>
          <p>{error}</p>
        </section>
      ) : bound ? (
        <Comparison
          key={`${key}|${a.anchor}|${b.anchor}`}
          bound={bound}
          games={bound.map(
            (s) => audit.games.find((g) => g.game_id === s.sequence.game_id)!,
          )}
          collection={collection}
        />
      ) : (
        <p className="message" role="status">
          Loading both observed sequences…
        </p>
      )}
      <details className="movement-method">
        <summary>Annotation format & automatic-label availability</summary>
        <p>
          {collection.automatic_labels.reason} No automatic catch, screen, cut,
          or release labels are shown.
        </p>
        <p>
          Collection {collection.collection_id}, revision {collection.revision},{" "}
          {collection.schema_version}. Curation supports catch, release, screen,
          cut, relocation and uncertain annotations, exact frame references,
          reviewer provenance, confidence, and bounded timing uncertainty.
        </p>
        <p>
          Source fingerprint <code>{collection.source_fingerprint}</code> ·{" "}
          {collection.pipeline_version}. Annotation validation rejects changed
          sources, unknown frames and conflicting anchors. Tracking reviews
          alone cannot validate ball control or screens.
        </p>
        <p>
          Versioned curation lives in annotations/curated-v1.json. The offline
          candidate evaluation report documents held-out eligibility;
          provisional labels are excluded from precision/recall.
        </p>
      </details>
    </div>
  );
}
function Comparison({
  bound,
  games,
  collection,
}: {
  bound: BoundSequence[];
  games: Game[];
  collection: AnnotationSet;
}) {
  const [before, setBefore] = useState(2),
    [after, setAfter] = useState(1.5);
  const [focus, setFocus] = useState(true),
    [connector, setConnector] = useState(true);
  const [players, setPlayers] = useState(
    bound.map((s) => s.sequence.player_id),
  );
  const sequences = useMemo(
    () =>
      bound.map((s, i) =>
        analyzeMovement({
          ...s,
          sequence: { ...s.sequence, player_id: players[i] },
        }),
      ),
    [bound, players],
  );
  // Range changes remount only the transport, preserving focused players and selected sources.
  return (
    <ComparisonTransport
      key={`${before}:${after}`}
      sequences={sequences}
      bound={bound}
      games={games}
      collection={collection}
      before={before}
      after={after}
      setBefore={setBefore}
      setAfter={setAfter}
      focus={focus}
      setFocus={setFocus}
      connector={connector}
      setConnector={setConnector}
      setPlayer={(i, id) =>
        setPlayers((values) => values.map((v, j) => (i === j ? id : v)))
      }
    />
  );
}
function ComparisonTransport({
  sequences,
  bound,
  games,
  collection,
  before,
  after,
  setBefore,
  setAfter,
  focus,
  setFocus,
  connector,
  setConnector,
  setPlayer,
}: {
  sequences: MovementSequence[];
  bound: BoundSequence[];
  games: Game[];
  collection: AnnotationSet;
  before: number;
  after: number;
  setBefore: (n: number) => void;
  setAfter: (n: number) => void;
  focus: boolean;
  setFocus: (v: boolean) => void;
  connector: boolean;
  setConnector: (v: boolean) => void;
  setPlayer: (i: number, id: string) => void;
}) {
  const start = -before * 1000,
    end = after * 1000;
  const barriers = useMemo(
    () =>
      [
        ...new Set(
          sequences
            .flatMap((s) => s.barriers)
            .filter((t) => t > start && t <= end),
        ),
      ].sort((a, b) => a - b),
    [sequences, start, end],
  );
  const times = useMemo(
    () => observedTimes(sequences, start, end),
    [sequences, start, end],
  );
  const playback = useComparison(start, end, barriers),
    { time, seek } = playback;
  const focusCallbacks = useMemo(
    () =>
      sequences.map((_, i) => (id: string) => {
        playback.pause();
        setPlayer(i, id);
      }),
    [setPlayer, playback.pause, sequences.length],
  );
  return (
    <section
      className="movement-comparison"
      data-testid="movement-comparison"
      data-time-ms={Math.round(time)}
      tabIndex={0}
      aria-label="Aligned movement comparison"
      onKeyDown={(e) => {
        if (
          (e.target as HTMLElement).closest(
            'input,select,button,[role="button"]',
          )
        )
          return;
        if (e.key === " ") {
          e.preventDefault();
          playback.toggle();
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          seek(nextTime(times, time, e.key === "ArrowLeft" ? -1 : 1));
        }
        if (e.key === "Home") {
          e.preventDefault();
          seek(start);
        }
        if (e.key === "End") {
          e.preventDefault();
          seek(end);
        }
      }}
    >
      <div className="alignment-controls">
        <label>
          Before reference
          <select
            aria-label="Seconds before reference"
            value={before}
            onChange={(e) => setBefore(Number(e.target.value))}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n} s
              </option>
            ))}
          </select>
        </label>
        <label>
          After reference
          <select
            aria-label="Seconds after reference"
            value={after}
            onChange={(e) => setAfter(Number(e.target.value))}
          >
            {[0.5, 1, 1.5, 2].map((n) => (
              <option key={n} value={n}>
                {n} s
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={focus}
            onChange={(e) => setFocus(e.target.checked)}
          />
          Dim other players & trails
        </label>
        <label>
          <input
            type="checkbox"
            checked={connector}
            onChange={(e) => setConnector(e.target.checked)}
          />
          Nearest-opponent connector
        </label>
      </div>
      <div className="comparison-transport">
        <div className="transport">
          <button
            type="button"
            aria-label="Previous observed comparison time"
            disabled={time <= times[0]}
            onClick={() => seek(nextTime(times, time, -1))}
          >
            ‹
          </button>
          <button
            type="button"
            className="play-button"
            aria-label={
              playback.playing ? "Pause comparison" : "Play comparison"
            }
            aria-pressed={playback.playing}
            onClick={playback.toggle}
          >
            {playback.playing ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            aria-label="Next observed comparison time"
            disabled={time >= times.at(-1)!}
            onClick={() => seek(nextTime(times, time, 1))}
          >
            ›
          </button>
          <button type="button" onClick={() => seek(0)}>
            Jump to reference
          </button>
        </div>
        <label>
          Play rate
          <select
            aria-label="Comparison play rate"
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
        <div className="relative-clock">
          <strong>{signedSeconds(time)}</strong>
          <span>relative to reference</span>
        </div>
      </div>
      <input
        type="range"
        className="comparison-slider"
        aria-label="Comparison time"
        min={start}
        max={end}
        step={1}
        value={Math.round(time)}
        aria-valuetext={`${signedSeconds(time)} relative to reference`}
        onChange={(e) => seek(Number(e.target.value))}
      />
      <div className="comparison-time-labels">
        <span>{signedSeconds(start)}</span>
        <span>0 · selected references</span>
        <span>{signedSeconds(end)}</span>
      </div>
      {playback.pausedAtBreak && (
        <p className="tracking-notice" role="status">
          Paused at a tracking break in one sequence. No positions are filled
          across the gap. Press Play to continue.
        </p>
      )}
      <p className="alignment-definition">
        Same elapsed seconds in both panes. No duration normalization, time
        warping, spatial mirroring, or interpolation. Play rate changes
        wall-clock playback only. Blue/orange bands in the charts show each
        reviewer’s timing interval.
      </p>
      <div className="movement-panes">
        {sequences.map((s, i) => (
          <SequencePane
            key={i}
            sequence={s}
            annotationPlayer={bound[i].sequence.player_id}
            game={games[i]}
            side={i ? "B" : "A"}
            time={time}
            start={start}
            focus={focus}
            connector={connector}
            collection={collection}
            onPlayer={focusCallbacks[i]}
          />
        ))}
      </div>
      <div className="movement-charts">
        <ComparisonChart
          sequences={sequences}
          metric="opponent"
          label="Nearest tracked opponent"
          unit="ft"
          start={start}
          end={end}
          time={time}
          onSeek={seek}
        />
        <ComparisonChart
          sequences={sequences}
          metric="ball"
          label="Ball separation in court plane"
          unit="ft"
          start={start}
          end={end}
          time={time}
          onSeek={seek}
        />
        <ComparisonChart
          sequences={sequences}
          metric="heading"
          label="Movement heading · source axes"
          unit="degrees"
          start={start}
          end={end}
          time={time}
          onSeek={seek}
        />
      </div>
      <p className="definition">
        Nearest opponent requires five observed opponents; proximity does not
        identify a defensive assignment. Ball separation ignores height and does
        not establish possession. Heading is a backward five-observation
        velocity fit, withheld below 1 ft/s or across gaps; 0° follows source +x
        and +90° follows source +y. Paths break at ±180° wraps. Attacking
        direction is unavailable.
      </p>
    </section>
  );
}
function SequencePane({
  sequence: s,
  annotationPlayer,
  game,
  side,
  time,
  start,
  focus,
  connector,
  collection,
  onPlayer,
}: {
  sequence: MovementSequence;
  annotationPlayer: string;
  game: Game;
  side: "A" | "B";
  time: number;
  start: number;
  focus: boolean;
  connector: boolean;
  collection: AnnotationSet;
  onPlayer: (id: string) => void;
}) {
  const sample = sampleAt(s, time),
    frame = sample ? s.bundle.frames[sample.index] : null;
  const first =
    s.points.find((p) => p.timeMs >= start)?.index ?? s.sequence.start_index;
  const player = s.bundle.players.find(
      (p) => p.player_id === s.sequence.player_id,
    ),
    annotated = s.bundle.players.find((p) => p.player_id === annotationPlayer);
  const low =
      s.bundle.frames[s.annotation.start_index].source_timestamp_ms -
      s.anchorMs,
    high =
      s.bundle.frames[s.annotation.end_index].source_timestamp_ms - s.anchorMs;
  const offset =
    (s.anchorMs - s.bundle.frames[s.sequence.start_index].source_timestamp_ms) /
    1000;
  return (
    <article
      className={`movement-pane side-${side.toLowerCase()}`}
      aria-label={`Movement pane ${side}`}
      data-testid={`movement-pane-${side}`}
      data-frame-index={sample?.index ?? "unavailable"}
    >
      <div className="movement-pane-heading">
        <span className={`cohort-letter ${side.toLowerCase()}`}>{side}</span>
        <div>
          <h3>{s.sequence.title}</h3>
          <span>
            {game?.away_team ?? "Away"} at {game?.home_team ?? "Home"} ·{" "}
            {game?.game_date ?? s.sequence.game_id}
          </span>
        </div>
      </div>
      <label className="movement-focus-label">
        Focused player {side}
        <select
          aria-label={`Focused player ${side}`}
          value={s.sequence.player_id}
          onChange={(e) => onPlayer(e.target.value)}
        >
          {s.bundle.players.map((p) => (
            <option key={p.player_id} value={p.player_id}>
              {p.name} · #{p.jersey}
            </option>
          ))}
        </select>
      </label>
      <div className="annotation-badge">
        <strong>{s.annotation.label}</strong>
        <span>
          {s.annotation.confidence} · {s.annotation.basis.replaceAll("_", " ")}
        </span>
      </div>
      <div className="movement-sample">
        <span>
          {frame
            ? `Q${frame.period} ${frame.quality_flags.includes("game_clock_out_of_range") ? "Clock unavailable" : trackingClock(frame.game_clock_s)}`
            : "No observed sample at this time"}
        </span>
        <span>
          {frame
            ? `Window elapsed ${frame.elapsed_s.toFixed(3)} s`
            : "Outside coverage or in a source gap"}
        </span>
      </div>
      {sample && game ? (
        <ReplayCourt
          bundle={s.bundle}
          game={game}
          snapshots={s.snapshots}
          index={sample.index}
          selectedPlayer={s.sequence.player_id}
          onSelect={onPlayer}
          trails
          connector={connector}
          spread={false}
          focus={focus}
          trailStart={first}
        />
      ) : (
        <svg
          viewBox="-3 -5 100 60"
          className="replay-court"
          role="img"
          aria-label="Sequence positions unavailable"
        >
          <rect width="94" height="50" fill="#cfb58d" />
          {courtMarkings}
          <rect x="12" y="20" width="70" height="10" fill="#f7f9fa" />
          <text x="47" y="26" textAnchor="middle" className="conflict-caption">
            No observed positions at this relative time
          </text>
        </svg>
      )}
      <p className="sample-offset">
        {sample
          ? `Observed relative time ${signedSeconds(sample.timeMs)} · sample offset ${Math.round(sample.timeMs - time)} ms`
          : "No prior positions are retained through this interval."}
      </p>
      {sample && (
        <p className="sample-issues">
          {[
            ...s.snapshots[sample.index].issues,
            ...(!s.snapshots[sample.index].entities.has(s.sequence.player_id)
              ? ["Focused player is not observed in this frame."]
              : []),
          ].join(" ") ||
            `${player?.name ?? "Selected player"} and source entities observed.`}
        </p>
      )}
      {annotationPlayer !== s.sequence.player_id && (
        <p className="tracking-notice">
          Reference annotation belongs to {annotated?.name ?? annotationPlayer};
          changing focus does not relabel it as a {player?.name} event.
        </p>
      )}
      <p className="anchor-offset">
        Reference at window +
        {s.bundle.frames[s.annotation.anchor_index].elapsed_s.toFixed(3)} s · +
        {offset.toFixed(3)} s from curated clip start. Timing interval{" "}
        {signedSeconds(low)} to {signedSeconds(high)}.
      </p>
      <details className="annotation-provenance">
        <summary>Annotation provenance & confidence · {side}</summary>
        <p>
          <strong>{s.annotation.confidence}</strong> · {s.annotation.kind} ·{" "}
          {s.annotation.basis.replaceAll("_", " ")}. Annotated player:{" "}
          {annotated?.name ?? annotationPlayer}.
        </p>
        <p>{s.annotation.notes}</p>
        <p>
          Reviewer: {s.annotation.reviewer}. Reviewed {s.annotation.reviewed_at}
          .{" "}
          {s.annotation.evidence_uri ? (
            <a href={s.annotation.evidence_uri}>Evidence reference</a>
          ) : (
            "No independent video or source catch annotation."
          )}
        </p>
        <p>
          Anchor: <code>{s.annotation.anchor_frame_id}</code>. Interval:{" "}
          <code>{s.annotation.start_frame_id}</code> through{" "}
          <code>{s.annotation.end_frame_id}</code>.
        </p>
        <p>
          Collection {collection.collection_id} r{collection.revision} ·{" "}
          {s.sequence.split.replaceAll("_", " ")} ·{" "}
          {s.sequence.annotation_coverage.replaceAll("_", " ")} annotation
          coverage. Source <code>{s.bundle.segment_id}</code>.
        </p>
      </details>
    </article>
  );
}
