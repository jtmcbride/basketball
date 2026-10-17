import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { clock, trackingClock } from "../data";
import {
  BANDS,
  METRICS,
  REASONS,
  filterArcs,
  median,
  parseReport,
} from "./model";
import type { Arc, ArcReport, Band, Metric } from "./model";
import "./arcs.css";

const RIM = 10;
const quarter = (p: number) => (p > 4 ? `OT${p - 4}` : `Q${p}`);
const fixed = (v: number | null, digits = 1) =>
  v === null ? "Unavailable" : v.toFixed(digits);
const metricValue = (arc: Arc, metric: Metric) => arc[metric];

interface Tip {
  x: number;
  y: number;
  arc: Arc;
}

function useTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const move = (arc: Arc) => (event: ReactPointerEvent<SVGElement>) => {
    const box =
      event.currentTarget.ownerSVGElement?.parentElement?.getBoundingClientRect();
    if (box)
      setTip({ x: event.clientX - box.left, y: event.clientY - box.top, arc });
  };
  return { tip, move, clear: () => setTip(null) };
}

// Charts draw in CSS pixels so labels stay legible at every width.
function useWidth(initial: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(280, Math.round(entry.contentRect.width))),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function Tooltip({ tip, metric }: { tip: Tip | null; metric?: Metric }) {
  if (!tip) return null;
  const a = tip.arc;
  return (
    <div
      className="arc-tooltip"
      style={{ left: tip.x, top: tip.y }}
      role="status"
    >
      <strong>{a.player_name}</strong>
      <span>
        {a.made ? "Made" : "Missed"} {a.shot_value}PT · {a.recorded_distance_ft}{" "}
        ft
      </span>
      <span>
        Peak {a.apex_height_ft.toFixed(1)} ft · {a.flight_ms} ms
        {metric === "entry_angle_deg" && a.entry_angle_deg !== null
          ? ` · ${a.entry_angle_deg.toFixed(1)}°`
          : ""}
      </span>
    </div>
  );
}

