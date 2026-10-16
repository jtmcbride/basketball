import { memo, useMemo } from "react";
import { isBreak } from "../replay/analysis";
import { sampleAt, signedSeconds, type MovementSequence } from "./analysis";
const colors = ["#206483", "#b55136"];
export const ComparisonChart = memo(function ComparisonChart({
  sequences,
  metric,
  label,
  unit,
  start,
  end,
  time,
  onSeek,
}: {
  sequences: MovementSequence[];
  metric: "opponent" | "ball" | "heading";
  label: string;
  unit: string;
  start: number;
  end: number;
  time: number;
  onSeek: (ms: number) => void;
}) {
  const geometry = useMemo(() => {
    const lo = metric === "heading" ? -180 : 0;
    const values = sequences.flatMap((s) =>
      s.points
        .filter((p) => p.timeMs >= start && p.timeMs <= end)
        .flatMap((p) => (p[metric].value === null ? [] : [p[metric].value!])),
    );
    const hi = metric === "heading" ? 180 : Math.max(1, ...values) * 1.1;
    const x = (ms: number) => 40 + ((ms - start) / (end - start)) * 300,
      y = (value: number) => 90 - ((value - lo) / (hi - lo)) * 70;
    const paths = sequences.map((s) => {
      let path = "",
        pen = false,
        previous: number | null = null;
      for (const p of s.points) {
        const v = p[metric].value;
        if (p.timeMs < start || p.timeMs > end || v === null) {
          pen = false;
          previous = null;
          continue;
        }
        if (
          p.index > s.sequence.start_index &&
          isBreak(s.bundle.frames[p.index - 1], s.bundle.frames[p.index])
        )
          pen = false;
        if (
          metric === "heading" &&
          previous !== null &&
          Math.abs(v - previous) > 180
        )
          pen = false;
        path += `${pen ? "L" : "M"}${x(p.timeMs).toFixed(2)},${y(v).toFixed(2)}`;
        pen = true;
        previous = v;
      }
      return path;
    });
    return { lo, hi, x, y, paths };
  }, [sequences, metric, start, end]);
  return (
    <figure className="movement-chart">
      <figcaption>
        <strong>{label}</strong>
        <span>{unit}</span>
      </figcaption>
      <div className="movement-values">
        {sequences.map((s, i) => {
          const value = sampleAt(s, time)?.[metric];
          return (
            <span key={i} title={value?.reason ?? undefined}>
              <i style={{ background: colors[i] }} />
              {i ? "B" : "A"}{" "}
              {value?.value == null ? "Unavailable" : value.value.toFixed(1)}
            </span>
          );
        })}
      </div>
      <svg
        viewBox="0 0 360 125"
        role="img"
        aria-label={`${label}, both sequences over time relative to their annotations. Use the comparison time slider to seek.`}
        onPointerDown={(e) =>
          onSeek(
            start +
              Math.max(
                0,
                Math.min(
                  1,
                  (((e.clientX - e.currentTarget.getBoundingClientRect().left) /
                    e.currentTarget.getBoundingClientRect().width) *
                    360 -
                    40) /
                    300,
                ),
              ) *
                (end - start),
          )
        }
      >
        <path
          d="M40 20V90H340 M40 55H340"
          fill="none"
          stroke="#c5d2db"
          strokeWidth=".7"
        />
        {sequences.map((s, i) => {
          const low = Math.max(
              start,
              s.bundle.frames[s.annotation.start_index].source_timestamp_ms -
                s.anchorMs,
            ),
            high = Math.min(
              end,
              s.bundle.frames[s.annotation.end_index].source_timestamp_ms -
                s.anchorMs,
            );
          return high >= low ? (
            <rect
              key={i}
              x={geometry.x(low)}
              width={Math.max(1, geometry.x(high) - geometry.x(low))}
              y="20"
              height="70"
              fill={colors[i]}
              opacity=".09"
            />
          ) : null;
        })}
        <line
          x1={geometry.x(0)}
          x2={geometry.x(0)}
          y1="15"
          y2="92"
          stroke="#647c8b"
          strokeDasharray="2 2"
        />
        {geometry.paths.map((path, i) => (
          <path
            key={i}
            d={path}
            data-testid={`movement-path-${metric}-${i}`}
            stroke={colors[i]}
            strokeWidth="1.5"
            fill="none"
          />
        ))}
        <line
          data-testid="movement-chart-cursor"
          data-time-ms={Math.round(time)}
          x1={geometry.x(time)}
          x2={geometry.x(time)}
          y1="14"
          y2="92"
          stroke="#203647"
        />
        <g className="chart-axis">
          <text x="34" y="22" textAnchor="end">
            {geometry.hi.toFixed(0)}
          </text>
          <text x="34" y="92" textAnchor="end">
            {geometry.lo.toFixed(0)}
          </text>
          <text x="40" y="108">
            {signedSeconds(start)}
          </text>
          <text x={geometry.x(0)} y="108" textAnchor="middle">
            reference 0
          </text>
          <text x="340" y="108" textAnchor="end">
            {signedSeconds(end)}
          </text>
        </g>
      </svg>
    </figure>
  );
});
