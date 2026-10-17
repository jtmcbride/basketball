import { useEffect, useId, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  byValue,
  combine,
  linkMatrix,
  parseOptions,
  parseSummary,
  pct,
  ramp,
  share,
} from "./model";
import type {
  AssistCell,
  AssistOptions,
  AssistSummary,
  Partner,
  Role,
} from "./model";
import "./assists.css";

async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api${url}`, { signal });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.detail ?? "The assist index could not be read.");
  return data;
}

const hexPoints = (c: AssistCell) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = ((60 * i - 30) * Math.PI) / 180;
    return `${25 + c.cx + 2.42 * Math.cos(a)},${5.25 + c.cy + 2.42 * Math.sin(a)}`;
  }).join(" ");

function HexMap({ summary }: { summary: AssistSummary }) {
  const clipId = useId();
  const [tip, setTip] = useState<{
    x: number;
    y: number;
    cell: AssistCell;
  } | null>(null);
  const passer = summary.filters.role === "passer";
  const max = Math.max(1, ...summary.cells.map((c) => c.per_100));
  const value = (c: AssistCell) =>
    // Square root keeps the dominant rim cell from flattening the rest.
    passer ? Math.sqrt(c.per_100 / max) : c.reliable ? c.share : null;
  const move =
    (cell: AssistCell) => (event: ReactPointerEvent<SVGPolygonElement>) => {
      const box =
        event.currentTarget.ownerSVGElement?.parentElement?.getBoundingClientRect();
      if (box)
        setTip({
          x: event.clientX - box.left,
          y: event.clientY - box.top,
          cell,
        });
    };
  return (
    <div className="assist-map" onPointerLeave={() => setTip(null)}>
      <svg
        viewBox="-1 -1 52 49"
        role="img"
        aria-label={
          passer
            ? `Locations of ${combine(summary.totals).makes} made shots this player assisted`
            : `Assisted share of made field goals by location, ${combine(summary.totals).makes} makes`
        }
      >
        <defs>
          <clipPath id={clipId}>
            <rect width="50" height="47" />
          </clipPath>
        </defs>
        <rect width="50" height="47" fill="#cfb58d" />
        <g clipPath={`url(#${clipId})`}>
          {summary.cells.map((c) => (
            <polygon
              key={c.cell}
              points={hexPoints(c)}
              fill={ramp(value(c))}
              opacity={!passer && !c.reliable ? 0.35 : 0.94}
              stroke={tip?.cell.cell === c.cell ? "#102f40" : "#cfb58d"}
              strokeWidth={tip?.cell.cell === c.cell ? 0.4 : 0.08}
              onPointerMove={move(c)}
            >
              <title>
                {c.makes} makes ·{" "}
                {passer
                  ? `${c.per_100.toFixed(1)} per 100 assists`
                  : `${c.assisted} assisted`}
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
      {tip && (
        <div
          className="assist-tooltip"
          style={{ left: tip.x, top: tip.y }}
          role="status"
        >
          {passer ? (
            <>
              <strong>{tip.cell.makes} assisted makes here</strong>
              <span>
                {tip.cell.per_100.toFixed(1)} per 100 of the player's assists
              </span>
            </>
          ) : (
            <>
              <strong>
                {tip.cell.reliable
                  ? `${pct(tip.cell.share)} assisted`
                  : "Sparse: under 10 makes"}
              </strong>
              <span>
                {tip.cell.assisted} of {tip.cell.makes} makes
              </span>
              <span>League here {pct(tip.cell.league_share)}</span>
            </>
          )}
        </div>
      )}
      <div className="assist-scale" aria-label="Colour scale">
        <span>{passer ? "Fewer" : "0%"}</span>
        <i />
        <span>
          {passer
            ? `${max.toFixed(1)} per 100 assists · square-root scale`
            : "100% assisted"}
        </span>
        {!passer && <small>Faded: under 10 makes</small>}
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="assist-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function Matrix({
  summary,
  selected,
  onPick,
}: {
  summary: AssistSummary;
  selected: string | null;
  onPick: (id: string, role: Role) => void;
}) {
  const { players, outside_core } = summary.network;
  const { at, max } = linkMatrix(summary.network);
  const last = (name: string) => name.split(" ").slice(-1)[0];
  return (
    <section className="assist-matrix" aria-labelledby="assist-matrix-heading">
      <div className="assist-panel-heading">
        <h3 id="assist-matrix-heading">Passer → shooter, assisted makes</h3>
        <span>
          Rows pass, columns score. {outside_core.toLocaleString()} assisted
          makes involve other players.
        </span>
      </div>
      <div className="assist-matrix-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Passer</span>
              </th>
              {players.map((p) => (
                <th
                  key={p.id}
                  scope="col"
                  className={p.id === selected ? "selected" : undefined}
                >
                  <button
                    type="button"
                    title={`${p.name} as shooter`}
                    onClick={() => onPick(p.id, "shooter")}
                  >
                    {last(p.name)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {players.map((row) => (
              <tr key={row.id}>
                <th
                  scope="row"
                  className={row.id === selected ? "selected" : undefined}
                >
                  <button
                    type="button"
                    title={`${row.name} as passer`}
                    onClick={() => onPick(row.id, "passer")}
                  >
                    {row.name}
                  </button>
                </th>
                {players.map((col) => {
                  if (row.id === col.id)
                    return (
                      <td key={col.id} className="self">
                        <span className="sr-only">Same player</span>
                      </td>
                    );
                  const n = at(row.id, col.id);
                  const t = n / max;
                  return (
                    <td
                      key={col.id}
                      style={{ background: n ? ramp(t) : undefined }}
                      className={t > 0.55 ? "dark" : undefined}
                      title={`${row.name} → ${col.name}: ${n} assisted makes`}
                    >
                      {n || ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Partners({ title, rows }: { title: string; rows: Partner[] }) {
  return (
    <div className="assist-partners">
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p>None recorded</p>
      ) : (
        <ol>
          {rows.map((r) => (
            <li key={r.id}>
              <span>{r.name ?? r.id}</span>
              <strong>{r.makes}</strong>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function AssistMap() {
  const [options, setOptions] = useState<AssistOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [season, setSeason] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("shooter");
  const [summary, setSummary] = useState<{
    key: string;
    data?: AssistSummary;
    error?: string;
  }>({ key: "" });
  useEffect(() => {
    const controller = new AbortController();
    read<AssistOptions>("/assists/options", controller.signal)
      .then((o) => setOptions(parseOptions(o)))
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  const seasons = options ? Object.keys(options.coverage) : [];
  const activeSeason = season ?? seasons[seasons.length - 1] ?? null;
  const teams = options?.teams.filter((t) => t.season === activeSeason) ?? [];
  const team = teams.find((t) => t.id === teamId) ?? teams[0];
  const effectiveRole: Role = playerId ? role : "shooter";
  const filters =
    activeSeason && team
      ? {
          season: activeSeason,
          team_id: team.id,
          player_id: playerId,
          role: effectiveRole,
        }
      : null;
  const key = filters ? JSON.stringify(filters) : "";
  useEffect(() => {
    if (!filters) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      season: filters.season,
      team_id: filters.team_id,
      role: filters.role,
    });
    if (filters.player_id) params.set("player_id", filters.player_id);
    read<AssistSummary>(`/assists/summary?${params}`, controller.signal)
      .then((data) => setSummary({ key, data: parseSummary(data, filters) }))
      .catch((e: Error) => {
        if (!controller.signal.aborted) setSummary({ key, error: e.message });
      });
    return () => controller.abort();
  }, [key]);
  if (error)
    return (
      <section className="empty-state" role="alert">
        <h2>Load the assist index</h2>
        <p>{error}</p>
      </section>
    );
  if (!options || !filters)
    return (
      <p className="message" role="status">
        Reading recorded assists…
      </p>
    );
  const current = summary.key === key ? summary : { key };
  const s = current.data;
  const player = s?.players.find((p) => p.id === playerId);
  const coverage = options.coverage[filters.season];
  const leagueAll = s ? share(combine(s.league)) : null;
  return (
    <div className="assist-view">
      <div className="assist-intro">
        <div>
          <p className="eyebrow">Recorded assists · made field goals</p>
          <h2>Who sets up whom.</h2>
        </div>
        <p>
          Play-by-play credits an assist only on a make, so every share here is
          of made field goals. The map shows where the shot was made, not where
          the pass began.
        </p>
      </div>
      <div className="assist-coverage">
        <span>
          <strong>
            {(coverage.assisted + coverage.unassisted).toLocaleString()}
          </strong>{" "}
          verified makes in {filters.season}
        </span>
        <span>
          {pct(
            coverage.assisted / (coverage.assisted + coverage.unassisted),
            1,
          )}{" "}
          assisted league-wide
        </span>
        <span>
          {coverage.unverified + coverage.event_unmatched} makes without a
          verified assist record
        </span>
      </div>
      <div className="assist-filters">
        <label>
          Season
          <select
            aria-label="Season"
            value={filters.season}
            onChange={(e) => {
              setSeason(e.target.value);
              setTeamId(null);
              setPlayerId(null);
            }}
          >
            {seasons.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          Team
          <select
            aria-label="Team"
            value={filters.team_id}
            onChange={(e) => {
              setTeamId(e.target.value);
              setPlayerId(null);
            }}
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Player
          <select
            aria-label="Player"
            value={playerId ?? ""}
            onChange={(e) => setPlayerId(e.target.value || null)}
            disabled={!s}
          >
            <option value="">Whole team</option>
            {s?.players.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="assist-segmented" role="group" aria-label="Role">
          {(["shooter", "passer"] as const).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={effectiveRole === r}
              disabled={!playerId && r === "passer"}
              onClick={() => setRole(r)}
            >
              {r === "shooter" ? "As shooter" : "As passer"}
            </button>
          ))}
        </div>
      </div>
      {current.error ? (
        <section className="empty-state" role="alert">
          <h2>Assist summary unavailable</h2>
          <p>{current.error}</p>
        </section>
      ) : !s ? (
        <p className="message" role="status">
          Reading {team?.name}…
        </p>
      ) : (
        <>
          <div className="assist-main">
            <section
              className="assist-panel"
              aria-labelledby="assist-map-heading"
            >
              <div className="assist-panel-heading">
                <h3 id="assist-map-heading">
                  {effectiveRole === "passer"
                    ? `Where ${player?.name}'s assists were scored`
                    : `Assisted share of ${player ? `${player.name}'s` : `${team?.name}`} makes`}
                </h3>
              </div>
              <HexMap summary={s} />
            </section>
            <aside className="assist-side" aria-label="Cohort totals">
              {effectiveRole === "passer" && player ? (
                <>
                  <Tile
                    label="Assists"
                    value={player.assists.toLocaleString()}
                  />
                  <Tile
                    label="Assists to threes"
                    value={pct(
                      combine(s.totals).makes
                        ? (byValue(s.totals, 3)?.makes ?? 0) /
                            combine(s.totals).makes
                        : null,
                    )}
                    note={`League: ${pct(
                      (byValue(s.league, 3)?.assisted ?? 0) /
                        combine(s.league).assisted,
                    )} of assists lead to threes`}
                  />
                  <Partners
                    title="Most assisted teammates"
                    rows={s.partners?.targets ?? []}
                  />
                </>
              ) : (
                <>
                  <Tile
                    label="Made field goals"
                    value={combine(s.totals).makes.toLocaleString()}
                  />
                  <Tile
                    label="Assisted"
                    value={pct(share(combine(s.totals)))}
                    note={`League ${pct(leagueAll)}`}
                  />
                  <Tile
                    label="3PT makes assisted"
                    value={pct(share(byValue(s.totals, 3)))}
                    note={`League ${pct(share(byValue(s.league, 3)))}`}
                  />
                  <Tile
                    label="2PT makes assisted"
                    value={pct(share(byValue(s.totals, 2)))}
                    note={`League ${pct(share(byValue(s.league, 2)))}`}
                  />
                  {player && s.partners && (
                    <Partners
                      title="Most frequent passers"
                      rows={s.partners.passers}
                    />
                  )}
                </>
              )}
              {s.unverified_team_makes > 0 && (
                <p className="assist-note">
                  {s.unverified_team_makes} team makes lack a verified assist
                  record and are excluded.
                </p>
              )}
            </aside>
          </div>
          <Matrix
            summary={s}
            selected={playerId}
            onPick={(id, r) => {
              setPlayerId(id);
              setRole(r);
            }}
          />
        </>
      )}
      <details className="sources">
        <summary>Assist definition & provenance</summary>
        <dl className="assist-definition">
          {Object.entries(options.definition).map(([k, v]) => (
            <div key={k}>
              <dt>{k.replaceAll("_", " ")}</dt>
              <dd>{Array.isArray(v) ? v.join("; ") : v}</dd>
            </div>
          ))}
        </dl>
        <p>
          Index fingerprint <code>{options.fingerprint.slice(0, 20)}…</code>
        </p>
      </details>
    </div>
  );
}
