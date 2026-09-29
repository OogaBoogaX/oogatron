import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { COUNTED, recomputeRollups } from "../src/db/rollups";
import { isoWeek } from "../src/util/isoweek";

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
  it("serves the recent feed from idx_events_time and prunes sync_runs by index", async () => {
    const recent = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT c.login, e.repo, e.type, e.occurred_at, e.payload
       FROM activity_events e JOIN contributors c ON c.id = e.contributor_id
       WHERE ${COUNTED} AND c.is_bot = 0
       ORDER BY e.occurred_at DESC LIMIT 12`,
    ).all<{ detail: string }>();
    expect(recent.results.map((r) => r.detail).join("\n")).toMatch(
      /USING INDEX idx_events_time/,
    );
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

describe("isoWeek", () => {
  it("handles year boundaries per ISO-8601", () => {
    expect(isoWeek("2024-12-30")).toBe("2025-W01"); // Monday of week 1, 2025
    expect(isoWeek("2027-01-01")).toBe("2026-W53"); // Friday of week 53, 2026
    expect(isoWeek("2026-01-01")).toBe("2026-W01"); // Thursday
    expect(isoWeek("2026-09-16")).toBe("2026-W38");
    expect(isoWeek("2026-01-05T10:00:00Z")).toBe("2026-W02"); // full timestamps OK
  });
});
