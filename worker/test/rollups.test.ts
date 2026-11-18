import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RECONCILE_FLAGS,
  reconcileRollups,
  recomputeRollups,
} from "../src/db/rollups";
import { handleStatsV3 } from "../src/api/stats";
import { publicType, retainRecent } from "../src/db/recent";
import { isoWeek } from "../src/util/isoweek";

afterEach(() => vi.restoreAllMocks());

async function measuredRecompute(): Promise<number[]> {
  const batch = vi.spyOn(env.DB, "batch");
  try {
    await recomputeRollups(env.DB);
    const results = await batch.mock.results[0].value;
    // The four rebuild statements; the fifth only empties counted_dirty.
    return results.slice(0, 4).map((result: D1Result) => result.meta.changes);
  } finally {
    batch.mockRestore();
  }
}

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO contributors (id, login, is_bot) VALUES (1, 'alice', 0), (2, 'robo[bot]', 1)",
    ),
    env.DB.prepare(
      `INSERT INTO activity_events (contributor_id, type, external_id, occurred_at) VALUES
       (1, 'commit', 'e1', '2026-01-05T10:00:00Z'),
       (1, 'commit', 'e2', '2026-01-05T15:00:00Z'),
       (1, 'pr',     'e3', '2026-01-06T10:00:00Z'),
       (2, 'commit', 'e4', '2026-01-05T10:00:00Z')`,
    ),
  ]);
}

