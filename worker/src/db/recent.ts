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

// How many of each (repo, contributor, raw type)'s newest counted events
// /v2/stats reads for the feed, instead of every event in history.
export const RECENT_FETCH = 48;

// retainRecent never keeps a row that comes at or after the start of the
// (RECENT_DEPTH + 1)th window of its own raw type in its own pair:
// - its rank's ten raw rows all come before it (a window holds at least one);
// - a mask's windows start greedily from the newest row, and a sequence that
//   holds more rows starts each window at the same time or later, so every
//   mask containing the type has opened its last window by then, and the
//   rows after that are never kept for it.
// Dropping such rows therefore changes nothing retainRecent keeps, nor the
// order of what it keeps. Given each group's newest rows (all rows at or after
// its RECENT_FETCH-th newest timestamp, ties included), this names the groups
// whose fetch may have stopped short of that point and must be read whole: a
// full group of RECENT_FETCH or more that has not opened its next window, or
// any group with a timestamp outside GitHub's second-precision UTC format,
// whose text order (what the query cuts by) might not be its time order.
const CANONICAL = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

export function shortGroups<T extends RecentEvent & { contributor_id: number }>(
  rows: T[],
): Array<{ repo: string; contributor_id: number; type: string }> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.repo, row.contributor_id, row.type]);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(row);
  }
  const short: Array<{ repo: string; contributor_id: number; type: string }> =
    [];
  for (const group of groups.values()) {
    const { repo, contributor_id, type } = group[0];
    if (group.some((r) => !CANONICAL.test(r.occurred_at))) {
      short.push({ repo, contributor_id, type });
      continue;
    }
    if (group.length < RECENT_FETCH) continue;
    const stamps = group
      .map((r) => Date.parse(r.occurred_at))
      .sort((a, b) => b - a);
    let windows = 0,
      start = Infinity;
    for (const stamp of stamps) {
      if (start - stamp >= 60000) {
        start = stamp;
        if (++windows > RECENT_DEPTH) break;
      }
    }
    if (windows <= RECENT_DEPTH) short.push({ repo, contributor_id, type });
  }
  return short;
}
