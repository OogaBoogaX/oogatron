import { describe, expect, it } from "vitest";
import { retainRecent, type RecentEvent } from "../src/db/recent";
const TYPES = ["merge", "pr", "commit", "review", "issue", "comment"];
// Independent full-history oracle: filter first, then greedily consume each
// pair's sorted sequence one complete 60-second window at a time.
function displayed(
  rows: RecentEvent[],
  repos: string[],
  users: string[],
  types: string[],
  rolled: boolean,
) {
  const compare = (a: RecentEvent, b: RecentEvent) =>
    Date.parse(b.occurred_at) - Date.parse(a.occurred_at) ||
    TYPES.indexOf(a.type) - TYPES.indexOf(b.type) ||
    (a.event_key < b.event_key ? -1 : a.event_key > b.event_key ? 1 : 0);
  const selected = rows
    .filter(
      (r) =>
        repos.includes(r.repo) &&
        users.includes(r.login) &&
        types.includes(r.type),
    )
    .sort(compare);
  if (!rolled) return selected.slice(0, 10);
  const pairs = new Map<string, RecentEvent[]>();
  for (const r of selected) {
    const key = JSON.stringify([r.repo, r.login]);
    pairs.set(key, [...(pairs.get(key) || []), r]);
  }
  const windows = [];
  for (const pair of pairs.values()) {
    let i = 0;
    while (i < pair.length) {
      const first = pair[i++],
        members = [first];
      while (
        i < pair.length &&
        Date.parse(first.occurred_at) - Date.parse(pair[i].occurred_at) < 60000
      )
        members.push(pair[i++]);
      const type = TYPES.find((t) => members.some((r) => r.type === t))!;
      windows.push({ ...first, type, count: members.length });
    }
  }
  return windows.sort(compare).slice(0, 10);
}
function history(): RecentEvent[] {
  const rows: RecentEvent[] = [];
  for (const repo of ["a", "b"])
    for (const login of ["alice", "bob"]) {
      for (let i = 0; i < 220; i++)
        rows.push({
          repo,
          login,
          type: TYPES[i % 6],
          event_key: `${repo}/${login}/${String(i).padStart(4, "0")}`,
          occurred_at: new Date(
            Date.UTC(2026, 0, 1, 12, 1) - i * 29000,
          ).toISOString(),
        });
      // More than ten events at one time, crossing the minute boundary and
      // a member exactly sixty seconds older. Older windows must still fit.
      for (let i = 0; i < 25; i++)
        rows.push({
          repo,
          login,
          type: "commit",
          event_key: `${repo}/${login}/burst${i}`,
          occurred_at: "2026-01-01T12:00:59Z",
        });
    }
  return rows;
}

describe("recent snapshot selection", () => {
  it("preserves all 63 type subsets and every repo/user union, raw and rolled", () => {
    const full = history(),
      retained = retainRecent(full.slice().reverse());
    expect(retained.length).toBeLessThan(full.length);
    for (let mask = 1; mask < 64; mask++) {
      const types = TYPES.filter((_, i) => mask & (1 << i));
      for (const repos of [["a"], ["b"], ["a", "b"]])
        for (const users of [["alice"], ["bob"], ["alice", "bob"]]) {
          for (const rolled of [false, true])
            expect(displayed(retained, repos, users, types, rolled)).toEqual(
              displayed(full, repos, users, types, rolled),
            );
        }
    }
    expect(retainRecent(retained)).toEqual(retained);
    const top = displayed(full, ["a"], ["alice"], TYPES, true) as Array<
      RecentEvent & { count: number }
    >;
    expect(top).toHaveLength(10);
    expect(top[0].count).toBeGreaterThan(25);
    expect(top[0].occurred_at).toBe("2026-01-01T12:01:00.000Z");
    const boundary = [0, 59000, 60000, 118000].map((delta, i) => ({
      repo: "a",
      login: "alice",
      type: "commit",
      event_key: `a/${i}`,
      occurred_at: new Date(1000000 - delta).toISOString(),
    }));
    expect(
      displayed(retainRecent(boundary), ["a"], ["alice"], ["commit"], true).map(
        (r) => (r as any).count,
      ),
    ).toEqual([2, 2]);
  });
});
