import { RECENT_DEPTH } from "../config";

export interface RecentEvent {
  event_key: string;
  login: string;
  repo: string;
  type: string;
  occurred_at: string;
}

const TYPES = ["merge", "pr", "commit", "review", "issue", "comment"];
export const publicType = (type: string): string =>
  type.startsWith("comment_") ? "comment" : type;
const rank = (type: string): number => TYPES.indexOf(publicType(type));
export const compareRecent = (a: RecentEvent, b: RecentEvent): number =>
  Date.parse(b.occurred_at) - Date.parse(a.occurred_at) ||
  rank(a.type) - rank(b.type) ||
  (a.event_key < b.event_key ? -1 : a.event_key > b.event_key ? 1 : 0);

// Filters select unions of (repo, contributor) pairs and one of 63 nonempty
// type subsets. Preserve the complete first ten windows of each subset in
// each pair, plus ten individual events per public type. A prefix must keep
// every member of its final window: otherwise its label/count could change.
// No UTC buckets or age cutoff; each window starts at its newest event.
export function retainRecent<T extends RecentEvent>(input: T[]): T[] {
  const pairs = new Map<string, T[]>();
  const sorted = input.slice().sort(compareRecent);
  for (const row of sorted) {
    const key = JSON.stringify([row.repo, row.login]);
    let rows = pairs.get(key);
    if (!rows) {
      rows = [];
      pairs.set(key, rows);
    }
    rows.push(row);
  }
  const keep = new Set<T>();
  for (const rows of pairs.values()) {
    const raw = new Uint8Array(TYPES.length);
    const starts = new Float64Array(64).fill(-Infinity);
    const windows = new Uint8Array(64);
    for (const row of rows) {
      const type = rank(row.type),
        bit = 1 << type;
      if (raw[type] < RECENT_DEPTH) {
        raw[type]++;
        keep.add(row);
      }
      const stamp = Date.parse(row.occurred_at);
      for (let mask = 1; mask < 64; mask++) {
        if (!(mask & bit) || windows[mask] > RECENT_DEPTH) continue;
        if (!windows[mask] || starts[mask] - stamp >= 60000) {
          starts[mask] = stamp;
          windows[mask]++;
        }
        if (windows[mask] <= RECENT_DEPTH) keep.add(row);
      }
    }
  }
  return sorted.filter((row) => keep.has(row));
}