describe("recomputeRollups", () => {
  it("writes only changed counts, preserving numeric equality and raw payloads", async () => {
    await seed();
    await recomputeRollups(env.DB);
    const raw = () =>
      env.DB.prepare("SELECT * FROM activity_events ORDER BY id").all();
    const before = (await raw()).results;

    // INTEGER affinity preserves an equivalent textual/real count as the
    // same value; a no-op rebuild must not rewrite it or unrelated buckets.
    await env.DB.prepare(
      "UPDATE daily_rollups SET count = '2.0' WHERE count = 2",
    ).run();
    expect(await measuredRecompute()).toEqual([0, 0, 0, 0]);
    expect((await raw()).results).toEqual(before);

    await env.DB.prepare(
      "UPDATE activity_events SET payload = '{\"draft\":true}' WHERE external_id = 'e3'",
    ).run();
    const edited = (await raw()).results;
    expect(await measuredRecompute()).toEqual([0, 0, 0, 0]);
    expect((await raw()).results).toEqual(edited);

    // A new event's bucket moves with the event itself (migration 0012's
    // triggers), so the full rebuild then finds nothing left to write.
    await env.DB.prepare(
      "INSERT INTO activity_events (contributor_id, type, external_id, occurred_at) VALUES (1, 'commit', 'extra', '2026-01-05T23:00:00Z')",
    ).run();
    expect(
      await env.DB.prepare(
        "SELECT count FROM daily_rollups WHERE day = '2026-01-05' AND contributor_id = 1 AND type = 'commit'",
      ).first("count"),
    ).toBe(3);
    expect(await measuredRecompute()).toEqual([0, 0, 0, 0]);
  });

  it("moves corrected buckets and removes vanished keys as events change", async () => {
    await seed();
    await recomputeRollups(env.DB);
    await env.DB.prepare(
      "UPDATE activity_events SET contributor_id = 2, occurred_at = '2024-12-31T23:59:59Z' WHERE external_id = 'e3'",
    ).run();
    // The triggers moved the bucket with the event; nothing is left to fix.
    expect(await measuredRecompute()).toEqual([0, 0, 0, 0]);
    expect(
      (
        await env.DB.prepare(
          "SELECT day, contributor_id, count FROM daily_rollups WHERE type = 'pr'",
        ).all()
      ).results,
    ).toEqual([{ day: "2024-12-31", contributor_id: 2, count: 1 }]);
    await env.DB.prepare(
      "DELETE FROM activity_events WHERE external_id = 'e3'",
    ).run();
    expect(
      (await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM daily_rollups WHERE type = 'pr'",
      ).first<{ n: number }>())!.n,
    ).toBe(0);
    expect(await measuredRecompute()).toEqual([0, 0, 0, 0]);
    await env.DB.prepare("DELETE FROM activity_events").run();
    expect(await measuredRecompute()).toEqual([0, 0, 0, 0]);
    expect(
      (await env.DB.prepare("SELECT * FROM daily_rollups").all()).results,
    ).toEqual([]);
    expect(await measuredRecompute()).toEqual([0, 0, 0, 0]);
  });

  it("rolls back flags and summaries together if final deletion fails, then retries", async () => {
    await seed();
    await recomputeRollups(env.DB);
    await env.DB.prepare(
      `INSERT INTO activity_events (contributor_id, type, external_id, occurred_at, payload)
       VALUES (1, 'merge', 'new-merge', '2026-01-07T00:00:00Z', '{"mergeCommit":"e1"}')`,
    ).run();
    await env.DB.prepare(
      "DELETE FROM activity_events WHERE external_id = 'e3'",
    ).run();
    const snapshot = async () => ({
      events: (
        await env.DB.prepare("SELECT * FROM activity_events ORDER BY id").all()
      ).results,
      rollups: (
        await env.DB.prepare(
          "SELECT * FROM daily_rollups ORDER BY repo, day, contributor_id, type",
        ).all()
      ).results,
    });
    const before = await snapshot();
    // Fail the batch's last statement, after the merge has unflagged e1 and
    // the triggers have moved its bucket.
    await env.DB.prepare(
      `CREATE TRIGGER fail_dirty_delete BEFORE DELETE ON counted_dirty
       BEGIN SELECT RAISE(ABORT, 'injected summary failure'); END`,
    ).run();
    await expect(recomputeRollups(env.DB)).rejects.toThrow(
      "injected summary failure",
    );
    expect(await snapshot()).toEqual(before);
    await expect(reconcileRollups(env.DB)).rejects.toThrow(
      "injected summary failure",
    );
    expect(await snapshot()).toEqual(before);
    await env.DB.prepare("DROP TRIGGER fail_dirty_delete").run();
    // e1's flag, and (D1 counts trigger writes too) its bucket moving.
    expect(await measuredRecompute()).toEqual([2, 0, 0, 0]);
    expect(await measuredRecompute()).toEqual([0, 0, 0, 0]);
  });

  it("prunes sync_runs by index", async () => {
    const prune = await env.DB.prepare(
      "EXPLAIN QUERY PLAN DELETE FROM sync_runs WHERE started_at < ? AND status != 'running'",
    )
      .bind("2026-01-01T00:00:00Z")
      .all<{ detail: string }>();
    expect(prune.results.map((r) => r.detail).join("\n")).toMatch(
      /USING INDEX idx_sync_runs_started/,
    );
  });

  it("re-flags merge commits across rebuilds", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO contributors (id, login, is_bot) VALUES (1, 'alice', 0), (2, 'erik', 0)",
      ),
      env.DB.prepare(
        `INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at) VALUES
         ('entropylab', 1, 'commit', 'oid-1', '2026-01-10T10:00:00Z')`,
      ),
    ]);
    const flag = () =>
      env.DB.prepare(
        "SELECT counted FROM activity_events WHERE external_id = 'oid-1'",
      ).first<{ counted: number }>();

    await recomputeRollups(env.DB);
    expect((await flag())!.counted).toBe(1);

    // The merge lands in a later run than its commit.
    await env.DB.prepare(
      `INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at, payload) VALUES
       ('entropylab', 2, 'merge', 'merge:pr1', '2026-01-10T10:01:00Z', '{"prNumber":1,"mergeCommit":"oid-1"}')`,
    ).run();
    await recomputeRollups(env.DB);
    expect((await flag())!.counted).toBe(0);

    // The merge's oid is corrected away: the commit counts again.
    await env.DB.prepare(
      `UPDATE activity_events SET payload = '{"prNumber":1,"mergeCommit":"oid-9"}' WHERE external_id = 'merge:pr1'`,
    ).run();
    await recomputeRollups(env.DB);
    expect((await flag())!.counted).toBe(1);
  });

  it("aggregates per day/contributor/type and is safe to re-run", async () => {
    await seed();
    await recomputeRollups(env.DB);

    const rows = await env.DB.prepare(
      "SELECT day, contributor_id, type, count FROM daily_rollups ORDER BY day, contributor_id, type",
    ).all();
    expect(rows.results).toEqual([
      { day: "2026-01-05", contributor_id: 1, type: "commit", count: 2 },
      { day: "2026-01-05", contributor_id: 2, type: "commit", count: 1 },
      { day: "2026-01-06", contributor_id: 1, type: "pr", count: 1 },
    ]);

    // Add one event, full recompute stays correct.
    await env.DB.prepare(
      "INSERT INTO activity_events (contributor_id, type, external_id, occurred_at) VALUES (1, 'commit', 'e5', '2026-01-05T23:00:00Z')",
    ).run();
    await recomputeRollups(env.DB);
    const after = await env.DB.prepare(
      "SELECT count FROM daily_rollups WHERE day = '2026-01-05' AND contributor_id = 1 AND type = 'commit'",
    ).first<{ count: number }>();
    expect(after!.count).toBe(3);
  });

  it("excludes a merge's own commit in the same repo, keeps it elsewhere, tolerates null oids", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO contributors (id, login, is_bot) VALUES (1, 'alice', 0), (2, 'erik', 0)",
      ),
      env.DB.prepare(
        `INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at, payload) VALUES
         ('entropylab', 1, 'commit', 'oid-1', '2026-01-10T10:00:00Z', NULL),
         ('entropylab', 2, 'merge', 'merge:pr1', '2026-01-10T10:01:00Z', '{"prNumber":1,"mergeCommit":"oid-1"}'),
         ('bedrock',    1, 'commit', 'oid-1', '2026-01-10T10:00:00Z', NULL),
         ('entropylab', 2, 'merge', 'merge:pr2', '2026-01-11T10:00:00Z', '{"prNumber":2,"mergeCommit":null}'),
         ('entropylab', 1, 'commit', 'oid-2', '2026-01-11T09:00:00Z', NULL)`,
      ),
    ]);
    await recomputeRollups(env.DB);
    const rows = await env.DB.prepare(
      "SELECT repo, type, SUM(count) AS n FROM daily_rollups GROUP BY repo, type ORDER BY repo, type",
    ).all<{ repo: string; type: string; n: number }>();
    expect(rows.results).toEqual([
      // bedrock's identical oid is untouched: the exclusion is repo-scoped.
      { repo: "bedrock", type: "commit", n: 1 },
      // entropylab keeps oid-2 only; oid-1 folded into merge:pr1's credit.
      { repo: "entropylab", type: "commit", n: 1 },
      { repo: "entropylab", type: "merge", n: 2 },
    ]);
  });
});

