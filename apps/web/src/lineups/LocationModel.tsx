import { useState } from "react";
import type { ModelReport } from "./model";

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;
const probabilityColor = (p: number) =>
  `hsl(${205 - p * 85} 42% ${92 - p * 65}%)`;
const date = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
const hex = (x: number, y: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = ((60 * i - 30) * Math.PI) / 180;
    return `${x + 2.5 * Math.cos(a)},${y + 2.5 * Math.sin(a)}`;
  }).join(" ");

export function LocationModel({ report }: { report: ModelReport }) {
  const [selected, setSelected] = useState<string | null>(null);
  const cell =
    report.cells.find((c) => c.cell === selected) ??
    report.cells.find((c) => c.train_n >= 100);
  const m = report.metrics;
  return (
    <section
      className="location-model"
      aria-label="Evaluated location-only shot model"
    >
      <div className="lineup-section-heading">
        <div>
          <p className="eyebrow">Optional model · held-out evaluation</p>
          <h2>What location alone can predict.</h2>
        </div>
        <p>
          A historical shot-make baseline. No knowledge of defenders, fatigue,
          player skill or passing options.
        </p>
      </div>
      <div className="model-splits" aria-label="Whole-game temporal split">
        {(["train", "calibration", "test"] as const).map((s) => (
          <div key={s}>
            <span>
              {s === "train"
                ? "Fit location rates"
                : s === "calibration"
                  ? "Calibrate probabilities"
                  : "Evaluate once"}
            </span>
            <strong>{report.split[s].games.length} games</strong>
            <small>
              {date(report.split[s].first_date)} →{" "}
              {date(report.split[s].last_date)}
            </small>
            <small>{report.split[s].attempts.toLocaleString()} attempts</small>
          </div>
        ))}
      </div>
      <p className="model-gate">
        {report.status === "held_out_gate_passed"
          ? "Passed the declared historical evaluation gate"
          : "Evaluation only: the declared gate did not pass"}{" "}
        · complete games remain in one split.
      </p>
      <div className="model-panels">
        <section className="model-map">
          <h3>Calibrated make probability by location</h3>
          <p>Fixed 2.5 ft cells · faint below 25 training attempts.</p>
          <svg
            viewBox="-3 -8 56 57"
            role="img"
            aria-label="Location-only probability map. Use the cell selector to inspect counts."
          >
            <defs>
              <clipPath id="model-court-clip">
                <rect x="0" y="-5.25" width="50" height="47" />
              </clipPath>
            </defs>
            <rect x="0" y="-5.25" width="50" height="47" fill="#e1d0b4" />
            <g clipPath="url(#model-court-clip)">
              {report.cells.map((c) => (
                <polygon
                  key={c.cell}
                  points={hex(25 + c.cx, c.cy)}
                  fill={probabilityColor(c.probability)}
                  opacity={c.train_n < 25 ? 0.22 : 1}
                  stroke={cell?.cell === c.cell ? "#203647" : "#eef2f5"}
                  strokeWidth={cell?.cell === c.cell ? 0.45 : 0.1}
                  onClick={() => setSelected(c.cell)}
                >
                  <title>
                    {c.cell}: {pct(c.probability)} · {c.train_n} training
                    attempts
                  </title>
                </polygon>
              ))}
            </g>
            <g
              fill="none"
              stroke="#675e4f"
              strokeWidth=".18"
              pointerEvents="none"
            >
              <rect x=".1" y="-5.15" width="49.8" height="46.8" />
              <path d="M17 -5.25 V13.75 H33 V-5.25 M3 -5.25 V8.95 A23.75 23.75 0 0 0 47 8.95 V-5.25" />
              <circle cx="25" cy="0" r=".75" />
              <circle cx="25" cy="13.75" r="6" />
            </g>
          </svg>
          <div
            className="model-color-scale"
            aria-label="Make probability color scale"
          >
            {[0.1, 0.3, 0.5, 0.7, 0.9].map((p) => (
              <span key={p}>
                <i style={{ background: probabilityColor(p) }} />
                {Math.round(p * 100)}%
              </span>
            ))}
          </div>
          <label>
            Inspect location cell
            <select
              aria-label="Model location cell"
              value={cell?.cell ?? ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              {report.cells.map((c) => (
                <option key={c.cell} value={c.cell}>
                  {c.cell} · {pct(c.probability)} · {c.train_n} training
                  attempts
                </option>
              ))}
            </select>
          </label>
          {cell && (
            <p data-testid="model-cell-detail">
              <strong>{pct(cell.probability)}</strong> calibrated probability ·{" "}
              {cell.train_n} training / {cell.calibration_n} calibration /{" "}
              {cell.test_n} test attempts.{" "}
              {cell.fallback
                ? "No training observations: the uncalibrated rate falls back to the training mean."
                : "Training rates shrink toward the overall training mean before calibration."}
            </p>
          )}
        </section>
        <section className="model-calibration">
          <h3>Do predicted rates match held-out makes?</h3>
          <p>January–April test games · 95% intervals resample whole games.</p>
          <svg
            viewBox="0 0 380 305"
            role="img"
            aria-label="Held-out calibration plot. Diagonal means predicted and observed rates agree."
          >
            {[0, 0.2, 0.4, 0.6, 0.8, 1].map((v) => (
              <g key={v}>
                <path
                  d={`M45 ${260 - v * 220} H350 M${45 + v * 305} 40 V260`}
                  stroke="#ced8de"
                  strokeWidth=".7"
                />
                <text x="35" y={264 - v * 220} textAnchor="end">
                  {Math.round(v * 100)}%
                </text>
                <text x={45 + v * 305} y="278" textAnchor="middle">
                  {Math.round(v * 100)}%
                </text>
              </g>
            ))}
            <path d="M45 260 L350 40" stroke="#536777" strokeDasharray="5 5" />
            {m.bins
              .filter((b) => b.n && b.predicted !== null && b.observed !== null)
              .map((b) => (
                <g key={b.bin}>
                  <path
                    d={`M${45 + b.predicted! * 305} ${260 - b.observed_interval[0]! * 220} V${260 - b.observed_interval[1]! * 220}`}
                    stroke="#206785"
                    strokeWidth="3"
                  />
                  <circle
                    cx={45 + b.predicted! * 305}
                    cy={260 - b.observed! * 220}
                    r="5"
                    fill="#206785"
                  />
                  <title>
                    {b.n} attempts · predicted {pct(b.predicted!)} / observed{" "}
                    {pct(b.observed!)}
                  </title>
                </g>
              ))}
            <text x="200" y="301" textAnchor="middle">
              Predicted make probability
            </text>
            <text transform="translate(12 150) rotate(-90)" textAnchor="middle">
              Observed FG%
            </text>
          </svg>
          <dl className="model-metrics">
            <div>
              <dt>Test Brier score · lower is better</dt>
              <dd>{m.brier.toFixed(4)}</dd>
            </div>
            <div>
              <dt>Constant training-mean baseline</dt>
              <dd>{m.baseline_brier.toFixed(4)}</dd>
            </div>
            <div>
              <dt>Calibration error · 10 fixed bins</dt>
              <dd>{pct(m.ece)}</dd>
            </div>
            <div>
              <dt>Brier difference · 95% game bootstrap</dt>
              <dd>
                {m.brier_difference_interval
                  .map((v) => v.toFixed(4))
                  .join(" to ")}
              </dd>
            </div>
          </dl>
        </section>
      </div>
      <details>
        <summary>
          Inspect calibration counts, model definition & provenance
        </summary>
        <div className="lineup-table-wrap">
          <table>
            <caption>
              Held-out calibration; empty prediction bins remain empty
            </caption>
            <thead>
              <tr>
                <th>Prediction bin</th>
                <th>Attempts</th>
                <th>Mean prediction</th>
                <th>Observed FG%</th>
                <th>95% game bootstrap interval</th>
              </tr>
            </thead>
            <tbody>
              {m.bins.map((b) => (
                <tr key={b.bin}>
                  <td>
                    {b.bin * 10}–{(b.bin + 1) * 10}%
                  </td>
                  <td>{b.n.toLocaleString()}</td>
                  <td>{b.predicted === null ? "—" : pct(b.predicted)}</td>
                  <td>{b.observed === null ? "—" : pct(b.observed)}</td>
                  <td>
                    {b.n
                      ? b.observed_interval.map((v) => pct(v!)).join(" to ")
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          The estimator uses only recorded location in fixed hexagons, with 20
          training-mean prior attempts per cell. Weighted isotonic calibration
          uses December games. Probabilities are clipped to 1–99%. Test data
          never fits either stage. No player, lineup, action label or shot value
          is a feature.
        </p>
        <p>
          The declared gate requires at least 100 games in each split, held-out
          calibration error at most 2.5 percentage points, and a negative upper
          95% bound for Brier difference versus the constant baseline. It does
          not establish transfer to another season.
        </p>
        <p>
          Test log loss {m.logloss.toFixed(4)}; constant baseline{" "}
          {m.baseline_logloss.toFixed(4)}. {m.bootstrap_resamples} test-game
          bootstrap resamples; seed {report.definition.bootstrap_seed}.
          Intervals describe variation across held-out games, not uncertainty
          for one shot.
        </p>
        <p>
          Source season: {report.provenance.source_attempts.toLocaleString()}{" "}
          attempts; {report.provenance.event_unmatched} event-unmatched and{" "}
          {report.provenance.outside} outside-court exclusions can overlap. Only
          2015–16 is modeled.
        </p>
        <p>
          Model <code>{report.provenance.model_fingerprint}</code> · atlas{" "}
          <code>{report.provenance.atlas_source_fingerprint}</code>.
        </p>
        <ul>
          {report.limitations.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
