export interface AssistCell {
  cell: string;
  cx: number;
  cy: number;
  makes: number;
  assisted: number;
  reliable: boolean;
  share: number | null;
  per_100: number;
  league_makes: number;
  league_share: number | null;
}
export interface ValueTotal {
  shot_value: number;
  makes: number;
  assisted: number;
}
export interface TeamPlayer {
  id: string;
  name: string;
  makes: number;
  assisted: number;
  assists: number;
}
export interface Partner {
  id: string;
  name: string | null;
  makes: number;
}
export type Role = "shooter" | "passer";
export interface AssistSummary {
  schema_version: string;
  filters: {
    season: string;
    team_id: string;
    player_id: string | null;
    role: Role;
  };
  cells: AssistCell[];
  totals: ValueTotal[];
  league: ValueTotal[];
  players: TeamPlayer[];
  network: {
    players: { id: string; name: string }[];
    links: { passer_id: string; shooter_id: string; makes: number }[];
    outside_core: number;
  };
  partners: { passers: Partner[]; targets: Partner[] } | null;
  unverified_team_makes: number;
  fingerprint: string;
}
export interface AssistOptions {
  schema_version: string;
  definition: Record<string, string | string[]>;
  fingerprint: string;
  coverage: Record<
    string,
    {
      atlas_makes: number;
      event_unmatched: number;
      assisted: number;
      unassisted: number;
      unverified: number;
    }
  >;
  teams: { season: string; id: string; name: string; makes: number }[];
}

const VERSION = "basketball-assists-v1";

export function parseOptions(o: AssistOptions): AssistOptions {
  if (o.schema_version !== VERSION) {
    throw new Error(
      "The assist index uses an unsupported format. Rebuild with make assists.",
    );
  }
  return o;
}

export function parseSummary(
  s: AssistSummary,
  expected: AssistSummary["filters"],
): AssistSummary {
  if (s.schema_version !== VERSION) {
    throw new Error("Assist summary uses an unsupported format.");
  }
  const f = s.filters;
  if (
    f.season !== expected.season ||
    f.team_id !== expected.team_id ||
    f.player_id !== expected.player_id ||
    f.role !== expected.role
  ) {
    throw new Error(
      "The returned assist summary does not match the selection.",
    );
  }
  // Cells and totals describe the same cohort; outside-court makes only add to totals.
  const inCells = s.cells.reduce((n, c) => n + c.makes, 0);
  const total = s.totals.reduce((n, t) => n + t.makes, 0);
  if (inCells > total || s.cells.some((c) => c.assisted > c.makes)) {
    throw new Error("Assist cells do not reconcile with cohort totals.");
  }
  return s;
}

export const share = (t: { makes: number; assisted: number } | undefined) =>
  t && t.makes ? t.assisted / t.makes : null;

export function combine(totals: ValueTotal[]) {
  return totals.reduce(
    (a, t) => ({ makes: a.makes + t.makes, assisted: a.assisted + t.assisted }),
    { makes: 0, assisted: 0 },
  );
}

export const byValue = (totals: ValueTotal[], value: number) =>
  totals.find((t) => t.shot_value === value);

export function linkMatrix(network: AssistSummary["network"]) {
  const counts = new Map(
    network.links.map((l) => [`${l.passer_id}>${l.shooter_id}`, l.makes]),
  );
  const at = (passer: string, shooter: string) =>
    counts.get(`${passer}>${shooter}`) ?? 0;
  const max = Math.max(1, ...network.links.map((l) => l.makes));
  return { at, max };
}

// Single-hue sequential ramp shared with the shot atlas.
export function ramp(t: number | null): string {
  if (t === null) return "#9ca8ae";
  const start = [224, 234, 236];
  const end = [32, 100, 131];
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${start.map((v, i) => Math.round(v + (end[i] - v) * k)).join(",")})`;
}

export const pct = (v: number | null, digits = 0) =>
  v === null ? "—" : `${(v * 100).toFixed(digits)}%`;