describe("patch-identity dedupe", () => {
  const commit = (
    oid: string,
    committed: string,
    authored: string,
    headline: string,
  ) =>
    env.DB.prepare(
      `INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at, payload)
       VALUES ('entropylab', 1, 'commit', ?, ?, ?)`,
    ).bind(
      oid,
      committed,
      JSON.stringify({
        headline,
        additions: 1,
        deletions: 0,
        authoredAt: authored,
      }),
    );
  const counted = async () =>
    (
      await env.DB.prepare(
        "SELECT external_id FROM activity_events WHERE type = 'commit' AND counted = 1 ORDER BY external_id",
      ).all<{ external_id: string }>()
    ).results.map((r) => r.external_id);

  it("counts a rebased or amended patch once, keeping the newest copy", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO contributors (id, login, is_bot) VALUES (1, 'alice', 0), (2, 'erik', 0)",
      ),
      // PR branch original, then its rebased copy on the default branch.
      commit(
        "branch-1",
        "2026-02-01T10:00:00Z",
        "2026-02-01T10:00:00Z",
        "fix: a",
      ),
      commit(
        "rebased-1",
        "2026-02-03T09:00:00Z",
        "2026-02-01T10:00:00Z",
        "fix: a",
      ),
      // Same author date, different message: a different patch.
      commit(
        "other-1",
        "2026-02-01T10:00:00Z",
        "2026-02-01T10:00:00Z",
        "fix: b",
      ),
    ]);
    await recomputeRollups(env.DB);
    expect(await counted()).toEqual(["other-1", "rebased-1"]);
  });

  it("squash: branch commits count, the squash commit folds into the merge", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO contributors (id, login, is_bot) VALUES (1, 'alice', 0), (2, 'erik', 0)",
      ),
      commit(
        "branch-1",
        "2026-02-01T10:00:00Z",
        "2026-02-01T10:00:00Z",
        "feat: x",
      ),
      commit(
        "branch-2",
        "2026-02-01T11:00:00Z",
        "2026-02-01T11:00:00Z",
        "fix: y",
      ),
      commit(
        "squash-1",
        "2026-02-02T09:00:00Z",
        "2026-02-02T09:00:00Z",
        "feat: x (#9)",
      ),
      env.DB.prepare(
        `INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at, payload)
         VALUES ('entropylab', 2, 'merge', 'merge:pr9', '2026-02-02T09:00:00Z', '{"prNumber":9,"mergeCommit":"squash-1"}')`,
      ),
    ]);
    await recomputeRollups(env.DB);
    expect(await counted()).toEqual(["branch-1", "branch-2"]);
  });
});

