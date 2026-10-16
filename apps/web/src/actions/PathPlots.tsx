import { useMemo } from "react";
import { courtMarkings } from "../replay/ReplayCourt";
import type { Match, PathFeature, Profile } from "./model";
import { pairedDistances, rms, scoredPoints } from "./model";
export function PathThumbnail({
  feature,
  color = "#206483",
  label,
}: {
  feature: PathFeature;
  color?: string;
  label?: string;
}) {
  return (
    <svg
      viewBox="-2 -2 98 54"
      className="path-thumbnail"
      role="img"
      aria-label={
        label ??
        `${feature.player_name}, recorded two-second player path on the source court`
      }
    >
      <rect width="94" height="50" fill="#cfb58d" />
      {courtMarkings}
      <polyline
        points={feature.x_ft.map((x, i) => `${x},${feature.y_ft[i]}`).join(" ")}
        fill="none"
        stroke={color}
        strokeWidth=".8"
        strokeLinejoin="round"
      />
      <path
        d={`M${feature.x_ft[0]} ${feature.y_ft[0] - 1.3} l-1.2 2.4 h2.4Z`}
        fill={color}
        stroke="#fff"
        strokeWidth=".2"
      />
      <circle
        cx={feature.x_ft[20]}
        cy={feature.y_ft[20]}
        r="1.3"
        fill="#fff"
        stroke={color}
        strokeWidth=".6"
      />
    </svg>
  );
}
export function PathOverlay({
  query,
  match,
  profile,
}: {
  query: PathFeature;
  match: Match;
  profile: Profile;
}) {
  const geometry = useMemo(() => {
    const q = scoredPoints(query, profile),
      c = scoredPoints(match, profile),
      points = [...q, ...c];
    const xmin = Math.min(...points.map((p) => p.x)),
      xmax = Math.max(...points.map((p) => p.x));
    const ymin = Math.min(...points.map((p) => p.y)),
      ymax = Math.max(...points.map((p) => p.y));
    const span = Math.max(10, xmax - xmin, ymax - ymin) * 1.25;
    const loX = (xmin + xmax - span) / 2,
      loY = (ymin + ymax - span) / 2;
    const x = (v: number) => 42 + ((v - loX) / span) * 250,
      y = (v: number) => 18 + ((v - loY) / span) * 250;
    return {
      q,
      c,
      span,
      loX,
      loY,
      x,
      y,
      distances: pairedDistances(query, match, profile),
    };
  }, [query, match, profile]);
  const clientScore = rms(query, match, profile);
  const parity = Math.abs(clientScore - match.rms_ft) <= 1e-8;
  return (
    <section className="path-comparison" aria-label="Scored path overlay">
      <div className="path-overlay-heading">
        <div>
          <p className="eyebrow">One query · one matched path</p>
          <h3>
            {profile === "start_relative"
              ? "Starts aligned. Source axes preserved."
              : "Locations retained in source court feet."}
          </h3>
        </div>
        <div className="rms-readout">
          <strong>
            {match.rms_ft.toFixed(2)} <small>ft</small>
          </strong>
          <span>paired-position RMS distance</span>
        </div>
      </div>
      <div className="path-overlay-body">
        <svg
          viewBox="0 0 345 300"
          role="img"
          aria-label={`Overlay of two ${profile === "start_relative" ? "start-aligned" : "source-court"} paths; 21 paired samples, RMS ${match.rms_ft.toFixed(2)} feet`}
        >
          {[0, 0.5, 1].map((t) => (
            <g key={t} className="path-overlay-axis">
              <line x1="42" x2="292" y1={18 + t * 250} y2={18 + t * 250} />
              <line x1={42 + t * 250} x2={42 + t * 250} y1="18" y2="268" />
              <text x={42 + t * 250} y="286" textAnchor="middle">
                {(geometry.loX + t * geometry.span).toFixed(1)}
              </text>
              <text x="36" y={22 + t * 250} textAnchor="end">
                {(geometry.loY + t * geometry.span).toFixed(1)}
              </text>
            </g>
          ))}
          {[0, 5, 10, 15, 20].map((i) => (
            <line
              key={i}
              x1={geometry.x(geometry.q[i].x)}
              y1={geometry.y(geometry.q[i].y)}
              x2={geometry.x(geometry.c[i].x)}
              y2={geometry.y(geometry.c[i].y)}
              stroke="#7c929e"
              strokeWidth=".8"
              strokeDasharray="2 3"
            >
              <title>
                {(i / 10).toFixed(1)} s target ·{" "}
                {geometry.distances[i].toFixed(3)} ft separation
              </title>
            </line>
          ))}
          {[geometry.q, geometry.c].map((points, j) => (
            <g key={j} stroke={j ? "#b55136" : "#206483"}>
              <polyline
                points={points
                  .map((p) => `${geometry.x(p.x)},${geometry.y(p.y)}`)
                  .join(" ")}
                fill="none"
                strokeWidth="2.4"
              />
              {points.map((p, i) => (
                <circle
                  key={i}
                  cx={geometry.x(p.x)}
                  cy={geometry.y(p.y)}
                  r={i === 0 || i === 20 ? 3.5 : 1.3}
                  fill={i === 20 ? "#fff" : j ? "#b55136" : "#206483"}
                  strokeWidth="1.2"
                >
                  <title>
                    {j ? "Match" : "Query"} sample {i + 1} · {p.x.toFixed(3)},{" "}
                    {p.y.toFixed(3)} ft
                  </title>
                </circle>
              ))}
            </g>
          ))}
        </svg>
        <div className="path-overlay-facts">
          <p>
            <i className="swatch a" />
            <strong>Query</strong> {query.player_name}
          </p>
          <p>
            <i className="swatch b" />
            <strong>Match</strong> {match.player_name}
          </p>
          <dl>
            <div>
              <dt>Scored positions</dt>
              <dd>21 pairs · 100 ms targets</dd>
            </div>
            <div>
              <dt>Observed frames in each span</dt>
              <dd>
                {query.observed_frames} query / {match.observed_frames} match
              </dd>
            </div>
            <div>
              <dt>Recorded duration</dt>
              <dd>
                {(query.actual_duration_ms / 1000).toFixed(3)} /{" "}
                {(match.actual_duration_ms / 1000).toFixed(3)} s
              </dd>
            </div>
            <div>
              <dt>Largest paired distance</dt>
              <dd>{Math.max(...geometry.distances).toFixed(2)} ft</dd>
            </div>
          </dl>
          <p className="definition">
            Equal x/y scale in feet; source +y points down. Five dashed
            connectors show selected sample pairs. Start is filled; end is open.
            No rotation, mirroring or duration rescaling.
          </p>
        </div>
      </div>
      {!parity && (
        <p className="tracking-notice" role="alert">
          The displayed paths do not reproduce the stored score. Rebuild the
          action index before interpreting this match.
        </p>
      )}
      <details className="paired-samples">
        <summary>Inspect all 21 paired samples & score calculation</summary>
        <p>
          RMS = square root of the mean squared Euclidean distance between
          paired positions. Each point is an actual observation within 20 ms of
          its target. Offsets below describe sampling error, not interpolated
          positions.
        </p>
        <div
          className="sample-table-wrap"
          tabIndex={0}
          role="region"
          aria-label="Paired sample coordinates and timing"
        >
          <table>
            <thead>
              <tr>
                <th>Target s</th>
                <th>Query x, y ft</th>
                <th>Match x, y ft</th>
                <th>Query offset ms</th>
                <th>Match offset ms</th>
                <th>Distance ft</th>
              </tr>
            </thead>
            <tbody>
              {geometry.q.map((p, i) => (
                <tr key={i}>
                  <th>{(i / 10).toFixed(1)}</th>
                  <td>
                    {p.x.toFixed(3)}, {p.y.toFixed(3)}
                  </td>
                  <td>
                    {geometry.c[i].x.toFixed(3)}, {geometry.c[i].y.toFixed(3)}
                  </td>
                  <td>{query.offsets_ms[i]}</td>
                  <td>{match.offsets_ms[i]}</td>
                  <td>{geometry.distances[i].toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Browser recomputation: {clientScore.toFixed(8)} ft · API:{" "}
          {match.rms_ft.toFixed(8)} ft ·{" "}
          {parity ? "agree within 1e-8 ft" : "disagree"}. Values reflect this
          coordinate profile, not play-call similarity.
        </p>
      </details>
    </section>
  );
}
