import { useEffect, useMemo, useState } from "react";
import type { Audit, Game } from "../types";
import { clock } from "../data";
import { parseFeature, rms, searchParams } from "./model";
import type { Options, Search, SearchState } from "./model";
import { PathOverlay, PathThumbnail } from "./PathPlots";
import { PathReplay } from "./PathReplay";
import "./actions.css";

async function fetchAction<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/actions/${path}`, { signal });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      data.detail ??
        "The geometric action index could not be read. Run make actions after make audit.",
    );
  }
  return response.json();
}
function useResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>(
    { key: "" },
  );
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ key, data });
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setState({ key, error: e.message });
      });
    return () => controller.abort();
  }, [key]);
  return state.key === key ? state : { key };
}
export function ActionAtlas({
  audit,
  active,
}: {
  audit: Audit | null;
  active: boolean;
}) {
  const resource = useResource<Options>("options", (signal) =>
    fetchAction<Options>("options", signal).then((options) => {
      if (
        options.feature_version !== "basketball-path-v1" ||
        !Array.isArray(options.seeds)
      )
        throw new Error(
          "Unsupported geometric feature index. Rebuild with make actions.",
        );
      options.seeds.forEach((s) => {
        if (s.feature) parseFeature(s.feature);
      });
      return options;
    }),
  );
  if (resource.error)
    return (
      <section className="empty-state" role="alert">
        <h2>Load the geometric action index</h2>
        <p>{resource.error}</p>
      </section>
    );
  if (!resource.data)
    return (
      <p role="status" className="message">
        Reading the geometric path index…
      </p>
    );
  if (!resource.data.seeds.length)
    return (
      <section className="empty-state">
        <h2>No query references available</h2>
        <p>
          Add source-bound curated references before searching player paths.
        </p>
      </section>
    );
  return <IndexedAtlas options={resource.data} audit={audit} active={active} />;
}
function initialState(options: Options): SearchState {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const seed =
    options.seeds.find((s) => s.sequence.sequence_id === params.get("seed")) ??
    options.seeds.find((s) => s.status === "available") ??
    options.seeds[0];
  return {
    seedId: seed.sequence.sequence_id,
    playerId: params.get("player") ?? seed.sequence.player_id,
    annotationId: params.get("anchor") ?? seed.sequence.default_anchor_id,
    featureId: null,
    profile: "start_relative",
    samePlayer: false,
    otherGame: false,
  };
}
function IndexedAtlas({
  options,
  audit,
  active,
}: {
  options: Options;
  audit: Audit | null;
  active: boolean;
}) {
  const [state, setState] = useState(() => initialState(options)),
    [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const update = () => {
      if (location.hash.startsWith("#actions?")) {
        setState((current) => ({
          ...current,
          ...initialState(options),
          profile: current.profile,
          samePlayer: current.samePlayer,
          otherGame: current.otherGame,
        }));
        setSelected(null);
      }
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, [options]);
  const request = searchParams(state);
  const resource = useResource<Search>(request, (signal) =>
    fetchAction<Search>(`search?${request}`, signal).then((data) => {
      if (data.metadata.index_fingerprint !== options.index_fingerprint)
        throw new Error(
          "The action index changed. Reload to use its current feature definition.",
        );
      if (data.query) parseFeature(data.query);
      data.matches.forEach((m) => {
        parseFeature(m);
        if (
          data.query &&
          Math.abs(rms(data.query, m, state.profile) - m.rms_ft) > 1e-8
        )
          throw new Error(
            "The returned paths do not reproduce their geometric score. Rebuild the index.",
          );
        if (!Number.isFinite(m.rms_ft) || m.rms_ft < 0)
          throw new Error("Invalid geometric distance in the search results.");
      });
      return data;
    }),
  );
  const result = resource.data,
    seed =
      options.seeds.find((s) => s.sequence.sequence_id === state.seedId) ??
      options.seeds[0];
  const roster =
    options.roster.find((g) => g.game_id === seed.sequence.game_id)?.players ??
    [];
  const match =
    result?.matches.find((m) => m.candidate_id === selected) ??
    result?.matches[0];
  const features = useMemo(
    () => (result?.query && match ? [result.query, match] : null),
    [result, match],
  );
  const games = useMemo(
    () =>
      features?.map((f) => audit?.games.find((g) => g.game_id === f.game_id)) ??
      [],
    [features, audit],
  );
  const queryLength = result?.query
    ? result.query.x_ft
        .slice(1)
        .reduce(
          (sum, x, i) =>
            sum +
            Math.hypot(
              x - result.query!.x_ft[i],
              result.query!.y_ft[i + 1] - result.query!.y_ft[i],
            ),
          0,
        )
    : 0;
  const selectSeed = (id: string) => {
    const seed = options.seeds.find((s) => s.sequence.sequence_id === id)!;
    setState((s) => ({
      ...s,
      seedId: id,
      playerId: seed.sequence.player_id,
      annotationId: seed.sequence.default_anchor_id,
      featureId: null,
    }));
    setSelected(null);
  };
  return (
    <div className="action-atlas">
      <div className="action-intro">
        <div>
          <p className="eyebrow">Geometric action atlas</p>
          <h2>Find a similar path.</h2>
        </div>
        <p>
          Search two seconds of one player’s recorded movement. Compare geometry
          in feet, then inspect the original observations.
        </p>
      </div>
      <div className="action-coverage">
        <span>
          {options.candidate_count.toLocaleString()} indexed player paths
        </span>
        <span>
          {options.games.length} audited source games · nominal 25 Hz source
        </span>
        <span>21 scored samples · no outcome or event labels in ranking</span>
      </div>
      <div className="action-query-layout">
        <section
          className="action-query-controls"
          aria-label="Geometric query controls"
        >
          {state.featureId && (
            <div className="indexed-query-note">
              <strong>An indexed match is now the query.</strong>
              <button
                type="button"
                onClick={() => {
                  setState((s) => ({ ...s, featureId: null }));
                  setSelected(null);
                }}
              >
                Return to curated query
              </button>
            </div>
          )}
          {!state.featureId && (
            <div className="action-source-controls">
              <label>
                Query reference
                <select
                  aria-label="Query reference"
                  value={state.seedId}
                  onChange={(e) => selectSeed(e.target.value)}
                >
                  {options.seeds.map((s) => (
                    <option
                      key={s.sequence.sequence_id}
                      value={s.sequence.sequence_id}
                    >
                      {s.sequence.title}
                      {s.status === "unavailable" ? " · limited history" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Query player
                <select
                  aria-label="Query player"
                  value={state.playerId}
                  disabled={!!state.featureId}
                  onChange={(e) => {
                    setState((s) => ({ ...s, playerId: e.target.value }));
                    setSelected(null);
                  }}
                >
                  {roster.map((p) => (
                    <option key={p.player_id} value={p.player_id}>
                      {p.name} · #{p.jersey}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Window ends at
                <select
                  aria-label="Query endpoint reference"
                  value={state.annotationId}
                  disabled={!!state.featureId}
                  onChange={(e) => {
                    setState((s) => ({ ...s, annotationId: e.target.value }));
                    setSelected(null);
                  }}
                >
                  {seed.sequence.annotations.map((a) => (
                    <option key={a.annotation_id} value={a.annotation_id}>
                      {a.label} · {a.confidence}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <p className="definition">
            {state.featureId
              ? "This query uses the indexed player path at its recorded endpoint. No annotation reference is used."
              : "The query uses two seconds ending at the selected reference, within the curated clip. That reference can be provisional; its event type and confidence do not enter the score. No observations after the endpoint are used."}
          </p>
          <div
            className="similarity-profiles"
            role="group"
            aria-label="Geometric coordinate profile"
          >
            <button
              type="button"
              aria-pressed={state.profile === "start_relative"}
              onClick={() =>
                setState((s) => ({ ...s, profile: "start_relative" }))
              }
            >
              Path shape · align starts
            </button>
            <button
              type="button"
              aria-pressed={state.profile === "court_location"}
              onClick={() =>
                setState((s) => ({ ...s, profile: "court_location" }))
              }
            >
              Path + court location
            </button>
          </div>
          <p className="profile-explanation">
            {state.profile === "start_relative"
              ? "Subtract each path’s starting position. Source-axis orientation and recorded timing remain unchanged."
              : "Keep the original source-court positions, so the same shape in a different location can score farther away."}{" "}
            Opposite-basket paths are not mirrored.
          </p>
          <div className="action-filters">
            <label>
              <input
                type="checkbox"
                checked={state.samePlayer}
                onChange={(e) =>
                  setState((s) => ({ ...s, samePlayer: e.target.checked }))
                }
              />
              Same player only
            </label>
            <label>
              <input
                type="checkbox"
                checked={state.otherGame}
                onChange={(e) =>
                  setState((s) => ({ ...s, otherGame: e.target.checked }))
                }
              />
              Other game only
            </label>
            <button
              type="button"
              onClick={() => {
                setState((s) => ({
                  ...s,
                  profile: "start_relative",
                  samePlayer: false,
                  otherGame: false,
                }));
                setSelected(null);
              }}
            >
              Reset comparison filters
            </button>
          </div>
        </section>
        <section
          className="action-query-preview"
          aria-label="Selected query path"
        >
          <p className="eyebrow">Query path · original court</p>
          {result?.query ? (
            <>
              <h3>{result.query.player_name}</h3>
              <PathThumbnail feature={result.query} />
              <div className="query-path-facts">
                <span>{queryLength.toFixed(1)} ft sampled path length</span>
                <span>
                  {result.query.observed_frames} observed frames → 21 samples
                </span>
              </div>
              <p>
                Q{result.query.period} {clock(result.query.start_clock_s)} →{" "}
                {clock(result.query.end_clock_s)} ·{" "}
                {(result.query.actual_duration_ms / 1000).toFixed(3)} s recorded
              </p>
            </>
          ) : (
            <p>
              {resource.error ??
                result?.reason ??
                "Loading the query’s observed positions…"}
            </p>
          )}
        </section>
      </div>
      {resource.error ? (
        <p className="message" role="alert">
          {resource.error}
        </p>
      ) : !result ? (
        <p className="message" role="status">
          Comparing recorded player paths…
        </p>
      ) : result.status === "unavailable" ? (
        <section className="empty-state" role="status">
          <h3>Query path unavailable</h3>
          <p>{result.reason}</p>
          <p>
            Select a reference with at least two seconds of intact
            selected-player history inside its curated clip.
          </p>
        </section>
      ) : (
        <>
          <section
            className="path-match-section"
            id="path-matches"
            aria-label="Geometric search results"
          >
            <div className="path-results-heading">
              <div>
                <p className="eyebrow">Nearest paths · distinct footage</p>
                <h3>{result.result_count} geometric matches</h3>
              </div>
              <p>
                {result.eligible_paths.toLocaleString()} eligible paths ·{" "}
                {result.overlapping_query_paths_excluded} paths overlapping
                query footage excluded
              </p>
            </div>
            <p className="definition">
              Lower RMS distance means closer sampled positions under this
              profile. Overlapping results are suppressed after sorting to show
              different footage. Similar geometry does not establish the same
              action, play call, role, or assignment.
            </p>
            {!match && (
              <p className="message">
                No eligible paths under these filters. Reset comparison filters
                or choose another query.
              </p>
            )}
            <div className="path-results-grid">
              {result.matches.map((m, i) => (
                <button
                  type="button"
                  key={m.candidate_id}
                  className="path-match"
                  aria-label={`Inspect match ${i + 1}: ${m.player_name}, ${m.rms_ft.toFixed(2)} feet RMS`}
                  aria-pressed={match?.candidate_id === m.candidate_id}
                  onClick={() => {
                    setSelected(m.candidate_id);
                    document
                      .getElementById("action-comparison")
                      ?.scrollIntoView({ block: "start" });
                  }}
                >
                  <div className="match-card-heading">
                    <span>#{i + 1}</span>
                    <strong>
                      {m.rms_ft.toFixed(2)} <small>ft RMS</small>
                    </strong>
                  </div>
                  <PathThumbnail feature={m} color="#b55136" />
                  <strong className="match-player-name">{m.player_name}</strong>
                  <span>
                    {
                      options.roster.find((g) => g.game_id === m.game_id)
                        ?.away_team
                    }{" "}
                    at{" "}
                    {
                      options.roster.find((g) => g.game_id === m.game_id)
                        ?.home_team
                    }{" "}
                    · Q{m.period} {clock(m.end_clock_s)}
                  </span>
                  <small>
                    21 samples · {m.observed_frames} observed frames
                  </small>
                </button>
              ))}
            </div>
          </section>
          {match && result.query && (
            <section
              id="action-comparison"
              className="selected-path-comparison"
            >
              <div className="selected-match-actions">
                <a
                  href="#path-matches"
                  onClick={(e) => {
                    e.preventDefault();
                    document
                      .getElementById("path-matches")
                      ?.scrollIntoView({ block: "start" });
                  }}
                >
                  ↑ Back to matches
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setState((s) => ({ ...s, featureId: match.candidate_id }));
                    setSelected(null);
                  }}
                >
                  Use matched path as query
                </button>
              </div>
              <PathOverlay
                query={result.query}
                match={match}
                profile={state.profile}
              />
              {features && games.every(Boolean) ? (
                <PathReplay
                  key={features.map((f) => f.candidate_id).join("|")}
                  features={features}
                  games={games as Game[]}
                  active={active}
                />
              ) : (
                <p className="message">
                  The tracking catalog is needed to replay these scored source
                  frames.
                </p>
              )}
            </section>
          )}
        </>
      )}
      <details className="action-index-notes">
        <summary>Feature definition, index coverage & reproducibility</summary>
        <p>
          Feature {options.feature_version} · fixed 2 s, 100 ms targets, 21
          recorded samples within 20 ms of their targets. Each selected-player
          history must be complete and continuous between its first and last
          sample. Other players and the ball are not features.
        </p>
        <p>
          Source fingerprint <code>{options.source_fingerprint}</code>. Index
          fingerprint <code>{options.index_fingerprint}</code>. Definition hash{" "}
          <code>{options.definition_hash}</code>.
        </p>
        <p>
          Default query references come from {options.collection.id} revision{" "}
          {options.collection.revision}. {options.collection.description} No
          annotation label or shot outcome affects ranking. Later historical
          clips may be retrieved; this is descriptive retrieval, not prospective
          prediction.
        </p>
        <p>
          Candidate endpoints follow an absolute 2 s timestamp grid inside the
          original source windows. Duplicate sampled paths are removed across
          overlapping windows. Same-game footage overlapping the query is
          excluded for every player; returned matches also use distinct time
          intervals. Stable feature IDs resolve equal scores.
        </p>
        <p>
          Multi-player matching is unavailable: player-role correspondence and
          retrieval quality have not been established. No tactical or play-call
          labels are inferred.
        </p>
        <p>
          Source windows can include stopped-clock footage. No live-play or
          possession filter is inferred. Counts below describe attempted
          roster-player/window pairs, including bench players who are not
          observed. They are not missing-frame rates. Each rejected pair is
          counted under its first failing rule.
        </p>
        {options.games.map((g) => (
          <div className="action-index-game" key={g.game_id}>
            <h4>{g.game_id}</h4>
            <dl>
              {Object.entries(g.counts).map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replaceAll("_", " ")}</dt>
                  <dd>{value.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
        <p>
          Build normalization time: {options.build_seconds.toFixed(2)} s on the
          recorded local environment. Reproduce with make actions; inspect the
          versioned definition in config/path-similarity-v1.json. Source data
          remains local.
        </p>
        {result?.query && (
          <details>
            <summary>
              Inspect the query feature and exact source frame references
            </summary>
            <pre>{JSON.stringify(result.query, null, 2)}</pre>
          </details>
        )}
      </details>
    </div>
  );
}
