import { useEffect, useId, useState } from "react";
import { clock } from "../data";
import { color, metrics, query, scaleMax, valueLabel } from "./model";
import type { Attempts, Bin, Filters, Metric, Options, Summary } from "./model";
import "./atlas.css";

const fmt = new Intl.NumberFormat("en-US");
const date = (value: string) =>
  `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
async function request<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/atlas/${path}`, { signal });
  if (!response.ok)
    throw new Error(
      response.status === 503
        ? "Import seasons with make atlas-fetch and make atlas, then reload."
        : "The shot atlas could not be loaded. Check the local data service.",
    );
  return response.json();
}
function loadSummaries(
  filters: Filters[],
  signal: AbortSignal,
): Promise<Summary[]> {
  const pending = new Map<string, Promise<Summary>>();
  return Promise.all(
    filters.map((f) => {
      const key = query(f);
      if (!pending.has(key))
        pending.set(key, request<Summary>(`summary?${key}`, signal));
      return pending.get(key)!;
    }),
  );
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
      .catch((error: Error) => {
        if (!controller.signal.aborted) setState({ key, error: error.message });
      });
    return () => controller.abort();
    // The stable serialized key includes every input to this request.
  }, [key]);
  return state.key === key ? state : { key };
}
function HexCourt({
  summary,
  metric,
  max,
  selected,
  onSelect,
}: {
  summary: Summary;
  metric: Metric;
  max: number;
  selected: string | null;
  onSelect?: (cell: string) => void;
}) {
  const clipId = useId();
  const polygon = (bin: Bin) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = ((60 * i - 30) * Math.PI) / 180;
      return `${25 + bin.cx! + 2.42 * Math.cos(a)},${5.25 + bin.cy! + 2.42 * Math.sin(a)}`;
    }).join(" ");
  return (
    <svg
      viewBox="-1 -1 52 49"
      className="hex-court"
      role={onSelect ? "group" : "img"}
      aria-label={`${summary.filters.season} hexagonal shot map, ${summary.n} attempts`}
    >
      <defs>
        <clipPath id={clipId}>
          <rect width="50" height="47" />
        </clipPath>
      </defs>
      <rect width="50" height="47" fill="#cfb58d" />
      <g clipPath={`url(#${clipId})`}>
        {summary.bins
          .filter((b) => b.cell !== "outside")
          .map((b) => (
            <polygon
              key={b.cell}
              points={polygon(b)}
              fill={color(
                metric !== "frequency" && !b.reliable ? null : b[metric],
                metric,
                max,
              )}
              opacity={
                metric !== "frequency" && (!b.reliable || b[metric] === null)
                  ? 0.35
                  : 0.94
              }
              stroke={selected === b.cell ? "#102f40" : "#cfb58d"}
              strokeWidth={selected === b.cell ? 0.4 : 0.08}
              role={onSelect ? "button" : undefined}
              tabIndex={onSelect ? 0 : undefined}
              aria-label={
                onSelect
                  ? `Region ${b.cell}: ${b.n} attempts, ${valueLabel(b, metric)}`
                  : undefined
              }
              onClick={() => onSelect?.(b.cell)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect?.(b.cell);
                }
              }}
            >
              <title>
                {b.n} attempts · {b.made} made · {valueLabel(b, metric)} ·
                baseline n={b.baseline_n}
              </title>
            </polygon>
          ))}
      </g>
      <g fill="none" stroke="#314655" strokeWidth=".12" pointerEvents="none">
        <rect x=".1" y=".1" width="49.8" height="46.8" />
        <path d="M17 0V19H33V0 M3 0V14.2 A23.75 23.75 0 0 0 47 14.2V0 M22 4H28 M19 47A6 6 0 0 1 31 47" />
        <circle cx="25" cy="19" r="6" />
        <circle cx="25" cy="5.25" r=".75" />
      </g>
    </svg>
  );
}
function Distribution({
  summaries,
  cell,
}: {
  summaries: Summary[];
  cell: string | null;
}) {
  const values = summaries.map((s) =>
    Array.from({ length: 11 }, (_, i) =>
      s.histogram
        .filter((h) => h.distance === i * 5 && (!cell || h.cell === cell))
        .reduce((n, h) => n + h.n, 0),
    ),
  );
  const max = Math.max(
    1,
    ...values.flatMap((v, i) =>
      v.map((n) => (100 * n) / (summaries[i].n || 1)),
    ),
  );
  return (
    <div className="distance-chart">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Linked distance distribution</p>
          <h3>
            {cell
              ? "Attempts in the selected region"
              : "Where the attempts come from"}
          </h3>
        </div>
        <span>per 100 cohort attempts</span>
      </div>
      <svg
        viewBox="0 0 660 146"
        role="img"
        aria-label="Recorded shot distance distribution, 5-foot bins, normalized per 100 cohort attempts"
      >
        <text x="657" y="9" textAnchor="end">
          {max.toFixed(1)}
        </text>
        {Array.from({ length: 11 }, (_, i) => (
          <g key={i}>
            {values.map((v, j) => {
              const height =
                (100 * ((100 * v[i]) / (summaries[j].n || 1))) / max;
              return (
                <rect
                  key={j}
                  x={i * 59 + 9 + j * 19}
                  y={112 - height}
                  width="17"
                  height={height}
                  fill={j ? "#b55136" : "#206483"}
                >
                  <title>
                    {j ? "B" : "A"}: {v[i]} attempts ·{" "}
                    {((100 * v[i]) / (summaries[j].n || 1)).toFixed(2)} per 100
                  </title>
                </rect>
              );
            })}
            <text
              className={i % 2 ? "distance-tick minor" : "distance-tick"}
              x={i * 59 + 27}
              y="132"
              textAnchor="middle"
            >
              {i === 10 ? "50+" : `${i * 5}–${i * 5 + 4}`}
            </text>
          </g>
        ))}
      </svg>
      <p className="definition">
        Recorded distance in feet, rounded by the source. A{" "}
        <i className="swatch a" /> · B <i className="swatch b" />. Region
        selection keeps each cohort’s full-attempt denominator; the 50+ bin
        includes heaves.
      </p>
    </div>
  );
}
function AttemptList({
  filters,
  cell,
  onReplay,
}: {
  filters: Filters;
  cell: string | null;
  onReplay: (gameId: string, shotId: string) => void;
}) {
  const [offset, setOffset] = useState(0);
  const key = `${query(filters)}&${new URLSearchParams(cell ? { cell } : {})}&offset=${offset}&limit=25`;
  const resource = useResource<Attempts>(key, (signal) =>
    request(`attempts?${key}`, signal),
  );
  const data = resource.data;
  return (
    <section className="region-attempts">
      <h3>Underlying attempts</h3>
      {resource.error ? (
        <p role="alert">{resource.error}</p>
      ) : !data ? (
        <p role="status">Loading attempts…</p>
      ) : (
        <>
          <p>
            {fmt.format(data.total)} attempts ·{" "}
            {cell === "outside"
              ? "Outside the half-court view"
              : cell
                ? `Region ${cell}`
                : "All regions"}
          </p>
          {data.total === 0 && <p>No attempts for this selection.</p>}
          <ol
            start={offset + 1}
            tabIndex={0}
            aria-label="Recorded attempts in the selected region"
          >
            {data.attempts.map((s) => (
              <li key={s.shot_id}>
                <div>
                  <strong>{s.player_name}</strong>
                  <span>
                    {date(s.game_date)} · Q{s.period} {clock(s.game_clock_s)} ·{" "}
                    {s.made ? "Made" : "Missed"} {s.shot_value}PT ·{" "}
                    {s.recorded_distance_ft} ft
                  </span>
                  <small>
                    {s.action_type} · Event {s.source_event_id} ·{" "}
                    {s.event_matched ? "PBP verified" : "PBP unverified"}
                  </small>
                </div>
                {s.tracking_status === "matched" ? (
                  <button
                    type="button"
                    onClick={() => onReplay(s.game_id, s.shot_id)}
                  >
                    Open tracking replay
                  </button>
                ) : (
                  <small className="tracking-unavailable">
                    Tracking {s.tracking_status}
                    <span>{s.tracking_reason}</span>
                  </small>
                )}
              </li>
            ))}
          </ol>
          <div className="pagination">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >
              Previous attempts
            </button>
            <span>
              {data.total
                ? `${offset + 1}–${Math.min(offset + 25, data.total)} of ${fmt.format(data.total)}`
                : "0 attempts"}
            </span>
            <button
              type="button"
              disabled={offset + 25 >= data.total}
              onClick={() => setOffset(offset + 25)}
            >
              Next attempts
            </button>
          </div>
        </>
      )}
    </section>
  );
}
export function Atlas({
  onReplay,
}: {
  onReplay: (gameId: string, shotId: string) => void;
}) {
  const options = useResource<Options>("options", (signal) =>
    request<Options>("options", signal).then((o) => {
      if (o.version !== "shot-atlas-v1")
        throw new Error("Unsupported atlas format. Rebuild with make atlas.");
      return o;
    }),
  );
  return options.error ? (
    <section className="empty-state" role="alert">
      <h2>Load the shot atlas</h2>
      <p>{options.error}</p>
    </section>
  ) : !options.data ? (
    <p role="status">Reading verified season coverage…</p>
  ) : (
    <AtlasComparison options={options.data} onReplay={onReplay} />
  );
}
function AtlasComparison({
  options,
  onReplay,
}: {
  options: Options;
  onReplay: (gameId: string, shotId: string) => void;
}) {
  const seasons = options.seasons.map((s) => s.season);
  const initialPlayer = options.players.some((p) => p.id === "201939")
    ? "201939"
    : "all";
  const [a, setA] = useState({ season: seasons[0], player_id: initialPlayer });
  const [b, setB] = useState({
    season: seasons.at(-1)!,
    player_id: initialPlayer,
  });
  const [shared, setShared] = useState({
    team_id: "all",
    opponent: "all",
    period: "all",
    shot_value: "all",
  });
  const [metric, setMetric] = useState<Metric>("frequency");
  const [cell, setCell] = useState<string | null>(null);
  const [inspect, setInspect] = useState<"A" | "B">("A");
  const filtersA = { ...a, ...shared },
    filtersB = { ...b, ...shared };
  const keys = [
    filtersA,
    filtersB,
    ...seasons.map((season) => ({ ...filtersA, season })),
  ];
  const key = keys.map(query).join("|");
  const resource = useResource<Summary[]>(key, (signal) =>
    loadSummaries(keys, signal),
  );
  const summaries = resource.data;
  const max = scaleMax(metric, summaries ?? []);
  const label = metrics.find((m) => m.id === metric)!;
  const name = (id: string) =>
    options.players.find((p) => p.id === id)?.name ?? "All players";
  const regions = [
    ...new Set(
      (summaries ?? [])
        .slice(0, 2)
        .flatMap((s) => s.bins.map((b) => b.cell))
        .concat(cell ? [cell] : []),
    ),
  ].sort();
  const selectedFilters = inspect === "A" ? filtersA : filtersB;
  const bin = summaries?.[inspect === "A" ? 0 : 1]?.bins.find(
    (v) => v.cell === cell,
  );
  return (
    <div className="atlas">
      <div className="atlas-title">
        <div>
          <p className="eyebrow">Historical shot atlas</p>
          <h2>How the floor changes.</h2>
        </div>
        <p>
          Compare where players shoot, how often they make it, and the
          field-goal value of each attempt.
        </p>
      </div>
      <div className="atlas-shared">
        <label>
          Team
          <select
            aria-label="Team"
            value={shared.team_id}
            onChange={(e) => setShared({ ...shared, team_id: e.target.value })}
          >
            <option value="all">All teams</option>
            {options.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Opponent
          <select
            aria-label="Opponent"
            value={shared.opponent}
            onChange={(e) => setShared({ ...shared, opponent: e.target.value })}
          >
            <option value="all">All opponents</option>
            {options.opponents.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Period
          <select
            aria-label="Period"
            value={shared.period}
            onChange={(e) => setShared({ ...shared, period: e.target.value })}
          >
            <option value="all">All periods</option>
            {options.periods.map((p) => (
              <option key={p} value={p}>
                {p > 4 ? `OT${p - 4}` : `Q${p}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Shot type
          <select
            aria-label="Shot type"
            value={shared.shot_value}
            onChange={(e) =>
              setShared({ ...shared, shot_value: e.target.value })
            }
          >
            <option value="all">2PT + 3PT</option>
            <option value="2">2PT</option>
            <option value="3">3PT</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            setShared({
              team_id: "all",
              opponent: "all",
              period: "all",
              shot_value: "all",
            });
            setCell(null);
          }}
        >
          Reset shared filters
        </button>
      </div>
      <div className="metric-tabs" role="group" aria-label="Atlas metric">
        {metrics.map((m) => (
          <button
            type="button"
            key={m.id}
            aria-pressed={metric === m.id}
            onClick={() => setMetric(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="atlas-legend">
        <strong>{label.unit}</strong>
        <span
          className={
            metric === "difference_pp" ? "color-scale divergent" : "color-scale"
          }
        />
        <span>
          {metric === "difference_pp" ? "−30" : "0"} →{" "}
          {max.toFixed(
            metric === "points_per_attempt" || metric === "frequency" ? 1 : 0,
          )}
          {metric === "difference_pp" ? " (colors capped)" : ""}
        </span>
        <small>Shared scale across every map · gray/faded: sparse sample</small>
      </div>
      {resource.error ? (
        <p role="alert" className="message">
          {resource.error}
        </p>
      ) : (
        <>
          <div className="comparison-courts">
            {([a, b] as const).map((cohort, i) => (
              <section
                className="cohort"
                key={i}
                aria-label={`Cohort ${i ? "B" : "A"}`}
              >
                <div className="cohort-heading">
                  <span className={`cohort-letter ${i ? "b" : "a"}`}>
                    {i ? "B" : "A"}
                  </span>
                  <label>
                    Player {i ? "B" : "A"}
                    <select
                      aria-label={`Player ${i ? "B" : "A"}`}
                      value={cohort.player_id}
                      onChange={(e) =>
                        (i ? setB : setA)({
                          ...cohort,
                          player_id: e.target.value,
                        })
                      }
                    >
                      <option value="all">All players</option>
                      {options.players.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Season {i ? "B" : "A"}
                    <select
                      aria-label={`Season ${i ? "B" : "A"}`}
                      value={cohort.season}
                      onChange={(e) =>
                        (i ? setB : setA)({ ...cohort, season: e.target.value })
                      }
                    >
                      {seasons.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {!summaries ? (
                  <p role="status" className="map-loading">
                    Loading cohort {i ? "B" : "A"}…
                  </p>
                ) : (
                  <>
                    <div className="cohort-summary">
                      <strong>
                        {fmt.format(summaries[i].n)} <small>attempts</small>
                      </strong>
                      <span>
                        {summaries[i].n
                          ? `${((100 * summaries[i].made) / summaries[i].n).toFixed(1)}% FG · ${(summaries[i].points / summaries[i].n).toFixed(2)} FG points / attempt`
                          : "No attempts under these filters"}
                      </span>
                    </div>
                    <HexCourt
                      summary={summaries[i]}
                      metric={metric}
                      max={max}
                      selected={cell}
                      onSelect={(v) => {
                        setCell(v);
                        setInspect(i ? "B" : "A");
                      }}
                    />
                    <p className="map-caption">
                      {summaries[i].bins.find((v) => v.cell === "outside")?.n ??
                        0}{" "}
                      attempts outside this court view · included in totals and
                      frequency denominator
                    </p>
                    <p className="baseline-caption">
                      {cohort.season} baseline:{" "}
                      {fmt.format(summaries[i].baseline.n)} attempts · all
                      players under the shared filters
                    </p>
                  </>
                )}
              </section>
            ))}
          </div>
          <p className="definition atlas-method">
            Charts describe available shot-chart records; PBP-only attempts
            without locations are excluded. Fixed 2.5 ft hex radius; no
            smoothing. Frequency = attempts in a region / all cohort attempts ×
            100. FG% and field-goal points per attempt fade below 10 attempts;
            baseline difference requires 10 cohort and 25 baseline attempts in
            the region. Gray means unavailable. Field-goal points use recorded
            2PT/3PT values; free throws and rebounds are excluded. Baselines
            include the selected player and describe the filtered population;
            they do not adjust for shot quality.
          </p>
          {summaries && (
            <>
              <div className="region-controls">
                <label>
                  Inspect region
                  <select
                    aria-label="Inspect region"
                    value={cell ?? "all"}
                    onChange={(e) =>
                      setCell(e.target.value === "all" ? null : e.target.value)
                    }
                  >
                    <option value="all">All regions</option>
                    {regions.map((v) => (
                      <option key={v} value={v}>
                        {v === "outside"
                          ? "Outside half-court view"
                          : `Region ${v}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Inspect cohort
                  <select
                    aria-label="Inspect cohort"
                    value={inspect}
                    onChange={(e) => setInspect(e.target.value as "A" | "B")}
                  >
                    <option>A</option>
                    <option>B</option>
                  </select>
                </label>
                <button type="button" onClick={() => setCell(null)}>
                  Clear region
                </button>
                {cell && (
                  <p>
                    {bin
                      ? `${bin.n} attempts · ${bin.made} made · ${valueLabel(bin, metric)} · baseline ${bin.baseline_n} attempts (${bin.baseline_fg_pct.toFixed(1)}% FG)`
                      : "No attempts in this region for this cohort."}
                  </p>
                )}
              </div>
              <Distribution summaries={summaries.slice(0, 2)} cell={cell} />
              <section className="season-evolution">
                <p className="eyebrow">Season small multiples · cohort A</p>
                <h3>{name(a.player_id)} across the archive</h3>
                <div className="season-maps">
                  {summaries.slice(2).map((s, i) => (
                    <button
                      type="button"
                      key={seasons[i]}
                      aria-label={`Compare ${seasons[i]} in cohort A`}
                      onClick={() => setA({ ...a, season: seasons[i] })}
                      aria-pressed={a.season === seasons[i]}
                    >
                      <strong>{seasons[i]}</strong>
                      <HexCourt
                        summary={s}
                        metric={metric}
                        max={max}
                        selected={cell}
                      />
                      <span>{fmt.format(s.n)} attempts</span>
                    </button>
                  ))}
                </div>
              </section>
              <AttemptList
                key={`${query(selectedFilters)}|${cell}`}
                filters={selectedFilters}
                cell={cell}
                onReplay={onReplay}
              />
            </>
          )}
        </>
      )}
      <details className="atlas-coverage">
        <summary>
          Season coverage & provenance · {options.seasons.length} verified
          archive pairs
        </summary>
        <p>
          Historical shot coverage is independent of tracking. Only audited
          windows from two 2015–16 games have local replay data. Archive
          reconciliation is not a check against an official season schedule;
          postseason is excluded.
        </p>
        {options.seasons.map((s) => (
          <article key={s.season}>
            <h3>{s.season}</h3>
            <p>
              {fmt.format(s.attempts)} shots · {s.games} games · {s.teams} teams
              · {date(s.date_min)} to {date(s.date_max)}
            </p>
            <p>
              {fmt.format(s.event_matched)} metadata-verified PBP matches /{" "}
              {fmt.format(s.attempts)} shots. Paired PBP:{" "}
              {fmt.format(s.pbp_attempts)} distinct attempt keys from{" "}
              {fmt.format(s.pbp_rows)} rows; {s.duplicate_pbp_keys} duplicate
              keys. {s.pbp_attempts_without_shot} PBP keys without a shot;{" "}
              {s.shots_without_pbp_key} shots without a PBP key. Unknown
              opponents: {s.unknown_opponent}.
            </p>
            <ul>
              {s.sources.map((source) => (
                <li key={source.id}>
                  <a href={source.url}>{source.filename}</a>
                  <code>SHA-256 {source.sha256}</code>
                </li>
              ))}
            </ul>
          </article>
        ))}
        <p>
          Files remain local. Underlying NBA data redistribution permission has
          not been established.
        </p>
      </details>
    </div>
  );
}
