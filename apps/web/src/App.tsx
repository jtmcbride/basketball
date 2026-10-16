import { useEffect, useState } from "react";
import { ActionAtlas } from "./actions/ActionAtlas";
import { LineupContext } from "./lineups/LineupContext";
import { OffballExplorer } from "./offball/Explorer";
import { Atlas } from "./atlas/Atlas";
import { Court } from "./Court";
import { clock, getAudit, getShots, trackingDescription } from "./data";
import type { Audit, Game, Shot } from "./types";
import { ReplayLoader } from "./replay/ReplayView";

const number = new Intl.NumberFormat("en-US");

function GameInspection({
  game,
  requestedShot,
}: {
  game: Game;
  requestedShot?: string | null;
}) {
  const [shots, setShots] = useState<Shot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [player, setPlayer] = useState("all");
  const [result, setResult] = useState("all");
  useEffect(() => {
    const controller = new AbortController();
    getShots(game.game_id, controller.signal)
      .then((rows) => {
        setShots(rows);
        setSelectedId(
          requestedShot ??
            game.examples.find((e) => e.continuity === "continuous")?.shot_id ??
            rows[0]?.shot_id ??
            null,
        );
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [game.game_id, requestedShot]);
  const filtered = (shots ?? []).filter(
    (shot) =>
      (player === "all" || shot.player_id === player) &&
      (result === "all" || shot.made === (result === "made")),
  );
  const selected =
    filtered.find((shot) => shot.shot_id === selectedId) ?? filtered[0];
  const players = [
    ...new Map(
      (shots ?? []).map((s) => [s.player_id, s.player_name]),
    ).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const beyondHalfCourt = filtered.filter(
    (s) =>
      s.forward_ft + 5.25 > 47 ||
      s.forward_ft + 5.25 < 0 ||
      Math.abs(s.lateral_ft) > 25,
  ).length;
  const examples = game.examples
    .flatMap((example) => {
      const shot = shots?.find((s) => s.shot_id === example.shot_id);
      return shot && example.segment_id ? [shot] : [];
    })
    .slice(0, 3);
  return (
    <>
      {examples.length > 0 && (
        <nav className="example-gallery" aria-label="Audited tracking examples">
          <p className="eyebrow">Try a window</p>
          {examples.map((shot, i) => (
            <button
              type="button"
              key={shot.shot_id}
              onClick={() => {
                setPlayer("all");
                setResult("all");
                setSelectedId(shot.shot_id);
              }}
            >
              <strong>{shot.player_name}</strong>
              <span>
                {shot.tracking_join.window_continuity === "partial"
                  ? "Inspect missing observations"
                  : i === 0
                    ? "Follow the recorded movement"
                    : "Compare opponent proximity"}
              </span>
              <small>
                {shot.made ? "Made" : "Missed"} · Q{shot.period}{" "}
                {clock(shot.game_clock_s)}
              </small>
            </button>
          ))}
        </nav>
      )}
      <div className="lab-grid">
        <section className="shot-panel" aria-labelledby="shots-heading">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Recorded shot locations</p>
              <h2 id="shots-heading">
                {game.away_team} at {game.home_team}
              </h2>
            </div>
          </div>
          <div className="shot-filters">
            <label>
              Player
              <select
                aria-label="Player"
                value={player}
                onChange={(e) => setPlayer(e.target.value)}
              >
                <option value="all">All players</option>
                {players.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Result
              <select
                aria-label="Shot result"
                value={result}
                onChange={(e) => setResult(e.target.value)}
              >
                <option value="all">All attempts</option>
                <option value="made">Made</option>
                <option value="missed">Missed</option>
              </select>
            </label>
          </div>
          {error ? (
            <p role="alert" className="message">
              {error}
            </p>
          ) : shots === null ? (
            <p role="status" className="message">
              Loading recorded attempts…
            </p>
          ) : (
            <>
              <div className="court-wrap">
                <Court
                  shots={filtered}
                  selected={selected?.shot_id ?? null}
                  onSelect={setSelectedId}
                />
              </div>
              <div className="court-caption">
                <span>
                  <i className="legend-made" /> Made
                </span>
                <span>
                  <i className="legend-missed">×</i> Missed
                </span>
                <span>
                  {filtered.length} attempts
                  {beyondHalfCourt > 0
                    ? ` · ${beyondHalfCourt} beyond this court view`
                    : ""}
                </span>
              </div>
              {selected ? (
                <div className="attempt-detail">
                  <label>
                    Inspect attempt
                    <select
                      aria-label="Inspect attempt"
                      value={selected.shot_id}
                      onChange={(e) => setSelectedId(e.target.value)}
                    >
                      {filtered.map((s) => (
                        <option key={s.shot_id} value={s.shot_id}>
                          {s.period > 4 ? `OT${s.period - 4}` : `Q${s.period}`}{" "}
                          {clock(s.game_clock_s)} · {s.player_name} ·{" "}
                          {s.made ? "Made" : "Missed"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="attempt-facts">
                    <strong>{selected.action_type}</strong>
                    <span>
                      {selected.shot_value}-point attempt ·{" "}
                      {selected.recorded_distance_ft} ft recorded distance
                    </span>
                    <span>
                      {selected.tracking_join.status === "matched"
                        ? trackingDescription(selected)
                        : "Tracking not matched"}
                    </span>
                    <small>
                      Event {selected.source_event_id} · Event time is not
                      verified shot-release time.
                    </small>
                  </div>
                  <a className="view-replay-link" href="#tracking-replay">
                    {selected.tracking_join.status === "matched"
                      ? "View tracking replay ↓"
                      : "View tracking availability ↓"}
                  </a>
                </div>
              ) : (
                <p className="message">
                  No attempts available for this selection.
                </p>
              )}
              <button
                className="reset-filters"
                type="button"
                onClick={() => {
                  setPlayer("all");
                  setResult("all");
                }}
              >
                Reset shot filters
              </button>
              <p className="definition">
                Select a shot or an attempt above to load its matched tracking
                window. Unmatched attempts show their availability reason.
              </p>
            </>
          )}
        </section>
        <div className="replay-column" id="tracking-replay" tabIndex={-1}>
          {selected ? (
            <ReplayLoader key={selected.shot_id} shot={selected} game={game} />
          ) : (
            <section className="replay-empty">
              <h2>Tracking replay</h2>
              <p>Select an attempt to inspect its tracking window.</p>
            </section>
          )}
        </div>
      </div>
      <details className="game-quality">
        <summary>
          Game coverage & source findings · {game.source_event_windows} windows
        </summary>
        <aside className="quality-panel" aria-labelledby="quality-heading">
          <p className="eyebrow">Tracking coverage</p>
          <h2 id="quality-heading">What the source contains</h2>
          <dl className="coverage">
            <div>
              <dt>Observed unique frames</dt>
              <dd>{number.format(game.unique_frames)}</dd>
            </div>
            <div>
              <dt>Continuous event windows</dt>
              <dd>{game.continuous_windows}</dd>
            </div>
            <div>
              <dt>Partial or empty windows</dt>
              <dd>{game.partial_windows}</dd>
            </div>
            <div>
              <dt>Shots matched to tracking</dt>
              <dd>
                {game.joins.shot_to_tracking.matched ?? 0} / {game.shots}
              </dd>
            </div>
          </dl>
          <p className="definition">
            A continuous window has intact sample timing and player/ball
            coverage. Source event windows can overlap and do not establish
            complete possessions.
          </p>
          <div className="periods" aria-label="Periods represented">
            {game.periods.map((period) => (
              <div key={period.period}>
                <span>
                  {period.period > 4
                    ? `OT${period.period - 4}`
                    : `Q${period.period}`}
                </span>
                <strong>{number.format(period.unique_frames)}</strong>
                <small>frames</small>
              </div>
            ))}
          </div>
          <h3>Findings to inspect</h3>
          <ul className="findings">
            {game.findings.map((finding) => (
              <li key={finding.code}>
                <strong>{number.format(finding.count)}</strong>
                <span>{finding.description}</span>
              </li>
            ))}
          </ul>
          <p className="definition">
            Nominal 25 Hz. Identical overlaps are deduplicated; conflicting
            observations remain flagged. Attacking direction and shot-release
            timing are unavailable.
          </p>
        </aside>
      </details>
    </>
  );
}

export default function App() {
  const [mode, setMode] = useState<
    "atlas" | "tracking" | "movement" | "actions" | "lineups"
  >(
    location.hash === "#lineups"
      ? "lineups"
      : location.hash.split("?")[0] === "#actions"
        ? "actions"
        : location.hash === "#movement"
          ? "movement"
          : location.hash === "#atlas"
            ? "atlas"
            : "tracking",
  );
  const [requestedShot, setRequestedShot] = useState<string | null>(null);
  const [actionsVisited, setActionsVisited] = useState(
    location.hash.startsWith("#actions"),
  );
  const [lineupsVisited, setLineupsVisited] = useState(
    location.hash === "#lineups",
  );
  const [atlasVisited, setAtlasVisited] = useState(location.hash === "#atlas");
  const [audit, setAudit] = useState<Audit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getAudit(controller.signal)
      .then(setAudit)
      .catch((err: Error) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const navigate = () => {
      const next =
        location.hash === "#lineups"
          ? "lineups"
          : location.hash.split("?")[0] === "#actions"
            ? "actions"
            : location.hash === "#movement"
              ? "movement"
              : location.hash === "#atlas"
                ? "atlas"
                : "tracking";
      setMode(next);
      if (next === "atlas") setAtlasVisited(true);
      if (next === "actions") setActionsVisited(true);
      if (next === "lineups") setLineupsVisited(true);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  const game =
    audit?.games.find((g) => g.game_id === gameId) ?? audit?.games[0];
  return (
    <main>
      <header className="masthead">
        <a className="wordmark" href="/">
          BML<span>Basketball Motion Lab</span>
        </a>
        <span className="stage-label">
          Historical NBA data · verified archives
        </span>
      </header>
      <div className="intro">
        <div>
          <p className="eyebrow">Shot atlas / tracking replay</p>
          <h1>
            Shots & <em>movement.</em>
          </h1>
        </div>
        <p>
          {mode === "lineups"
            ? "Follow reconstructed rotations, inspect the attempts between substitutions, and examine a location-only model on held-out games."
            : mode === "atlas"
              ? "Explore four seasons of shot locations, compare players on the same scale, and open the recorded attempts behind each region."
              : mode === "actions"
                ? "Search recorded player paths, inspect geometric distances in feet, and replay the matched observations."
                : mode === "movement"
                  ? "Inspect annotated player movement, compare sequences at their reference frames, and follow separation and direction over recorded time."
                  : "Select a recorded attempt, replay its tracked window, and inspect player movement with synchronized distance and speed measurements."}
        </p>
      </div>
      <nav className="mode-tabs" aria-label="Explore basketball data">
        <button
          type="button"
          aria-pressed={mode === "atlas"}
          onClick={() => {
            setMode("atlas");
            setAtlasVisited(true);
            history.replaceState(null, "", "#atlas");
          }}
        >
          Shot atlas
        </button>
        <button
          type="button"
          aria-pressed={mode === "tracking"}
          onClick={() => {
            setMode("tracking");
            history.replaceState(null, "", "#tracking");
          }}
        >
          Tracking lab
        </button>
        <button
          type="button"
          aria-pressed={mode === "movement"}
          onClick={() => {
            setMode("movement");
            history.replaceState(null, "", "#movement");
          }}
        >
          Off-ball explorer
        </button>
        <button
          type="button"
          aria-pressed={mode === "actions"}
          onClick={() => {
            setMode("actions");
            setActionsVisited(true);
            history.replaceState(null, "", "#actions");
          }}
        >
          Action atlas
        </button>
        <button
          type="button"
          aria-pressed={mode === "lineups"}
          onClick={() => {
            setMode("lineups");
            setLineupsVisited(true);
            history.replaceState(null, "", "#lineups");
          }}
        >
          Lineup context
        </button>
      </nav>
      {lineupsVisited && (
        <div hidden={mode !== "lineups"}>
          <LineupContext
            onReplay={(id, shot) => {
              setGameId(id);
              setRequestedShot(shot);
              setMode("tracking");
              history.replaceState(null, "", "#tracking");
              window.scrollTo({ top: 0 });
            }}
          />
        </div>
      )}
      {actionsVisited && (
        <div hidden={mode !== "actions"}>
          <ActionAtlas audit={audit} active={mode === "actions"} />
        </div>
      )}
      {atlasVisited && (
        <div hidden={mode !== "atlas"}>
          <Atlas
            onReplay={(id, shot) => {
              setGameId(id);
              setRequestedShot(shot);
              setMode("tracking");
              history.replaceState(null, "", "#tracking");
              window.scrollTo({ top: 0 });
            }}
          />
        </div>
      )}
      {mode === "movement" && (
        <OffballExplorer audit={audit} auditError={error} />
      )}
      {mode === "tracking" && (
        <>
          {error ? (
            <section className="empty-state" role="alert">
              <h2>Load the local sample</h2>
              <p>{error}</p>
            </section>
          ) : audit === null ? (
            <p className="message" role="status">
              Reading the local source audit…
            </p>
          ) : audit.games.length === 0 ? (
            <section className="empty-state">
              <h2>No imported games</h2>
              <p>
                Run make fetch and make audit to inspect the historical sample.
              </p>
            </section>
          ) : (
            <>
              <nav className="game-tabs" aria-label="Imported games">
                {audit.games.map((g) => (
                  <button
                    key={g.game_id}
                    type="button"
                    aria-pressed={game?.game_id === g.game_id}
                    onClick={() => {
                      setGameId(g.game_id);
                      setRequestedShot(null);
                    }}
                  >
                    <span>
                      {g.away_team} <small>at</small> {g.home_team}
                    </span>
                    <time dateTime={g.game_date}>{g.game_date}</time>
                    <small>
                      {g.shots} attempts · {g.periods.length} periods
                    </small>
                  </button>
                ))}
              </nav>
              {game && (
                <GameInspection
                  key={`${game.game_id}:${requestedShot}`}
                  game={game}
                  requestedShot={requestedShot}
                />
              )}
              <details className="sources">
                <summary>
                  Source files & provenance · {audit.sources.length} pinned
                  archives
                </summary>
                <p>
                  Raw files remain local. Data redistribution permission has not
                  been established.
                </p>
                <ul>
                  {audit.sources.map((source) => (
                    <li key={source.id}>
                      <a href={source.url}>{source.filename}</a>
                      <code>SHA-256 {source.sha256.slice(0, 16)}…</code>
                    </li>
                  ))}
                </ul>
                <p>
                  Dataset fingerprint{" "}
                  <code>{audit.source_fingerprint.slice(0, 20)}…</code>
                </p>
              </details>
            </>
          )}
        </>
      )}
      <footer>
        NBA historical archives
        <span>Recorded locations. Derived coverage checks.</span>
      </footer>
    </main>
  );
}