describe("incremental rollups", () => {
  const plan = async (sql: string) =>
    (
      await env.DB.prepare("EXPLAIN QUERY PLAN " + sql).all<{
        detail: string;
      }>()
    ).results.map((r) => r.detail);

  it("reconciles and serves the feed and last activity by seeks, never a scan of every event", async () => {
    const reconcile = await plan(RECONCILE_FLAGS);
    expect(reconcile.join("\n")).not.toMatch(/SCAN (e|activity_events)\b/);
    expect(reconcile.join("\n")).toMatch(/idx_events_commit_identity/);
    expect(reconcile.join("\n")).toMatch(
      /idx_events_merge_commit \(repo=\? AND <expr>=\?\)/,
    );

    // Every statement /v2/stats sends that reads events: the recent feed and
    // the two last-activity reads.
    const prepare = vi.spyOn(env.DB, "prepare");
    await handleStatsV3(env, new Request("https://oogatron.test/v2/stats"));
    const reads = prepare.mock.calls
      .map((c) => c[0] as string)
      .filter((sql) => sql.includes("activity_events"));
    expect(reads).toHaveLength(3);
    for (const sql of reads) {
      const detail = (await plan(sql)).join("\n");
      expect(detail).not.toMatch(/SCAN (e|x)\b/);
      expect(detail).toMatch(/SEARCH e USING (COVERING )?INDEX/);
    }
    expect(reads.map((sql) => sql).join()).toMatch(/WITH k AS MATERIALIZED/);
  });

  it("keeps flags and buckets equal to a full rebuild through any sequence of changes", async () => {
    await env.DB.prepare(
      "INSERT INTO contributors (id, login, is_bot) VALUES (1, 'alice', 0), (2, 'bob', 0), (3, 'carol', 0)",
    ).run();
    // A small space so identities, rebased copies and merge oids collide often.
    let seed = 0x5eed;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pick = <T>(xs: T[]): T => xs[rand(xs.length)];
    const repos = ["entropylab", "bedrock"];
    const days = ["2026-03-01", "2026-03-02", "2026-03-03"];
    const at = () =>
      `${pick(days)}T${String(10 + rand(3)).padStart(2, "0")}:00:00Z`;
    const commitPayload = () =>
      JSON.stringify(
        rand(5) === 0
          ? { headline: "x" }
          : {
              authoredAt: pick([
                "2026-02-01T00:00:00Z",
                "2026-02-02T00:00:00Z",
              ]),
              headline: pick(["fix: a", "fix: b", null]),
            },
      );
    const live: Array<{ repo: string; id: string; type: string }> = [];
    let next = 0;
    const snapshot = async () => ({
      flags: (
        await env.DB.prepare(
          "SELECT repo, external_id, counted FROM activity_events ORDER BY repo, external_id",
        ).all()
      ).results,
      rollups: (
        await env.DB.prepare(
          "SELECT * FROM daily_rollups ORDER BY repo, day, contributor_id, type",
        ).all()
      ).results,
    });

    for (let step = 0; step < 300; step++) {
      const op = rand(10);
      const repo = pick(repos);
      const commits = live.filter((e) => e.type === "commit");
      if (op < 4 || live.length < 3) {
        const id = `c${next++}`;
        live.push({ repo, id, type: "commit" });
        await env.DB.prepare(
          "INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at, payload) VALUES (?, ?, 'commit', ?, ?, ?)",
        )
          .bind(repo, 1 + rand(2), id, at(), commitPayload())
          .run();
      } else if (op === 4) {
        const id = `m${next++}`;
        const named = commits.length && rand(4) ? pick(commits) : null;
        live.push({ repo: named ? named.repo : repo, id, type: "merge" });
        await env.DB.prepare(
          "INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at, payload) VALUES (?, 3, 'merge', ?, ?, ?)",
        )
          .bind(
            named ? named.repo : repo,
            id,
            at(),
            JSON.stringify({ mergeCommit: named ? named.id : null }),
          )
          .run();
      } else if (op === 5) {
        const id = `p${next++}`;
        live.push({ repo, id, type: "pr" });
        await env.DB.prepare(
          "INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at, payload) VALUES (?, ?, 'pr', ?, ?, '{}')",
        )
          .bind(repo, 1 + rand(3), id, at())
          .run();
      } else {
        const e = pick(live);
        const where = " WHERE repo = ? AND external_id = ?";
        if (op === 6) {
          await env.DB.prepare(
            "UPDATE activity_events SET occurred_at = ?" + where,
          )
            .bind(at(), e.repo, e.id)
            .run();
        } else if (op === 7) {
          await env.DB.prepare(
            "UPDATE activity_events SET contributor_id = ?" + where,
          )
            .bind(1 + rand(3), e.repo, e.id)
            .run();
        } else if (op === 8) {
          const payload =
            e.type === "commit"
              ? commitPayload()
              : e.type === "merge"
                ? JSON.stringify({
                    mergeCommit: commits.length ? pick(commits).id : null,
                  })
                : '{"draft":true}';
          await env.DB.prepare("UPDATE activity_events SET payload = ?" + where)
            .bind(payload, e.repo, e.id)
            .run();
        } else {
          live.splice(live.indexOf(e), 1);
          await env.DB.prepare("DELETE FROM activity_events" + where)
            .bind(e.repo, e.id)
            .run();
        }
      }
      // Some syncs write several pages before reconciling.
      if (rand(3) === 0) continue;
      await reconcileRollups(env.DB);
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM counted_dirty").first(
          "n",
        ),
      ).toBe(0);
      const incremental = await snapshot();
      expect(await recomputeRollups(env.DB), `step ${step}`).toBe(0);
      expect(await snapshot()).toEqual(incremental);
    }
    // The run did reach the cases that matter.
    const uncounted = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM activity_events WHERE counted = 0",
    ).first<{ n: number }>();
    expect(uncounted!.n).toBeGreaterThan(0);
  });
});

