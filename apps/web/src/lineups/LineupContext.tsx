import { useEffect, useMemo, useState } from "react";
import { Court } from "../Court";
import { clock } from "../data";
import { LocationModel } from "./LocationModel";
import { elapsed, parseBundle, parseModel, signed, stintShots } from "./model";
import type { LineupBundle, ModelReport, Options, Stint } from "./model";
import "./lineups.css";

function useRead<T>(url: string, parse: (value: T) => T = (value) => value) {
  const [result, setResult] = useState<{
    key: string;
    data?: T;
    error?: string;
  }>({ key: "" });
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    fetch(`/api${url}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.detail ?? "Local context could not be read.");
        return parse(data);
      })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key: url, data });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted)
          setResult({ key: url, error: error.message });
      });
    return () => controller.abort();
  }, [url]);
  return result.key === url ? result : { key: url };
}
const label = (s: Stint) =>
  `${s.period > 4 ? `OT${s.period - 4}` : `Q${s.period}`} ${clock(s.start_clock_s)}–${clock(s.end_clock_s)}`;
const bundleResponse = (r: { bundle: LineupBundle; metadata: Options }) => ({
  ...r,
  bundle: parseBundle(r.bundle),
});

export function LineupContext({
  onReplay,
}: {
  onReplay: (gameId: string, shotId: string) => void;
}) {
  const options = useRead<Options>("/lineups/options");
  const model = useRead<ModelReport>("/models/location", parseModel);
  const [gameId, setGameId] = useState<string | null>(null);
  const selectedGame =
    options.data?.games.find((g) => g.game_id === gameId) ??
    options.data?.games[0];
  const context = useRead<{ bundle: LineupBundle; metadata: Options }>(
    selectedGame ? `/lineups/games/${selectedGame.game_id}` : "",
    bundleResponse,
  );
  return (
    <div className="lineup-context">
      <div className="lineup-section-heading">
        <div>
          <p className="eyebrow">Reconstructed lineup context</p>
          <h2>Follow the rotations.</h2>
        </div>
        <p>
          Inspect five-player groups, recorded score margin and the attempts
          between substitutions. Compare stints with their sample counts.
        </p>
      </div>
      {options.error ? (
        <section role="alert" className="empty-state">
          <h3>Load lineup context</h3>
          <p>{options.error}</p>
        </section>
      ) : !options.data ? (
        <p role="status">Reading lineup coverage…</p>
      ) : (
        <>
          <nav className="game-tabs" aria-label="Lineup games">
            {options.data.games.map((g) => (
              <button
                key={g.game_id}
                type="button"
                aria-pressed={selectedGame?.game_id === g.game_id}
                onClick={() => setGameId(g.game_id)}
              >
                <span>
                  {g.away_team} <small>at</small> {g.home_team}
                </span>
                <time>{g.game_date}</time>
                <small>
                  {g.available}/{g.stints} available stints · {g.shots} attempts
                </small>
              </button>
            ))}
          </nav>
          {context.error ? (
            <p role="alert" className="message">
              {context.error}
            </p>
          ) : !context.data ? (
            <p role="status" className="message">
              Resolving source-ordered stints…
            </p>
          ) : context.data.metadata.index_fingerprint !==
              options.data.index_fingerprint ||
            context.data.bundle.game.game_id !== selectedGame?.game_id ? (
            <p role="alert">The lineup index changed. Reload the page.</p>
          ) : (
            <RotationGame
              key={context.data.bundle.game.game_id}
              bundle={context.data.bundle}
              onReplay={onReplay}
            />
          )}
          <details className="lineup-provenance">
            <summary>Lineup definition & source provenance</summary>
            <p>
              Period starters are inferred from first on-court involvement or an
              outgoing substitution before a player first enters. Opening
              starters are checked against the official gamebook. Contiguous
              same-clock substitutions are applied together; source row order
              separates other tied events. No unrecorded change is repaired.
            </p>
            <p>
              Five-player identity, event participants, gamebook minutes, field
              goals and points must pass validation. Unresolved lineups are
              withheld. Tracking coordinates are not used to infer these groups;
              source event clocks do not establish a release frame.
            </p>
            <p>
              Source <code>{options.data.source_fingerprint}</code> · lineup
              index <code>{options.data.index_fingerprint}</code>.
            </p>
            <ul>
              {options.data.input_identity.sources.map((s) => (
                <li key={s.id}>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.id}
                  </a>{" "}
                  · <code>{s.sha256}</code>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      {model.error ? (
        <section className="empty-state">
          <h3>Location-only model unavailable</h3>
          <p>{model.error}</p>
        </section>
      ) : model.data ? (
        <LocationModel report={model.data} />
      ) : (
        <p role="status" className="message">
          Reading the held-out model evaluation…
        </p>
      )}
    </div>
  );
}

function RotationGame({
  bundle,
  onReplay,
}: {
  bundle: LineupBundle;
  onReplay: (gameId: string, shotId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null),
    [comparison, setComparison] = useState<string | null>(null),
    [period, setPeriod] = useState("all"),
    [team, setTeam] = useState(bundle.game.away_team_id);
  const a =
    bundle.stints.find((s) => s.stint_id === selected) ?? bundle.stints[0];
  const b =
    bundle.stints.find((s) => s.stint_id === comparison) ??
    bundle.stints.find(
      (s) =>
        s.stint_id !== a.stint_id &&
        s.status === "available" &&
        s.shot_ids.length >= 10,
    ) ??
    bundle.stints.find((s) => s.stint_id !== a.stint_id) ??
    a;
  const visible = bundle.stints.filter(
    (s) => period === "all" || s.period === Number(period),
  );
  const periods = [...new Set(bundle.stints.map((s) => s.period))];
  const roster = new Map(bundle.game.players.map((p) => [p.player_id, p]));
  const substitutions = bundle.substitutions.filter((s) =>
    a.substitution_ids.includes(s.event_id),
  );
  return (
    <>
      <section className="rotation-timeline" aria-label="Rotation timeline">
        <div className="lineup-section-heading">
          <div>
            <p className="eyebrow">Source event order · game-clock duration</p>
            <h3>
              {bundle.game.away_team} {bundle.validation.final_score[0]} ·{" "}
              {bundle.game.home_team} {bundle.validation.final_score[1]}
            </h3>
          </div>
          <p>
            Blue is stint A. Orange is comparison B. Short and zero-second
            intervals remain available in the selectors.
          </p>
        </div>
        <MarginChart bundle={bundle} a={a} b={b} />
        <div className="lineup-selectors">
          <label>
            Show period
            <select
              aria-label="Lineup timeline period"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            >
              <option value="all">All periods</option>
              {periods.map((p) => (
                <option value={p} key={p}>
                  {p > 4 ? `OT${p - 4}` : `Q${p}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Stint A
            <select
              aria-label="Stint A"
              value={a.stint_id}
              onChange={(e) => setSelected(e.target.value)}
            >
              {bundle.stints.map((s, i) => (
                <option key={s.stint_id} value={s.stint_id}>
                  #{i + 1} · {label(s)} ·{" "}
                  {s.status === "available"
                    ? `${s.shot_ids.length} attempts`
                    : "Unavailable"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Compare with stint B
            <select
              aria-label="Stint B"
              value={b.stint_id}
              onChange={(e) => setComparison(e.target.value)}
            >
              {bundle.stints.map((s, i) => (
                <option key={s.stint_id} value={s.stint_id}>
                  #{i + 1} · {label(s)} ·{" "}
                  {s.status === "available"
                    ? `${s.shot_ids.length} attempts`
                    : "Unavailable"}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="stint-periods">
          {periods
            .filter((p) => period === "all" || p === Number(period))
            .map((p) => (
              <div key={p} className="stint-period">
                <strong>{p > 4 ? `OT${p - 4}` : `Q${p}`}</strong>
                <div className="stint-track">
                  {visible
                    .filter((s) => s.period === p && s.duration_s > 0)
                    .map((s) => (
                      <button
                        key={s.stint_id}
                        type="button"
                        className={`${s.stint_id === a.stint_id ? "stint-a" : s.stint_id === b.stint_id ? "stint-b" : ""} ${s.status === "unavailable" ? "unresolved" : ""}`}
                        style={{
                          left: `${(((p <= 4 ? 720 : 300) - s.start_clock_s) / (p <= 4 ? 720 : 300)) * 100}%`,
                          width: `${(s.duration_s / (p <= 4 ? 720 : 300)) * 100}%`,
                        }}
                        onClick={() => setSelected(s.stint_id)}
                        aria-label={`Select stint ${bundle.stints.indexOf(s) + 1}: ${label(s)}`}
                        aria-pressed={s.stint_id === a.stint_id}
                      >
                        <span>{bundle.stints.indexOf(s) + 1}</span>
                      </button>
                    ))}
                </div>
              </div>
            ))}
        </div>
        <p className="definition">
          Select a segment to update A, or use the selectors for any interval.
          Timeline widths show recorded game-clock seconds; they do not include
          stoppage duration.
        </p>
      </section>
      <section
        className="lineup-selection-context"
        aria-label="Selected substitution boundary"
      >
        <strong>Stint A begins: {label(a)}</strong>
        <span>
          {substitutions.length
            ? substitutions
                .map(
                  (s) =>
                    `${roster.get(s.incoming)?.name ?? s.incoming} in for ${roster.get(s.outgoing)?.name ?? s.outgoing}`,
                )
                .join(" · ")
            : "Period opening group · reconstructed from source participants"}
        </span>
      </section>
      <div className="lineup-team-filter">
        <span className="eyebrow">Shared attempt filter</span>
        {[
          [bundle.game.away_team_id, bundle.game.away_team],
          [bundle.game.home_team_id, bundle.game.home_team],
        ].map(([id, name]) => (
          <button
            key={id}
            type="button"
            aria-pressed={team === id}
            onClick={() => setTeam(id)}
          >
            {name} attempts
          </button>
        ))}
        <p>
          Descriptive samples from one game. Score changes and FG% do not
          measure causal lineup impact.
        </p>
      </div>
      <div className="stint-comparison" data-testid="stint-comparison">
        <StintPanel
          key={`A:${a.stint_id}`}
          side="A"
          stint={a}
          bundle={bundle}
          team={team}
          onReplay={onReplay}
        />
        <StintPanel
          key={`B:${b.stint_id}`}
          side="B"
          stint={b}
          bundle={bundle}
          team={team}
          onReplay={onReplay}
        />
      </div>
      <RotationChart
        bundle={bundle}
        a={a}
        b={b}
        team={team}
        onSelect={setSelected}
      />
      <details className="lineup-validation">
        <summary>Inspect gamebook constraints & possession coverage</summary>
        <p>{bundle.validation.score_allocation_note}</p>
        <p>
          {bundle.validation.possessions.reason ??
            "Provider field-goal totals reconcile; boundary allocation remains conservative."}{" "}
          {bundle.validation.possessions.allocation}
        </p>
        <ul>
          {bundle.validation.possessions.team_checks.map((c) => (
            <li key={c.team_id}>
              {c.team_id === bundle.game.home_team_id
                ? bundle.game.home_team
                : bundle.game.away_team}
              : provider {c.provider_fgm}/{c.provider_fga} field goals; gamebook{" "}
              {c.gamebook_fgm}/{c.gamebook_fga}.{" "}
              {c.passed ? "Reconciled." : "Coverage incomplete."}
            </li>
          ))}
        </ul>
        <p>
          {bundle.validation.possessions.source_rows} exploded archive rows →{" "}
          {bundle.validation.possessions.unique_records} unique provider
          possession records. Neither the raw row count nor linked record count
          is a complete possession total.
        </p>
        <div className="lineup-table-wrap">
          <table>
            <caption>
              Independent official-gamebook checks; PBP clock rounding is
              retained
            </caption>
            <thead>
              <tr>
                <th>Player</th>
                <th>Reconstructed seconds</th>
                <th>Gamebook seconds</th>
                <th>Difference</th>
                <th>Allowed rounding</th>
                <th>FGA / FGM / points</th>
              </tr>
            </thead>
            <tbody>
              {bundle.validation.minute_checks.map((c) => (
                <tr key={c.player_id}>
                  <td>{c.name}</td>
                  <td>{c.reconstructed_s}</td>
                  <td>{c.gamebook_s}</td>
                  <td>{signed(c.delta_s)} s</td>
                  <td>±{c.tolerance_s} s</td>
                  <td>
                    {bundle.validation.stat_checks.find(
                      (s) => s.player_id === c.player_id,
                    )?.passed && c.passed
                      ? "Passed"
                      : "Unresolved"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function StintPanel({
  side,
  stint,
  bundle,
  team,
  onReplay,
}: {
  side: "A" | "B";
  stint: Stint;
  bundle: LineupBundle;
  team: string;
  onReplay: (gameId: string, shotId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const shots = useMemo(
    () => stintShots(bundle, stint, team),
    [bundle, stint, team],
  );
  const shot = shots.find((s) => s.shot_id === selected) ?? shots[0];
  const ids = new Map(bundle.game.players.map((p) => [p.player_id, p]));
  const possessions = bundle.possessions.filter((p) =>
    stint.possession_ids.includes(p.possession_id),
  );
  const marginStart = stint.score_start[1] - stint.score_start[0],
    marginEnd = stint.score_end[1] - stint.score_end[0];
  return (
    <section
      className={`stint-panel panel-${side.toLowerCase()}`}
      data-testid={`stint-${side}`}
    >
      <header>
        <span className="stint-badge">{side}</span>
        <div>
          <h3>{label(stint)}</h3>
          <span>{stint.duration_s.toFixed(1)} recorded game-clock seconds</span>
        </div>
      </header>
      {stint.status === "unavailable" ? (
        <div className="lineup-unavailable" role="status">
          <h4>Lineup unavailable</h4>
          {stint.reasons.map((r) => (
            <p key={r}>{r}</p>
          ))}
          <p>Quintets and lineup-linked geometry are withheld.</p>
        </div>
      ) : (
        <>
          <div className="quintets">
            {[
              [bundle.game.away_team_id, bundle.game.away_team],
              [bundle.game.home_team_id, bundle.game.home_team],
            ].map(([id, name]) => (
              <div key={id}>
                <strong>{name} · five players</strong>
                <ul>
                  {stint.lineups[id].map((pid) => (
                    <li key={pid}>
                      <span>#{ids.get(pid)?.jersey}</span>
                      {ids.get(pid)?.name}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <dl className="stint-counts">
            <div>
              <dt>
                {team === bundle.game.away_team_id
                  ? bundle.game.away_team
                  : bundle.game.home_team}{" "}
                attempts
              </dt>
              <dd data-testid="stint-attempt-count">{shots.length}</dd>
            </div>
            <div>
              <dt>Field goals · sample FG%</dt>
              <dd>
                {shots.filter((s) => s.made).length}/{shots.length} ·{" "}
                {shots.length
                  ? `${((shots.filter((s) => s.made).length / shots.length) * 100).toFixed(1)}%`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Recorded {bundle.game.home_team} margin</dt>
              <dd>
                {signed(marginStart)} → {signed(marginEnd)}
              </dd>
            </div>
            <div>
              <dt>Contained provider possessions</dt>
              <dd>
                {stint.possession_count === null
                  ? "Unavailable"
                  : stint.possession_count}
              </dd>
            </div>
          </dl>
          <p className="definition">
            {stint.possession_count === null
              ? "Provider possession coverage does not reconcile. Linked records below are partial context."
              : "Count includes only provider records strictly contained inside this stint."}
          </p>
          {shots.length ? (
            <>
              <Court
                shots={shots}
                selected={shot?.shot_id ?? null}
                onSelect={setSelected}
              />
              <label>
                Inspect stint {side} attempt
                <select
                  aria-label={`Stint ${side} attempt`}
                  value={shot?.shot_id ?? ""}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {shots.map((s) => (
                    <option value={s.shot_id} key={s.shot_id}>
                      {clock(s.game_clock_s)} · {s.player_name} ·{" "}
                      {s.made ? "Made" : "Missed"}
                    </option>
                  ))}
                </select>
              </label>
              {shot && (
                <div className="stint-shot-detail">
                  <strong>
                    {shot.player_name} · {shot.shot_value}PT ·{" "}
                    {shot.made ? "Made" : "Missed"}
                  </strong>
                  <span>
                    {shot.action_type} · {shot.recorded_distance_ft} ft
                  </span>
                  {shot.tracking_join.status === "matched" ? (
                    <button
                      type="button"
                      onClick={() =>
                        onReplay(bundle.game.game_id, shot.shot_id)
                      }
                    >
                      Open tracking replay for stint {side}
                    </button>
                  ) : (
                    <small>
                      Tracking unavailable: {shot.tracking_join.reason}
                    </small>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="lineup-no-shots">
              No attempts for this team in the selected stint.
            </p>
          )}
          <details className="stint-possessions">
            <summary>
              {possessions.length} linked provider possession records
            </summary>
            <p>
              Intervals overlap this stint; crossing or tied substitution
              boundaries remain unallocated.
            </p>
            {possessions.map((p) => (
              <article key={p.possession_id}>
                <strong>
                  {clock(p.start_clock_s)}–{clock(p.end_clock_s)} ·{" "}
                  {p.team_id === bundle.game.home_team_id
                    ? bundle.game.home_team
                    : bundle.game.away_team}{" "}
                  · {p.fga} attempts
                </strong>
                <small>
                  {p.stint_id === stint.stint_id
                    ? "Strictly contained"
                    : "Boundary allocation unavailable"}{" "}
                  · {p.start_type}
                </small>
                <p>
                  {p.description ||
                    "No described action in this provider record."}
                </p>
              </article>
            ))}
          </details>
        </>
      )}
    </section>
  );
}

function MarginChart({
  bundle,
  a,
  b,
}: {
  bundle: LineupBundle;
  a: Stint;
  b: Stint;
}) {
  const maxPeriod = Math.max(...bundle.stints.map((s) => s.period));
  const duration = elapsed(maxPeriod, 0),
    extent = Math.max(
      10,
      ...bundle.margin.map((m) => Math.abs(m.home - m.away)),
    );
  const x = (p: number, c: number) => 42 + (elapsed(p, c) / duration) * 700;
  const y = (margin: number) => 75 - (margin / extent) * 45;
  const path =
    bundle.margin.reduce(
      (d, m) => `${d} H${x(m.period, m.game_clock_s)} V${y(m.home - m.away)}`,
      `M42 ${y(0)}`,
    ) + ` H742`;
  return (
    <div className="lineup-chart-scroll">
      <svg
        className="margin-chart"
        viewBox="0 0 760 142"
        role="img"
        aria-label={`Recorded ${bundle.game.home_team} score margin; highlighted source intervals A and B`}
      >
        {[a, b].map((s, i) => (
          <rect
            key={i}
            x={x(s.period, s.start_clock_s)}
            y="20"
            width={Math.max(1, (s.duration_s / duration) * 700)}
            height="100"
            fill={i ? "#b95133" : "#206785"}
            opacity=".16"
          />
        ))}
        {[-extent, 0, extent].map((v) => (
          <g key={v}>
            <path d={`M42 ${y(v)} H742`} stroke="#ced8de" />
            <text x="34" y={y(v) + 4} textAnchor="end">
              {signed(v)}
            </text>
          </g>
        ))}
        {Array.from({ length: maxPeriod }, (_, i) => (
          <g key={i}>
            <text x={x(i + 1, i < 4 ? 720 : 300) + 8} y="137">
              {i < 4 ? `Q${i + 1}` : `OT${i - 3}`}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="#203647" strokeWidth="2" />
        <text x="45" y="14">
          Recorded home margin · source event order
        </text>
      </svg>
    </div>
  );
}

function RotationChart({
  bundle,
  a,
  b,
  team,
  onSelect,
}: {
  bundle: LineupBundle;
  a: Stint;
  b: Stint;
  team: string;
  onSelect: (id: string) => void;
}) {
  const players = bundle.game.players.filter(
    (p) =>
      p.team_id === team &&
      bundle.validation.minute_checks.some((m) => m.player_id === p.player_id),
  );
  const duration = elapsed(Math.max(...bundle.stints.map((s) => s.period)), 0);
  return (
    <details className="player-rotation">
      <summary>
        Inspect player rotation bars · {players.length} active players
      </summary>
      <p>
        Bars show reconstructed game-clock time on court. Missing lineup
        intervals are omitted. Select a bar to update stint A; keyboard users
        can use the stint selector above.
      </p>
      <div className="lineup-chart-scroll">
        <svg
          viewBox={`0 0 850 ${players.length * 30 + 35}`}
          role="img"
          aria-label="Player rotations with selected A and B intervals highlighted"
        >
          {players.map((p, i) => (
            <g key={p.player_id}>
              <text x="150" y={i * 30 + 19} textAnchor="end">
                {p.name}
              </text>
              <path d={`M165 ${i * 30 + 15} H830`} stroke="#ced8de" />
              {bundle.stints
                .filter(
                  (s) =>
                    s.status === "available" &&
                    s.lineups[team].includes(p.player_id),
                )
                .map((s) => (
                  <rect
                    key={s.stint_id}
                    x={
                      165 +
                      (elapsed(s.period, s.start_clock_s) / duration) * 665
                    }
                    y={i * 30 + 6}
                    width={Math.max(1, (s.duration_s / duration) * 665)}
                    height="17"
                    fill={
                      s.stint_id === a.stint_id
                        ? "#206785"
                        : s.stint_id === b.stint_id
                          ? "#b95133"
                          : "#7c9aab"
                    }
                    stroke="#eef2f5"
                    strokeWidth=".5"
                    onClick={() => onSelect(s.stint_id)}
                  >
                    <title>
                      {p.name} · {label(s)}
                    </title>
                  </rect>
                ))}
            </g>
          ))}
          <text x="165" y={players.length * 30 + 25}>
            Opening tip
          </text>
          <text x="830" y={players.length * 30 + 25} textAnchor="end">
            Final buzzer · {duration / 60} min
          </text>
        </svg>
      </div>
    </details>
  );
}