function SideView({
  arcs,
  reach,
  ceiling,
  selected,
  onSelect,
}: {
  arcs: Arc[];
  reach: number;
  ceiling: number;
  selected: Arc | undefined;
  onSelect: (id: string) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const { tip, move, clear } = useTip();
  const [ref, width] = useWidth(760);
  // Equal feet on both axes so recorded arc shape is not distorted.
  const left = width < 500 ? 32 : 40,
    right = 14,
    top = 14,
    bottom = 40;
  const ppf = (width - left - right) / (reach + 4);
  const height = top + bottom + ceiling * ppf;
  const x = (s: number) => left + (reach - s) * ppf;
  const y = (z: number) => top + (ceiling - z) * ppf;
  const line = (points: { s_ft: number; z_ft: number }[]) =>
    points
      .map(
        (p, i) =>
          `${i ? "L" : "M"}${x(p.s_ft).toFixed(1)} ${y(p.z_ft).toFixed(1)}`,
      )
      .join("");
  const order = [
    ...arcs.filter(
      (a) => a.shot_id !== selected?.shot_id && a.shot_id !== hovered,
    ),
    ...arcs.filter(
      (a) => a.shot_id === hovered && a.shot_id !== selected?.shot_id,
    ),
    ...(selected && arcs.includes(selected) ? [selected] : []),
  ];
  const sel = selected && arcs.includes(selected) ? selected : undefined;
  const flight = sel?.samples.filter((p) => p.phase === "flight") ?? [];
  const apex = sel && flight.find((p) => p.t_ms === sel.apex_t_ms);
  const ticksX = Array.from(
    { length: Math.floor(reach / 5) + 1 },
    (_, i) => i * 5,
  );
  const ticksZ = Array.from(
    { length: Math.floor(ceiling / 5) + 1 },
    (_, i) => i * 5,
  );
  return (
    <div className="arc-chart" ref={ref} onPointerLeave={clear}>
      <svg
        viewBox={`0 0 ${width} ${height.toFixed(0)}`}
        role="img"
        aria-label={`Side view of ${arcs.length} recorded ball flights. Use the attempt selector or flight table to inspect values.`}
      >
        <g className="arc-grid">
          {ticksX.map((t) => (
            <g key={`x${t}`}>
              <line x1={x(t)} x2={x(t)} y1={top} y2={y(0)} />
              <text x={x(t)} y={y(0) + 16} textAnchor="middle">
                {t}
              </text>
            </g>
          ))}
          {ticksZ.map((t) => (
            <g key={`z${t}`}>
              <line x1={x(reach)} x2={x(-4)} y1={y(t)} y2={y(t)} />
              <text x={left - 8} y={y(t) + 4} textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          <text x={(x(reach) + x(-4)) / 2} y={height - 6} textAnchor="middle">
            Feet from rim centre along the release line
          </text>
          <text
            transform={`translate(12 ${top + (ceiling * ppf) / 2}) rotate(-90)`}
            textAnchor="middle"
          >
            Height (ft)
          </text>
        </g>
        <line
          className="arc-floor"
          x1={x(reach)}
          x2={x(-4)}
          y1={y(0)}
          y2={y(0)}
        />
        <line
          className="arc-rim-height"
          x1={x(reach)}
          x2={x(-4)}
          y1={y(RIM)}
          y2={y(RIM)}
        />
        <text className="arc-annotation" x={x(reach) + 4} y={y(RIM) - 5}>
          Rim height 10 ft
        </text>
        {order.map((a) => {
          const isSel = a.shot_id === sel?.shot_id;
          const isHover = a.shot_id === hovered;
          const pts = a.samples.filter((p) => p.phase === "flight");
          const after = a.samples.slice(pts.length - 1);
          return (
            <g
              key={a.shot_id}
              className={`arc ${a.made ? "made" : "missed"}${isSel ? " selected" : ""}${isHover ? " hovered" : ""}`}
            >
              <path className="arc-after" d={line(after)} />
              <path className="arc-flight" d={line(pts)} />
              <path
                className="arc-hit"
                d={line(a.samples)}
                onPointerEnter={() => setHovered(a.shot_id)}
                onPointerMove={move(a)}
                onPointerLeave={() => setHovered(null)}
                onClick={() => onSelect(a.shot_id)}
              />
            </g>
          );
        })}
        <line
          className="arc-rim"
          x1={x(0.75)}
          x2={x(-0.75)}
          y1={y(RIM)}
          y2={y(RIM)}
        />
        {sel && apex && (
          <g className="arc-markers" pointerEvents="none">
            <circle
              className="release"
              cx={x(flight[0].s_ft)}
              cy={y(flight[0].z_ft)}
              r="5"
            />
            <text
              x={x(flight[0].s_ft)}
              y={y(flight[0].z_ft) + 20}
              textAnchor="middle"
            >
              Candidate release
            </text>
            <path
              className="apex"
              d={`M${x(apex.s_ft)} ${y(apex.z_ft) - 6} l6 6 -6 6 -6 -6z`}
            />
            <text x={x(apex.s_ft)} y={y(apex.z_ft) - 11} textAnchor="middle">
              Peak {apex.z_ft.toFixed(1)} ft
            </text>
            <circle
              className="arrival"
              cx={x(flight[flight.length - 1].s_ft)}
              cy={y(flight[flight.length - 1].z_ft)}
              r="5"
            />
          </g>
        )}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

function Scatter({
  arcs,
  all,
  metric,
  reach,
  selected,
  onSelect,
}: {
  arcs: Arc[];
  all: Arc[];
  metric: Metric;
  reach: number;
  selected: Arc | undefined;
  onSelect: (id: string) => void;
}) {
  const { tip, move, clear } = useTip();
  const [ref, chartWidth] = useWidth(520);
  const left = 48,
    right = 12,
    top = 12,
    bottom = 40,
    width = chartWidth,
    height = Math.min(300, Math.max(220, chartWidth * 0.6));
  // Domain from every flight so filters never rescale the axis.
  const values = all
    .map((a) => metricValue(a, metric))
    .filter((v): v is number => v !== null);
  const lo = Math.floor(Math.min(...values) * 0.95);
  const hi = Math.ceil(Math.max(...values) * 1.03);
  const x = (d: number) => left + (d / reach) * (width - left - right);
  const y = (v: number) =>
    top + ((hi - v) / (hi - lo)) * (height - top - bottom);
  const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
  const shown = arcs.filter((a) => metricValue(a, metric) !== null);
  const info = METRICS[metric];
  return (
    <div className="arc-chart" ref={ref} onPointerLeave={clear}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${info.label} against release distance for ${shown.length} flights`}
      >
        <g className="arc-grid">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} />
              <text x={left - 8} y={y(t) + 4} textAnchor="end">
                {metric === "flight_ms" ? Math.round(t) : t.toFixed(1)}
              </text>
            </g>
          ))}
          {Array.from(
            { length: Math.floor(reach / 5) + 1 },
            (_, i) => i * 5,
          ).map((t) => (
            <text key={t} x={x(t)} y={height - bottom + 18} textAnchor="middle">
              {t}
            </text>
          ))}
          <text
            x={(left + width - right) / 2}
            y={height - 6}
            textAnchor="middle"
          >
            Release distance from rim (ft)
          </text>
        </g>
        {shown.map((a) => {
          const v = metricValue(a, metric) as number;
          const isSel = a.shot_id === selected?.shot_id;
          return (
            <g
              key={a.shot_id}
              className={`arc-dot ${a.made ? "made" : "missed"}${isSel ? " selected" : ""}`}
            >
              <circle
                cx={x(a.release_distance_ft)}
                cy={y(v)}
                r={isSel ? 6 : 4}
              />
              <circle
                className="arc-hit"
                cx={x(a.release_distance_ft)}
                cy={y(v)}
                r="10"
                onPointerMove={move(a)}
                onClick={() => onSelect(a.shot_id)}
              />
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} metric={metric} />
    </div>
  );
}

function HeightCheck({ report }: { report: ArcReport }) {
  const check = report.height_check;
  const [ref, width] = useWidth(520);
  // Stacked dots in pixel-wide bins; crossings beyond the cap are counted.
  const cap = 4,
    step = 7,
    left = 64,
    right = 84;
  const ppf = (width - left - right) / cap;
  const x = (v: number) => left + v * ppf;
  const stack = (values: number[]) => {
    const columns = new Map<number, number[]>();
    for (const v of values.filter((v) => v <= cap)) {
      const column = Math.round((v * ppf) / step);
      columns.set(column, [...(columns.get(column) ?? []), v]);
    }
    return {
      columns: [...columns.entries()],
      tallest: Math.max(1, ...[...columns.values()].map((c) => c.length)),
      over: values.filter((v) => v > cap).length,
    };
  };
  const made = stack(check.made.values);
  const missed = stack(check.missed.values);
  const rows = [
    ["made", made, 14 + made.tallest * step],
    ["missed", missed, 14 + made.tallest * step + 22 + missed.tallest * step],
  ] as const;
  const height = rows[1][2] + 30;
  return (
    <section className="arc-check" aria-labelledby="arc-check-heading">
      <h3 id="arc-check-heading">Does recorded ball height hold up?</h3>
      <p>
        Made shots should drop through the rim plane near its centre. Each dot
        is one flight's recorded observation nearest 10 ft on the way down.
      </p>
      <div ref={ref}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Rim-plane crossing distance: ${check.made.within_1_5_ft} of ${check.made.crossings} made and ${check.missed.within_1_5_ft} of ${check.missed.crossings} missed crossings within 1.5 ft`}
        >
          <rect
            className="arc-rim-band"
            x={x(0)}
            y={4}
            width={x(0.75) - x(0)}
            height={height - 30}
          />
          <line
            className="arc-rule"
            x1={x(1.5)}
            x2={x(1.5)}
            y1={4}
            y2={height - 26}
          />
          <text className="arc-annotation" x={x(1.5) + 5} y={14}>
            1.5 ft rule
          </text>
          {rows.map(([key, data, base]) => (
            <g key={key} className={`arc-dot ${key}`}>
              <text
                className="arc-row-label"
                x={left - 12}
                y={base - 2}
                textAnchor="end"
              >
                {key === "made" ? "Made" : "Missed"}
              </text>
              {data.columns.flatMap(([column, values]) =>
                values.map((v, i) => (
                  <circle
                    key={`${column}:${i}`}
                    cx={left + column * step}
                    cy={base - step / 2 - i * step}
                    r="3"
                  >
                    <title>{v.toFixed(2)} ft</title>
                  </circle>
                )),
              )}
              {data.over > 0 && (
                <text
                  className="arc-annotation"
                  x={width - right + 8}
                  y={base - 2}
                >
                  +{data.over} over {cap} ft
                </text>
              )}
            </g>
          ))}
          <g className="arc-grid">
            <line
              x1={left}
              x2={width - right}
              y1={height - 26}
              y2={height - 26}
            />
            {Array.from({ length: cap + 1 }, (_, t) => (
              <text key={t} x={x(t)} y={height - 8} textAnchor="middle">
                {t} ft
              </text>
            ))}
          </g>
        </svg>
      </div>
      <p className={check.passed ? "arc-pass" : "arc-fail"}>
        <strong>{check.passed ? "Check passed" : "Check not passed"}</strong> ·{" "}
        {check.made.within_1_5_ft} of {check.made.crossings} made crossings
        within 1.5 ft · median {fixed(check.made.median_ft, 2)} ft vs{" "}
        {fixed(check.missed.median_ft, 2)} ft for misses. Shaded band is the
        0.75 ft rim radius.
      </p>
    </section>
  );
}

export function ShotArcs({
  onReplay,
}: {
  onReplay: (gameId: string, shotId: string) => void;
}) {
  const [report, setReport] = useState<ArcReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<"all" | "made" | "missed">("all");
  const [distance, setDistance] = useState<Band>("all");
  const [gameId, setGameId] = useState("all");
  const [metric, setMetric] = useState<Metric>("apex_height_ft");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/arcs", { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.detail ?? "Ball flights could not be read.");
        return parseReport(data);
      })
      .then(setReport)
      .catch((err: Error) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, []);
  const arcs = useMemo(
    () => (report ? filterArcs(report.arcs, result, distance, gameId) : []),
    [report, result, distance, gameId],
  );
  if (error)
    return (
      <section className="empty-state" role="alert">
        <h2>Load recorded ball flights</h2>
        <p>{error}</p>
      </section>
    );
  if (!report)
    return (
      <p className="message" role="status">
        Reading recorded ball flights…
      </p>
    );
  const reach = Math.max(
    30,
    Math.ceil(Math.max(...report.arcs.map((a) => a.release_distance_ft)) + 2),
  );
  const ceiling = Math.ceil(
    Math.max(...report.arcs.flatMap((a) => a.samples.map((s) => s.z_ft))) + 1,
  );
  const selected =
    arcs.find((a) => a.shot_id === selectedId) ??
    arcs.find((a) => a.made && a.recorded_distance_ft >= 22) ??
    arcs[0];
  const games = [
    ...new Map(report.arcs.map((a) => [a.game_id, a.matchup])).entries(),
  ];
  const medianApex = median(arcs.map((a) => a.apex_height_ft));
  const medianEntry = median(
    arcs.flatMap((a) =>
      a.entry_angle_deg === null ? [] : [a.entry_angle_deg],
    ),
  );
  return (
    <div className="shot-arcs">
      <div className="arc-intro">
        <div>
          <p className="eyebrow">Recorded ball flight · tracking games</p>
          <h2>How the ball gets there.</h2>
        </div>
        <p>
          A side view of the ball between a candidate release and the rim, from
          recorded SportVU height. No fitted curves; the target rim is the one
          the ball reaches.
        </p>
      </div>
      <div className="arc-coverage">
        <span>
          <strong>{report.coverage.available}</strong> of{" "}
          {report.coverage.matched_attempts} matched attempts have a recorded
          flight
        </span>
        <span>
          {report.coverage.matched_attempts - report.coverage.available}{" "}
          unavailable with a stated reason
        </span>
        <span>2 audited games · nominal 25 Hz</span>
      </div>
      <div className="arc-filters">
        <div className="arc-segmented" role="group" aria-label="Result">
          {(["all", "made", "missed"] as const).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={result === r}
              onClick={() => setResult(r)}
            >
              {r === "all" ? "All results" : r === "made" ? "Made" : "Missed"}
            </button>
          ))}
        </div>
        <label>
          Shot-chart distance
          <select
            aria-label="Shot-chart distance"
            value={distance}
            onChange={(e) => setDistance(e.target.value as Band)}
          >
            {(Object.keys(BANDS) as Band[]).map((b) => (
              <option key={b} value={b}>
                {BANDS[b]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Game
          <select
            aria-label="Game"
            value={gameId}
            onChange={(e) => setGameId(e.target.value)}
          >
            <option value="all">Both games</option>
            {games.map(([id, matchup]) => (
              <option key={id} value={id}>
                {matchup}
              </option>
            ))}
          </select>
        </label>
        <span className="arc-legend" aria-label="Legend">
          <span>
            <i className="made" /> Made
          </span>
          <span>
            <i className="missed" /> Missed
          </span>
          <span>
            <i className="after" /> After rim arrival
          </span>
        </span>
      </div>
      {arcs.length === 0 ? (
        <section className="empty-state">
          <h2>No recorded flights match</h2>
          <p>Widen the result, distance or game filter.</p>
        </section>
      ) : (
        <div className="arc-main">
          <section className="arc-panel" aria-labelledby="arc-side-heading">
            <div className="arc-panel-heading">
              <h3 id="arc-side-heading">
                {arcs.length} flight{arcs.length === 1 ? "" : "s"}, shooter on
                the left
              </h3>
              <span>
                Median peak {fixed(medianApex)} ft · median entry{" "}
                {fixed(medianEntry)}°
              </span>
            </div>
            <SideView
              arcs={arcs}
              reach={reach}
              ceiling={ceiling}
              selected={selected}
              onSelect={setSelectedId}
            />
            <p className="arc-note">
              Equal scale in feet. Lateral offset from the release line is
              dropped. Solid flight ends at rim arrival; the faint tail shows up
              to 0.76 s of recorded observations after it.
            </p>
          </section>
          {selected && (
            <aside className="arc-detail" aria-label="Selected flight">
              <label>
                Inspect attempt
                <select
                  aria-label="Inspect attempt"
                  value={selected.shot_id}
                  onChange={(e) => setSelectedId(e.target.value)}
                >
                  {arcs.map((a) => (
                    <option key={a.shot_id} value={a.shot_id}>
                      {a.player_name} · {quarter(a.period)}{" "}
                      {clock(a.game_clock_s)} · {a.made ? "Made" : "Missed"}
                    </option>
                  ))}
                </select>
              </label>
              <h3>{selected.player_name}</h3>
              <p>
                {selected.matchup} · {quarter(selected.period)}{" "}
                {trackingClock(selected.release_clock_s)} release ·{" "}
                {selected.made ? "Made" : "Missed"} {selected.shot_value}PT
              </p>
              <p className="arc-action">
                {selected.action_type} · {selected.recorded_distance_ft} ft on
                the shot chart
              </p>
              <dl>
                {[
                  [
                    "Release distance",
                    `${selected.release_distance_ft.toFixed(1)} ft`,
                    "Recorded",
                  ],
                  [
                    "Height at release",
                    `${selected.release_height_ft.toFixed(1)} ft`,
                    "Recorded",
                  ],
                  [
                    "Peak height",
                    `${selected.apex_height_ft.toFixed(1)} ft`,
                    "Recorded",
                  ],
                  ["Flight to rim", `${selected.flight_ms} ms`, "Recorded"],
                  [
                    "Entry angle",
                    selected.entry_angle_deg === null
                      ? "Unavailable"
                      : `${selected.entry_angle_deg.toFixed(1)}°`,
                    "Derived",
                  ],
                  [
                    "Rim-plane crossing",
                    selected.rim_crossing_ft === null
                      ? "Not observed"
                      : `${selected.rim_crossing_ft.toFixed(2)} ft from centre`,
                    "Recorded",
                  ],
                ].map(([k, v, basis]) => (
                  <div key={k}>
                    <dt>
                      {k} <small>{basis}</small>
                    </dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <button
                type="button"
                onClick={() => onReplay(selected.game_id, selected.shot_id)}
              >
                Open tracking replay
              </button>
              <p className="arc-note">
                Candidate release is the last observation with the ball within 2
                ft of the shooter. It is not a verified release annotation.
              </p>
            </aside>
          )}
        </div>
      )}
      <div className="arc-lower">
        <section className="arc-panel" aria-labelledby="arc-compare-heading">
          <div className="arc-panel-heading">
            <h3 id="arc-compare-heading">Compare flights by distance</h3>
            <label>
              Measure
              <select
                aria-label="Measure"
                value={metric}
                onChange={(e) => setMetric(e.target.value as Metric)}
              >
                {(Object.keys(METRICS) as Metric[]).map((m) => (
                  <option key={m} value={m}>
                    {METRICS[m].label} ({METRICS[m].unit})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Scatter
            arcs={arcs}
            all={report.arcs}
            metric={metric}
            reach={reach}
            selected={selected}
            onSelect={setSelectedId}
          />
          <p className="arc-note">
            {METRICS[metric].basis} measure. Two games; descriptive only, not a
            shot-quality model.
          </p>
        </section>
        <HeightCheck report={report} />
      </div>
      <details className="sources">
        <summary>Flight table · {arcs.length} filtered flights</summary>
        <div className="arc-table-scroll">
          <table className="arc-table">
            <thead>
              <tr>
                <th>Player</th>
                <th>Time</th>
                <th>Result</th>
                <th>Release ft</th>
                <th>Release height</th>
                <th>Peak</th>
                <th>Entry °</th>
                <th>Flight ms</th>
                <th>Crossing ft</th>
              </tr>
            </thead>
            <tbody>
              {arcs.map((a) => (
                <tr key={a.shot_id}>
                  <td>{a.player_name}</td>
                  <td>
                    {quarter(a.period)} {clock(a.game_clock_s)}
                  </td>
                  <td>{a.made ? "Made" : "Missed"}</td>
                  <td>{a.release_distance_ft.toFixed(1)}</td>
                  <td>{a.release_height_ft.toFixed(1)}</td>
                  <td>{a.apex_height_ft.toFixed(1)}</td>
                  <td>{fixed(a.entry_angle_deg)}</td>
                  <td>{a.flight_ms}</td>
                  <td>{fixed(a.rim_crossing_ft, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details className="sources">
        <summary>
          Unavailable flights ·{" "}
          {report.coverage.matched_attempts - report.coverage.available} matched
          attempts
        </summary>
        <ul className="arc-reasons">
          {Object.entries(report.coverage.unavailable).map(
            ([reason, count]) => (
              <li key={reason}>
                <strong>{count}</strong>
                <span>{REASONS[reason] ?? reason}</span>
              </li>
            ),
          )}
        </ul>
      </details>
      <details className="sources">
        <summary>Flight definition & provenance</summary>
        <dl className="arc-definition">
          {Object.entries(report.definition).map(([k, v]) => (
            <div key={k}>
              <dt>{k.replaceAll("_", " ")}</dt>
              <dd>{Array.isArray(v) ? v.join("; ") : v}</dd>
            </div>
          ))}
        </dl>
        <p>
          Flight fingerprint{" "}
          <code>{report.provenance.arc_fingerprint.slice(0, 20)}…</code> ·
          source{" "}
          <code>{report.provenance.source_fingerprint.slice(0, 20)}…</code>
        </p>
      </details>
    </div>
  );
}