describe("bounded recent feed", () => {
  // Bursty histories: each (repo, contributor, type) gets `most`/2 to `most`
  // events, `burst` and `small` setting how many arrive within seconds of the
  // last, so a group's newest RECENT_FETCH can fall short of eleven windows.
  async function seed(
    seedValue: number,
    most: number,
    burst: number,
    small: number,
    odd = false,
  ) {
    let seed = seedValue;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >>> 8) % n; // the low bits of this generator cycle
    };
    await env.DB.prepare(
      "INSERT INTO contributors (id, login, is_bot) VALUES (1, 'alice', 0), (2, 'bob', 0), (3, 'robo[bot]', 1)",
    ).run();
    const types = [
      "commit",
      "pr",
      "review",
      "merge",
      "issue",
      "comment_issue",
      "comment_review",
    ];
    const rows: string[] = [];
    let n = 0;
    for (const repo of ["entropylab", "bedrock"])
      for (const who of [1, 2, 3])
        for (const type of types) {
          let t = Date.UTC(2026, 4, 1) - rand(86400) * 1000;
          for (let i = (most >> 1) + rand(most >> 1); i > 0; i--) {
            // One gap in `burst` keeps the next event in the same minute.
            t -= (rand(burst) === 0 ? rand(small) : 60 + rand(3600)) * 1000;
            const stamp =
              odd && n === 7
                ? new Date(t + 500).toISOString()
                : new Date(t).toISOString().replace(".000Z", "Z");
            const payload =
              type === "merge"
                ? JSON.stringify({
                    mergeCommit: rand(3) ? null : `e${rand(n + 1)}`,
                  })
                : type === "pr" && rand(4) === 0
                  ? '{"draft":true}'
                  : "{}";
            rows.push(
              `('${repo}', ${who}, '${type}', 'e${n++}', '${stamp}', '${payload}')`,
            );
          }
        }
    for (let i = 0; i < rows.length; i += 200)
      await env.DB.prepare(
        `INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at, payload) VALUES ${rows.slice(i, i + 200).join(", ")}`,
      ).run();
    await reconcileRollups(env.DB);
  }

  // The feed as it was served from every counted event in history.
  async function fromHistory(bots: boolean) {
    const all = await env.DB.prepare(
      `SELECT e.repo || '/' || e.external_id AS event_key, c.login, e.repo, e.type, e.occurred_at,
         CASE WHEN json_valid(e.payload) AND json_extract(e.payload, '$.draft') = 1
              THEN '{"draft":true}' ELSE NULL END AS payload
       FROM activity_events e JOIN contributors c ON c.id = e.contributor_id
       WHERE e.counted = 1${bots ? "" : " AND c.is_bot = 0"}`,
    ).all<{
      event_key: string;
      login: string;
      repo: string;
      type: string;
      occurred_at: string;
      payload: string | null;
    }>();
    return retainRecent(all.results).map((r) => ({
      event_key: r.event_key,
      login: r.login,
      repo: r.repo,
      type: publicType(r.type),
      occurred_at: r.occurred_at,
      ...(r.type === "pr" && r.payload ? { draft: true } : {}),
    }));
  }

  async function served(bots: boolean) {
    const res = await handleStatsV3(
      env,
      new Request(
        `https://oogatron.test/v2/stats${bots ? "?include_bots=1" : ""}`,
      ),
    );
    return ((await res.json()) as { recent: unknown[] }).recent;
  }

  const groupReads = (prepare: { mock: { calls: unknown[][] } }) =>
    prepare.mock.calls.filter((c) =>
      (c[0] as string).includes("e.repo = ? AND e.contributor_id = ?"),
    ).length;

  it("serves exactly the full-history feed while reading a bounded slice", async () => {
    await seed(0x0b0b, 120, 1, 30);
    const prepare = vi.spyOn(env.DB, "prepare");
    for (const bots of [false, true]) {
      const expected = await fromHistory(bots);
      expect(expected.length).toBeGreaterThan(50);
      expect(await served(bots)).toEqual(expected);
    }
    // Some groups' newest RECENT_FETCH fell short and were read whole.
    expect(groupReads(prepare)).toBeGreaterThan(0);
    expect(groupReads(prepare)).toBeLessThan(80);
  });

  it("falls back to one full pass when many groups fall short", async () => {
    await seed(0x0b0b, 600, 1, 5);
    const prepare = vi.spyOn(env.DB, "prepare");
    expect(await served(true)).toEqual(await fromHistory(true));
    expect(groupReads(prepare)).toBe(0);
    expect(
      prepare.mock.calls.some(
        (c) =>
          !(c[0] as string).includes("WITH k") &&
          /WHERE e\.counted = 1\s*$/.test(c[0] as string),
      ),
    ).toBe(true);
  });

  it("reads a group whole when a timestamp is not GitHub's format", async () => {
    await seed(0x0dd, 20, 3, 40, true);
    const prepare = vi.spyOn(env.DB, "prepare");
    expect(await served(true)).toEqual(await fromHistory(true));
    expect(groupReads(prepare)).toBeGreaterThan(0);
  });
});

describe("isoWeek", () => {
  it("handles year boundaries per ISO-8601", () => {
    expect(isoWeek("2024-12-30")).toBe("2025-W01"); // Monday of week 1, 2025
    expect(isoWeek("2027-01-01")).toBe("2026-W53"); // Friday of week 53, 2026
    expect(isoWeek("2026-01-01")).toBe("2026-W01"); // Thursday
    expect(isoWeek("2026-09-16")).toBe("2026-W38");
    expect(isoWeek("2026-01-05T10:00:00Z")).toBe("2026-W02"); // full timestamps OK
  });
});
