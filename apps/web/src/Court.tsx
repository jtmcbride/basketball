import { useId } from "react";
import type { Shot } from "./types";

const courtLines = (
  <g className="court-lines" fill="none" strokeWidth="0.13">
    <rect x="0.2" y="0.2" width="49.6" height="46.6" />
    <path d="M 17 0 V 19 H 33 V 0 M 19 0 V 19 M 31 0 V 19" />
    <circle cx="25" cy="19" r="6" />
    <path d="M 3 0 V 14.2 A 23.75 23.75 0 0 0 47 14.2 V 0" />
    <path d="M 21 5.25 A 4 4 0 0 0 29 5.25 M 22 4 H 28" />
    <circle cx="25" cy="5.25" r="0.75" />
    <path d="M 19 47 A 6 6 0 0 1 31 47" />
  </g>
);

export function Court({
  shots,
  selected,
  onSelect,
}: {
  shots: Shot[];
  selected: string | null;
  onSelect: (shotId: string) => void;
}) {
  const woodId = useId();
  const plotted = shots.filter(
    (shot) =>
      shot.forward_ft + 5.25 <= 47 &&
      shot.forward_ft + 5.25 >= 0 &&
      Math.abs(shot.lateral_ft) <= 25,
  );
  return (
    <svg
      viewBox="-1 -1 52 49"
      className="court"
      role="img"
      aria-label={`Basket-relative shot chart with ${plotted.length} plotted attempts from ${shots.length} attempts. Use the attempt selector below to inspect a shot.`}
    >
      <defs>
        <pattern
          id={woodId}
          width="5"
          height="47"
          patternUnits="userSpaceOnUse"
        >
          <rect width="5" height="47" fill="#cfb58d" />
          <path
            d="M 0 0 V 47 M 2.5 0 V 47"
            stroke="#c4a67b"
            strokeWidth="0.06"
          />
        </pattern>
      </defs>
      <rect width="50" height="47" fill={`url(#${woodId})`} />
      <rect x="17" width="16" height="19" fill="#203647" opacity="0.08" />
      {courtLines}
      {plotted.map((shot) => (
        <g
          key={shot.shot_id}
          className={`shot ${shot.made ? "made" : "missed"} ${shot.shot_id === selected ? "selected" : ""}`}
          onClick={() => onSelect(shot.shot_id)}
        >
          <circle
            cx={25 + shot.lateral_ft}
            cy={5.25 + shot.forward_ft}
            r="0.48"
          />
          {!shot.made && (
            <path
              d={`M ${24.7 + shot.lateral_ft} ${4.95 + shot.forward_ft} l .6 .6 m 0 -.6 l -.6 .6`}
            />
          )}
          <circle
            className="shot-hit"
            cx={25 + shot.lateral_ft}
            cy={5.25 + shot.forward_ft}
            r="1"
          />
          <title>
            {shot.player_name} · {shot.made ? "Made" : "Missed"} ·{" "}
            {shot.action_type}
          </title>
        </g>
      ))}
    </svg>
  );
}
