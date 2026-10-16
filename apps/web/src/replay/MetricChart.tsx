import { memo, useMemo } from 'react';
import type { TrackingFrame } from '../types';
import { isBreak, type EventMarker, type Measurement } from './analysis';
import { frameAtTime } from './timeline';

export const MetricChart = memo(function MetricChart({ label, unit, values, frames, index, marker, onSeek }: {
  label: string; unit: string; values: Measurement[]; frames: TrackingFrame[]; index: number;
  marker: EventMarker; onSeek: (index: number) => void;
}) {
  const duration = frames[frames.length - 1].elapsed_s || 0.04;
  const geometry = useMemo(() => {
    const valid = values.flatMap((v) => v.value === null ? [] : [v.value]);
    const max = Math.max(1, ...valid) * 1.1;
    let pen = false;
    let path = '';
    for (const [i, value] of values.entries()) {
      if (value.value === null) { pen = false; continue; }
      if (i > 0 && isBreak(frames[i - 1], frames[i])) pen = false;
      const x = 34 + frames[i].elapsed_s / duration * 314;
      const y = 78 - value.value / max * 60;
      path += `${pen ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
      pen = true;
    }
    return { path, max };
  }, [values, frames, duration]);
  const value = values[index];
  const cursor = 34 + frames[index].elapsed_s / duration * 314;
  return <figure className="metric-chart" data-testid={`chart-${label.toLowerCase().replaceAll(' ', '-')}`}>
    <figcaption><span>{label} <small>{unit}</small></span><strong title={value.reason ?? 'Derived from recorded coordinates'}>
      {value.value === null ? 'Unavailable' : value.value.toFixed(1)}
    </strong></figcaption>
    <svg viewBox="0 0 360 102" role="img" aria-label={`${label} over observed elapsed time. Click to seek, or use the frame slider.`}
      onPointerDown={(event) => {
        const x = (event.clientX - event.currentTarget.getBoundingClientRect().left)
          / event.currentTarget.getBoundingClientRect().width * 360;
        onSeek(frameAtTime(frames, Math.max(0, Math.min(1, (x - 34) / 314)) * duration));
      }}>
      <path d="M 34 18 V 78 H 348 M 34 48 H 348" stroke="#d6dfe4" fill="none" strokeWidth="0.7" />
      {marker.ranges.map((range, i) => <rect key={i} x={34 + frames[range.start].elapsed_s / duration * 314}
        y="18" width={Math.max(1, (frames[range.end].elapsed_s - frames[range.start].elapsed_s) / duration * 314)}
        height="60" fill="#d9b56b" opacity="0.22" />)}
      <path data-testid="metric-path" d={geometry.path} stroke="#316d9c" strokeWidth="1.5" fill="none" />
      <line data-testid="chart-cursor" data-frame-index={index} x1={cursor} x2={cursor} y1="13" y2="80" stroke="#203647" strokeWidth="1" />
      {value.value !== null && <circle cx={cursor} cy={78 - value.value / geometry.max * 60} r="2.4" fill="#203647" />}
      <g className="chart-axis"><text x="28" y="21" textAnchor="end">{geometry.max.toFixed(0)}</text>
        <text x="28" y="80" textAnchor="end">0</text><text x="34" y="94">0 s</text>
        <text x="348" y="94" textAnchor="end">{duration.toFixed(1)} s</text></g>
    </svg>
    <p>{value.reason ?? 'Derived · Click the chart to seek.'}</p>
  </figure>;
});
