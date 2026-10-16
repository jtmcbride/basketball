import { memo, useId } from "react";
import type { Game, ReplayBundle } from "../types";
import { playerMetrics, trailPoints, type Snapshot } from "./analysis";

export const courtMarkings = (
  <g fill="none" stroke="#71644f" strokeWidth="0.14">
    <rect x="0" y="0" width="94" height="50" />
    <path d="M 47 0 V 50" />
    <circle cx="47" cy="25" r="6" />
    {[false, true].map((right) => (
      <g
        key={String(right)}
        transform={right ? "translate(94 50) rotate(180)" : undefined}
      >
        <rect width="19" height="16" y="17" fill="#203647" fillOpacity="0.06" />
        <path d="M 0 17 H 19 V 33 H 0 M 0 19 H 19 M 0 31 H 19" />
        <circle cx="19" cy="25" r="6" />
        <path d="M 0 3 H 14.2 A 23.75 23.75 0 0 1 14.2 47 H 0" />
        <path d="M 5.25 21 A 4 4 0 0 1 5.25 29 M 4 22 V 28" />
        <circle
          cx="5.25"
          cy="25"
          r="0.75"
          stroke="#a35d32"
          strokeWidth="0.23"
        />
      </g>
    ))}
  </g>
);

export const ReplayCourt = memo(function ReplayCourt({
  bundle,
  game,
  snapshots,
  index,
  selectedPlayer,
  onSelect,
  trails,
  connector,
  spread,
  focus = false,
  trailStart = 0,
  interactive = true,
}: {
  bundle: ReplayBundle;
  game: Game;
  snapshots: Snapshot[];
  index: number;
  selectedPlayer: string;
  onSelect: (id: string) => void;
  trails: boolean;
  connector: boolean;
  spread: boolean;
  focus?: boolean;
  trailStart?: number;
  interactive?: boolean;
}) {
  const woodId = useId();
  const snapshot = snapshots[index];
  const frame = bundle.frames[index];
  const roster = new Map(bundle.players.map((p) => [p.player_id, p]));
  const color = (team: string | null) =>
    team === game.home_team_id ? "#316d9c" : "#3a705f";
  const selected = snapshot.entities.get(selectedPlayer);
  const nearest = snapshot.entities.get(
    playerMetrics(snapshot, selectedPlayer).defenderId ?? "",
  );
  const entities = [...snapshot.entities.values()];
  return (
    <svg
      viewBox="-3 -5 100 60"
      className="replay-court"
      aria-label="Full court tracking replay"
      role="group"
    >
      <defs>
        <pattern
          id={woodId}
          width="4.7"
          height="50"
          patternUnits="userSpaceOnUse"
        >
          <rect width="4.7" height="50" fill="#cfb58d" />
          <path
            d="M 0 0 V 50 M 2.35 0 V 50"
            stroke="#c4a67b"
            strokeWidth="0.06"
          />
        </pattern>
      </defs>
      <rect width="94" height="50" fill={`url(#${woodId})`} />
      {courtMarkings}
      <g className="court-reference-labels">
        <text x="5.25" y="-2" textAnchor="middle">
          Left rim
        </text>
        <text x="88.75" y="-2" textAnchor="middle">
          Right rim
        </text>
        <text x="47" y="53.5" textAnchor="middle">
          Source court · 94 × 50 ft · Direction unavailable
        </text>
      </g>
      {spread &&
        snapshot.teams.map((team) =>
          team.center && team.rms !== null ? (
            <g key={team.teamId}>
              <circle
                cx={team.center.x}
                cy={team.center.y}
                r={team.rms}
                stroke={color(team.teamId)}
                fill={color(team.teamId)}
                fillOpacity="0.08"
                strokeOpacity="0.65"
                strokeWidth="0.25"
                strokeDasharray={team.count === 5 ? undefined : "1 1"}
              />
              <path
                d={`M ${team.center.x - 0.6} ${team.center.y} h 1.2 M ${team.center.x} ${team.center.y - 0.6} v 1.2`}
                stroke={color(team.teamId)}
                strokeWidth="0.25"
              />
            </g>
          ) : null,
        )}
      {trails &&
        entities.map((entity) => {
          const points = trailPoints(
            bundle.frames,
            snapshots,
            index,
            entity.entity_id,
            trailStart,
          );
          return (
            <g
              key={entity.entity_id}
              stroke={
                entity.kind === "ball" ? "#b85e24" : color(entity.team_id)
              }
              strokeWidth={
                entity.entity_id === selectedPlayer ? "0.42" : "0.22"
              }
            >
              {points.slice(1).map((point, i) => (
                <line
                  key={i}
                  x1={points[i].x_ft}
                  y1={points[i].y_ft}
                  x2={point.x_ft}
                  y2={point.y_ft}
                  opacity={
                    ((i + 1) / points.length) *
                    (entity.entity_id === selectedPlayer
                      ? 0.9
                      : focus
                        ? 0.1
                        : 0.45)
                  }
                />
              ))}
            </g>
          );
        })}
      {connector && selected && nearest && (
        <line
          data-testid="defender-connector"
          x1={selected.x_ft}
          y1={selected.y_ft}
          x2={nearest.x_ft}
          y2={nearest.y_ft}
          stroke="#203647"
          strokeWidth="0.3"
          strokeDasharray="0.8 0.55"
        />
      )}
      {entities
        .filter((e) => e.kind === "player")
        .map((entity) => {
          const player = roster.get(entity.entity_id);
          return (
            <g
              key={entity.entity_id}
              data-testid="tracked-player"
              role={interactive ? "button" : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={`${interactive ? "Select " : ""}${player?.name ?? entity.entity_id}`}
              aria-pressed={
                interactive ? entity.entity_id === selectedPlayer : undefined
              }
              opacity={focus && entity.entity_id !== selectedPlayer ? 0.3 : 1}
              className="player-marker"
              onClick={
                interactive ? () => onSelect(entity.entity_id) : undefined
              }
              onKeyDown={(event) => {
                if (
                  interactive &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(entity.entity_id);
                }
              }}
            >
              {entity.entity_id === selectedPlayer && (
                <circle
                  cx={entity.x_ft}
                  cy={entity.y_ft}
                  r="1.72"
                  fill="none"
                  stroke="#203647"
                  strokeWidth="0.28"
                />
              )}
              <circle
                cx={entity.x_ft}
                cy={entity.y_ft}
                r="1.25"
                fill={color(entity.team_id)}
                stroke="#fff"
                strokeWidth="0.22"
              />
              <text
                x={entity.x_ft}
                y={entity.y_ft + 0.38}
                textAnchor="middle"
                className="jersey-number"
              >
                {player?.jersey || "·"}
              </text>
              <circle
                cx={entity.x_ft}
                cy={entity.y_ft}
                r="2"
                fill="transparent"
              />
              <title>
                {player?.name ?? entity.entity_id} · {entity.x_ft.toFixed(1)},{" "}
                {entity.y_ft.toFixed(1)} ft
              </title>
            </g>
          );
        })}
      {entities
        .filter((e) => e.kind === "ball")
        .map((ball) => (
          <g key={ball.entity_id} data-testid="tracked-ball">
            <circle
              cx={ball.x_ft}
              cy={ball.y_ft}
              r="0.7"
              fill="#cf702d"
              stroke="#fff"
              strokeWidth="0.2"
            />
            <path
              d={`M ${ball.x_ft - 0.5} ${ball.y_ft} h 1 M ${ball.x_ft} ${ball.y_ft - 0.5} v 1`}
              stroke="#7c3a16"
              strokeWidth="0.12"
            />
            <title>
              Ball ·{" "}
              {ball.z_ft === null
                ? "Height unavailable"
                : `${ball.z_ft.toFixed(1)} ft high`}
            </title>
          </g>
        ))}
      {frame.timestamp_conflict && (
        <g>
          <rect
            x="10"
            y="19"
            width="74"
            height="12"
            rx="1"
            fill="#fafcfd"
            fillOpacity="0.95"
          />
          <text x="47" y="24" textAnchor="middle" className="conflict-title">
            Conflicting timestamp observations
          </text>
          <text x="47" y="28" textAnchor="middle" className="conflict-caption">
            Positions are unavailable for this frame.
          </text>
        </g>
      )}
    </svg>
  );
});
