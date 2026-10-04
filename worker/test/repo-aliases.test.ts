import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalRepoName } from "../src/config";
import { eventUpsertStatements, syncStateUpsert } from "../src/db/queries";
import { recomputeRollups } from "../src/db/rollups";

const ALIASES = [
  "lightningfactory",
  "lightning-factory",
  "lightning_factory",
  "lightningfoundry",
  "lightning-foundry",
  "lightning_foundry",
];
const cleanup = () => {
  const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0009_"));
  expect(migration).toBeDefined();
  return env.DB.batch(migration!.queries.map((q) => env.DB.prepare(q)));
};
const snapshot = async () => {
  const results = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT * FROM activity_events ORDER BY id"),
    env.DB.prepare(
      "SELECT * FROM daily_rollups ORDER BY repo, day, contributor_id, type",
    ),
    env.DB.prepare("SELECT * FROM repos ORDER BY name"),
    env.DB.prepare("SELECT * FROM sync_state ORDER BY repo, source"),
  ]);
  return results.map((r) => r.results);
};

describe("Lightning Foundry repository identity", () => {
  it("maps historical case and separator variants, not other repositories", () => {
    for (const name of ALIASES) {
      expect(canonicalRepoName(name)).toBe("lightningfoundry");
      expect(canonicalRepoName(name.toUpperCase())).toBe("lightningfoundry");
    }
    for (const name of [
      "bananapayserver",
      "entropylab",
      "my-lightningfactory",
    ]) {
      expect(canonicalRepoName(name)).toBe(name);
    }
  });

  it("migrates actual legacy rows by external id and immediately serves correct stats", async () => {
    // setup applies all migrations to an empty DB. Remove only this
    // migration's write guards to reproduce the pre-deployment database,
    // then execute the real migration SQL over populated history.
    await env.DB.batch(
      ["events", "repos", "sync_state"].map((table) =>
        env.DB.prepare(`DROP TRIGGER reject_foundry_alias_${table}`),
      ),
    );
    await env.DB.prepare(
      "INSERT INTO contributors (id, login) VALUES (1, 'alice'), (2, 'bob')",
    ).run();
    const at = "2026-09-29T10:00:00Z";
    const later = "2026-10-01T10:00:00Z";
    const event = (
      repo: string,
      externalId: string,
      type = "commit",
      payload: Record<string, unknown> | null = null,
      occurredAt = at,
      contributor = 1,
      counted = 1,
    ) =>
      env.DB.prepare(
        `INSERT INTO activity_events
           (repo, contributor_id, type, external_id, occurred_at, payload, counted)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        repo,
        contributor,
        type,
        externalId,
        occurredAt,
        payload === null ? null : JSON.stringify(payload),
        counted,
      );
    await env.DB.batch([
      event("lightningfoundry", "shared", "commit", { headline: "current" }),
      event("lightningfactory", "shared", "commit", { headline: "old" }),
      event("LIGHTNING-FOUNDRY", "shared"),
      // Same author and timestamp, different SHAs/headlines: both count.
      event("lightning_factory", "same-a", "commit", {
        authoredAt: at,
        headline: "left",
      }),
      event(
        "lightningfoundry",
        "same-b",
        "commit",
        {
          authoredAt: at,
          headline: "right",
        },
        at,
        1,
        0,
      ),
      event("Lightning-Factory", "old-only", "review", null, later, 2),
      event("lightningfoundry", "PR_1", "pr", { draft: false }),
      event("lightningfactory", "PR_1", "pr", { draft: true }),
      // Existing counting rules must be re-applied across renamed rows.
      event("lightning-foundry", "merge-sha"),
      event(
        "lightningfoundry",
        "merge:PR_1",
        "merge",
        {
          mergeCommit: "merge-sha",
        },
        later,
        2,
      ),
      event("lightningfactory", "patch-old", "commit", {
        authoredAt: at,
        headline: "patch",
      }),
      event(
        "lightning_foundry",
        "patch-new",
        "commit",
        {
          authoredAt: at,
          headline: "patch",
        },
        later,
      ),
      // External IDs remain repo-scoped outside this one rename family.
      event("bananapayserver", "shared"),
      env.DB.prepare(
        `INSERT INTO repos VALUES
         ('lightningfactory', 'old-branch', 0, '2026-01-01', '2026-10-03'),
         ('LIGHTNING-FOUNDRY', 'wrong-branch', 0, '2026-02-01', '2026-10-04'),
         ('lightningfoundry', 'rock', 1, '2026-03-01', '2026-10-02'),
         ('bananapayserver', 'main', 1, '2026-04-01', '2026-10-04')`,
      ),
      env.DB.prepare(
        `INSERT INTO sync_state VALUES
         ('lightningfactory', 'commits', '{"phase":"incremental"}', '2026-10-01'),
         ('lightningfoundry', 'prs', '{"phase":"backfill"}', '2026-10-02'),
         ('LIGHTNING_FOUNDRY', 'issue_comments', '{}', '2026-10-03'),
         ('bananapayserver', 'commits', '{"phase":"incremental"}', '2026-10-04'),
         ('*', 'rotation', '"Lightning-Factory"', '2026-10-04')`,
      ),
    ]);
    await recomputeRollups(env.DB);
    // A stale flag is restored as well as newly duplicated flags removed.
    await env.DB.prepare(
      "UPDATE activity_events SET counted = 0 WHERE external_id = 'same-b'",
    ).run();
    await cleanup();

    const after = await snapshot();
    expect(after[0]).toHaveLength(10); // 9 unique Foundry + 1 BananaPay
    const foundry = after[0].filter((r) => r.repo === "lightningfoundry");
    expect(foundry.map((r) => r.external_id).sort()).toEqual([
      "PR_1",
      "merge-sha",
      "merge:PR_1",
      "old-only",
      "patch-new",
      "patch-old",
      "same-a",
      "same-b",
      "shared",
    ]);
    expect(foundry.find((r) => r.external_id === "shared")!.payload).toBe(
      '{"headline":"current"}',
    );
    expect(foundry.find((r) => r.external_id === "PR_1")!.payload).toBe(
      '{"draft":false}',
    );
    expect(
      foundry
        .filter((r) => r.counted === 0)
        .map((r) => r.external_id)
        .sort(),
    ).toEqual(["merge-sha", "patch-old"]);
    expect(after[2]).toEqual([
      {
        name: "bananapayserver",
        default_branch: "main",
        is_active: 1,
        discovered_at: "2026-04-01",
        last_checked_at: "2026-10-04",
      },
      {
        name: "lightningfoundry",
        default_branch: "rock",
        is_active: 1,
        discovered_at: "2026-01-01",
        last_checked_at: "2026-10-02",
      },
    ]);
    expect(after[3].filter((r) => r.source !== "foundry_cleanup")).toEqual([
      {
        repo: "bananapayserver",
        source: "commits",
        cursor: '{"phase":"incremental"}',
        updated_at: "2026-10-04",
      },
    ]);
    expect(after[3].filter((r) => r.source === "foundry_cleanup")).toEqual([
      {
        repo: "*",
        source: "foundry_cleanup",
        cursor: "true",
        updated_at: expect.any(String),
      },
    ]);

    const response = await SELF.fetch("https://oogatron.test/v2/stats");
    expect(response.status).toBe(200);
    const stats = (await response.json()) as any;
    expect(stats.totals).toEqual({
      contributors: 2,
      commits: 6,
      prs: 1,
      reviews: 1,
      issues: 0,
      comments: 0,
    });
    expect(stats.repos.map((r: any) => r.name).sort()).toEqual([
      "bananapayserver",
      "lightningfoundry",
    ]);
    expect(
      stats.repos.find((r: any) => r.name === "lightningfoundry").totals,
    ).toEqual({
      contributors: 2,
      commits: 5,
      prs: 1,
      reviews: 1,
      issues: 0,
      comments: 0,
    });
    expect(stats.recent).toHaveLength(8);
    expect(
      stats.recent.every(
        (r: any) =>
          r.repo === "lightningfoundry" || r.repo === "bananapayserver",
      ),
    ).toBe(true);

    await cleanup();
    expect(await snapshot()).toEqual(after);
    // Migration flags/rollups match the production rebuild exactly.
    await recomputeRollups(env.DB);
    expect(await snapshot()).toEqual(after);
  });

  it("blocks old-worker alias writes atomically while new persistence normalizes them", async () => {
    await env.DB.prepare(
      "INSERT INTO contributors (id, login) VALUES (1, 'alice')",
    ).run();
    for (const alias of ALIASES.filter((n) => n !== "lightningfoundry")) {
      await expect(
        env.DB.batch([
          env.DB.prepare(
            `INSERT INTO sync_state VALUES ('lightningfoundry', 'commits', '{}', '2026-10-01')`,
          ),
          env.DB.prepare(
            `INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at)
           VALUES (?, 1, 'commit', 'old-worker', '2026-10-01T00:00:00Z')`,
          ).bind(alias),
        ]),
      ).rejects.toThrow("retired repository alias");
      expect(
        (
          await env.DB.prepare(
            "SELECT * FROM sync_state WHERE repo != '*'",
          ).all()
        ).results,
      ).toHaveLength(0);
    }
    await expect(
      env.DB.prepare(
        "INSERT INTO repos VALUES ('LIGHTNINGFACTORY', 'rock', 1, '2026-10-01', '2026-10-01')",
      ).run(),
    ).rejects.toThrow("retired repository alias");
    await expect(
      env.DB.prepare(
        "INSERT INTO sync_state VALUES ('Lightning-Foundry', 'prs', '{}', '2026-10-01')",
      ).run(),
    ).rejects.toThrow("retired repository alias");

    const event = {
      login: "alice",
      type: "commit" as const,
      externalId: "new-worker",
      occurredAt: "2026-10-01T00:00:00Z",
      payload: { headline: "kept" },
    };
    for (const alias of [...ALIASES, "LIGHTNING-FOUNDRY"]) {
      await env.DB.batch([
        ...eventUpsertStatements(env.DB, alias, [event]),
        syncStateUpsert(env.DB, alias, "commits", { phase: "incremental" }),
      ]);
    }
    const rows = await env.DB.prepare(
      "SELECT repo, external_id FROM activity_events",
    ).all();
    expect(rows.results).toEqual([
      { repo: "lightningfoundry", external_id: "new-worker" },
    ]);
    expect(
      (
        await env.DB.prepare(
          "SELECT repo FROM sync_state WHERE repo != '*'",
        ).all()
      ).results,
    ).toEqual([{ repo: "lightningfoundry" }]);
    const unchanged = await env.DB.batch(
      eventUpsertStatements(env.DB, "lightningfactory", [event]),
    );
    expect(unchanged[0].meta.changes).toBe(0);
  });
});
