import { env, fetchMock } from "cloudflare:test";
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { runSync } from "../src/sync/run";
import { parseCommitsPage } from "../src/sync/commits";
import { isCountableReview, parsePrNode } from "../src/sync/prs";
import { ContributorResolver } from "../src/sync/identity";
import { actorFrom } from "../src/sync/types";
import commitsPage from "./fixtures/graphql/commits-page.json";
import prsPage from "./fixtures/graphql/prs-page.json";
import issuesPage from "./fixtures/graphql/issues-page.json";
import commitComments from "./fixtures/graphql/commit-comments.json";
import orgRepos from "./fixtures/graphql/org-repos.json";

// One dispatcher for the whole file; tests swap the OrgRepos response via
// this variable (undici keeps persisted interceptors registered across
// tests, so per-test intercepts on the same path would shadow each other).
let orgReposResponse: unknown = orgRepos;

function mockGitHub() {
  fetchMock
    .get("https://api.github.com")
    .intercept({ path: "/graphql", method: "POST" })
    .reply(200, (opts) => {
      const body = JSON.parse(String(opts.body)) as { query: string };
      if (body.query.includes("query OrgRepos")) return orgReposResponse as any;
      if (body.query.includes("query Commits")) return commitsPage;
      if (body.query.includes("query PRs")) return prsPage;
      if (body.query.includes("query Issues")) return issuesPage;
      if (body.query.includes("query CommitComments")) return commitComments;
      throw new Error(`unmocked GraphQL query: ${body.query.slice(0, 80)}`);
    })
    .persist();
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  mockGitHub();
});
afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

async function eventCounts(repo?: string): Promise<Record<string, number>> {
  const rows = repo
    ? await env.DB.prepare(
        "SELECT type, COUNT(*) AS n FROM activity_events WHERE repo = ? GROUP BY type",
      )
        .bind(repo)
        .all<{ type: string; n: number }>()
    : await env.DB.prepare(
        "SELECT type, COUNT(*) AS n FROM activity_events GROUP BY type",
      ).all<{ type: string; n: number }>();
  return Object.fromEntries(rows.results.map((r) => [r.type, r.n]));
}

async function syncStateMap(): Promise<Map<string, unknown>> {
  const rows = await env.DB.prepare(
    "SELECT repo, source, cursor FROM sync_state",
  ).all<{ repo: string; source: string; cursor: string }>();
  return new Map(
    rows.results.map((r) => [`${r.repo}/${r.source}`, JSON.parse(r.cursor)]),
  );
}

describe("full sync against recorded GraphQL pages", () => {
  it("discovers renamed Foundry once and keeps BananaPayServer independent", async () => {
    orgReposResponse = {
      data: {
        organization: {
          repositories: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                name: "LightningFactory",
                isArchived: true,
                defaultBranchRef: { name: "old" },
              },
              {
                name: "lightningfoundry",
                isArchived: false,
                defaultBranchRef: { name: "rock" },
              },
              {
                name: "LIGHTNING-FOUNDRY",
                isArchived: true,
                defaultBranchRef: { name: "also-old" },
              },
              {
                name: "bananapayserver",
                isArchived: false,
                defaultBranchRef: { name: "main" },
              },
            ],
          },
        },
        rateLimit: { remaining: 4999, resetAt: "2026-01-07T13:00:00Z" },
      },
    };
    const result = await runSync(env, "admin");
    expect(result.done).toBe(true);
    const rows = await env.DB.prepare(
      "SELECT name, default_branch, is_active FROM repos ORDER BY name",
    ).all();
    expect(rows.results).toEqual([
      { name: "bananapayserver", default_branch: "main", is_active: 1 },
      { name: "lightningfoundry", default_branch: "rock", is_active: 1 },
    ]);
    // The same recorded GitHub IDs count once in each independent repo;
    // historical names neither add a third copy nor suppress BananaPay.
    expect(await eventCounts("lightningfoundry")).toEqual(
      await eventCounts("bananapayserver"),
    );
    expect((await eventCounts("lightningfoundry")).commit).toBe(4);
    expect(
      (
        await env.DB.prepare(
          "SELECT DISTINCT repo FROM activity_events ORDER BY repo",
        ).all()
      ).results,
    ).toEqual([{ repo: "bananapayserver" }, { repo: "lightningfoundry" }]);
    const second = await runSync(env, "admin");
    expect(second.eventsWritten).toBe(0);
  });

  it("discovers repos, ingests every source, resolves identities, and is idempotent", async () => {
    orgReposResponse = orgRepos;

    const first = await runSync(env, "admin");
    expect(first.skipped).toBe(false);
    expect(first.kind).toBe("backfill");
    expect(first.done).toBe(true);

    // Discovery: archived and empty repos are stored but inactive.
    const repoRows = await env.DB.prepare(
      "SELECT name, default_branch, is_active FROM repos ORDER BY name",
    ).all<{ name: string; default_branch: string; is_active: number }>();
    expect(repoRows.results).toEqual([
      { name: "empty-cave", default_branch: "", is_active: 0 },
      { name: "entropylab", default_branch: "rock", is_active: 1 },
      { name: "mothballed", default_branch: "main", is_active: 0 },
    ]);

    const counts = await eventCounts();
    expect(counts).toEqual({
      // a1-a3 from the default branch; PR #1's branch commit is a1 again (one
      // row by SHA); PR #2's unmerged branch commit b1 counts on its own.
      commit: 4,
      pr: 2,
      review: 1, // APPROVED only: PENDING and the empty-body container are skipped
      merge: 1, // PR #1, credited to erik who pressed the button
      issue: 1, // issue #10, credited to its opener
      comment_review: 1,
      comment_issue: 4, // PR conversation x2 + issue comments x2
      comment_commit: 1,
    });
    const mergeRow = await env.DB.prepare(
      "SELECT external_id, payload FROM activity_events WHERE type = 'merge'",
    ).first<{ external_id: string; payload: string }>();
    expect(mergeRow!.external_id).toBe("merge:PR_kwDOtest0001");
    expect(JSON.parse(mergeRow!.payload).mergeCommit).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3",
    );
    const prRows = await env.DB.prepare(
      "SELECT external_id, payload FROM activity_events WHERE type = 'pr' ORDER BY external_id",
    ).all<{ external_id: string; payload: string }>();
    expect(
      prRows.results.map((r) => [r.external_id, JSON.parse(r.payload).draft]),
    ).toEqual([
      ["PR_kwDOtest0001", false],
      ["PR_kwDOtest0002", true],
    ]);
    const repoScan = await env.DB.prepare(
      "SELECT DISTINCT repo FROM activity_events",
    ).all<{ repo: string }>();
    expect(repoScan.results).toEqual([{ repo: "entropylab" }]);

    // Identity resolution.
    const contributors = await env.DB.prepare(
      "SELECT login, github_id, display_name, is_bot FROM contributors ORDER BY login",
    ).all<{
      login: string;
      github_id: number | null;
      display_name: string | null;
      is_bot: number;
    }>();
    const byLogin = new Map(contributors.results.map((c) => [c.login, c]));

    expect(byLogin.get("alice")).toMatchObject({ github_id: 1001, is_bot: 0 });
    // noreply email "2002+bob@..." recovered to a real identity:
    expect(byLogin.get("bob")).toMatchObject({ github_id: 2002 });
    // unknown email became a hash row; no raw email stored anywhere:
    const emailRow = contributors.results.find((c) =>
      c.login.startsWith("email:"),
    );
    expect(emailRow).toBeDefined();
    expect(emailRow!.login).toMatch(/^email:[0-9a-f]{16}$/);
    expect(emailRow!.display_name).toBe("Carol");
    const rawEmailScan = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM contributors WHERE login LIKE '%@%'",
    ).first<{ n: number }>();
    expect(rawEmailScan!.n).toBe(0);
    // Deleted PR author became ghost:
    expect(byLogin.get("ghost")).toBeDefined();

    // Rollups were recomputed, repo-scoped, and the merge commit (...a3, the
    // PR's mergeCommit) was excluded so the merge is one credit, not two:
    // 15 raw events minus the excluded commit.
    const rollups = await env.DB.prepare(
      "SELECT SUM(count) AS n FROM daily_rollups WHERE repo = 'entropylab'",
    ).first<{ n: number }>();
    expect(rollups!.n).toBe(14);
    const dedupedCommit = await env.DB.prepare(
      `SELECT SUM(count) AS n FROM daily_rollups WHERE type = 'commit'`,
    ).first<{ n: number }>();
    expect(dedupedCommit!.n).toBe(3); // a1 + a2 + b1; a3 folded into the merge

    // Sync state promoted to incremental, keyed per repo; the rotation
    // pointer recorded which repo led.
    const state = await syncStateMap();
    expect((state.get("entropylab/commits") as any).phase).toBe("incremental");
    expect((state.get("entropylab/commits") as any).since).toBe(
      "2026-01-07T12:00:00Z",
    );
    expect((state.get("entropylab/prs") as any).phase).toBe("incremental");
    expect((state.get("entropylab/issue_comments") as any).phase).toBe(
      "incremental",
    );
    expect((state.get("entropylab/commit_comments") as any).cursor).toBe(
      "cc-cursor-1",
    );
    expect(state.get("*/rotation")).toBe("entropylab");

    // Second run: incremental, and re-upserting the same pages changes nothing
    // — and reports nothing, so no rollup rebuild is triggered.
    expect(first.eventsWritten).toBe(15);
    await env.DB.prepare("DELETE FROM daily_rollups WHERE type = 'pr'").run();
    const second = await runSync(env, "admin");
    expect(second.kind).toBe("incremental");
    expect(second.done).toBe(true);
    expect(second.eventsWritten).toBe(0);
    expect(await eventCounts()).toEqual(counts);
    const prRollups = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM daily_rollups WHERE type = 'pr'",
    ).first<{ n: number }>();
    expect(prRollups!.n).toBe(0); // untouched: recomputeRollups did not run

    // A real change to one event counts once and does trigger the rebuild
    // (a commit, since the commit overlap window always re-fetches it).
    await env.DB.prepare(
      "UPDATE activity_events SET payload = '{}' WHERE type = 'commit' AND external_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'",
    ).run();
    const third = await runSync(env, "admin");
    expect(third.eventsWritten).toBe(1);
    const rebuilt = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM daily_rollups WHERE type = 'pr'",
    ).first<{ n: number }>();
    expect(rebuilt!.n).toBeGreaterThan(0);

    const contributorCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM contributors",
    ).first<{ n: number }>();
    expect(contributorCount!.n).toBe(contributors.results.length);
  });

  it("loops every active repo and rotates the lead between runs", async () => {
    orgReposResponse = {
      data: {
        organization: {
          repositories: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                name: "alpha",
                isArchived: false,
                defaultBranchRef: { name: "rock" },
              },
              {
                name: "beta",
                isArchived: false,
                defaultBranchRef: { name: "main" },
              },
            ],
          },
        },
        rateLimit: { remaining: 4999, resetAt: "2026-01-07T13:00:00Z" },
      },
    };

    const first = await runSync(env, "admin");
    expect(first.done).toBe(true);

    // Both repos ingested the recorded pages; uniqueness is repo-scoped, so
    // the same external ids land once per repo.
    const perRepo = {
      commit: 4,
      pr: 2,
      review: 1,
      merge: 1,
      issue: 1,
      comment_issue: 4,
      comment_review: 1,
      comment_commit: 1,
    };
    expect(await eventCounts("alpha")).toEqual(perRepo);
    expect(await eventCounts("beta")).toEqual(perRepo);

    // Round-robin: alphabetical order on the first run (no pointer), so
    // alpha led; the next run starts after it, so beta leads.
    expect((await syncStateMap()).get("*/rotation")).toBe("alpha");
    const second = await runSync(env, "admin");
    expect(second.done).toBe(true);
    expect((await syncStateMap()).get("*/rotation")).toBe("beta");
  });
});

describe("parseCommitsPage", () => {
  it("extracts events and the max committedDate", () => {
    const { events, pageInfo, maxSeen } = parseCommitsPage(
      commitsPage.data as Record<string, unknown>,
    );
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: "commit",
      externalId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
      actor: { githubId: 1001, login: "alice" },
      payload: { headline: "feat: add entropy sampler", additions: 120 },
    });
    expect(events[1].actor).toMatchObject({
      login: null,
      email: "2002+bob@users.noreply.github.com",
    });
    expect(pageInfo.hasNextPage).toBe(false);
    expect(maxSeen).toBe("2026-01-07T12:00:00Z");
  });
});

describe("parsePrNode branch commits", () => {
  const prs = prsPage.data.repository.pullRequests.nodes.filter(
    (n) => n !== null,
  ) as any[];

  it("maps branch commits exactly as the default-branch walk does", () => {
    const fromBranch = parsePrNode(prs[0]).events.filter(
      (e) => e.type === "commit",
    );
    const fromHistory = parseCommitsPage(
      commitsPage.data as Record<string, unknown>,
    ).events.find((e) => e.externalId === fromBranch[0].externalId);
    expect(fromBranch).toHaveLength(1);
    // Byte-identical payloads, or the guarded upsert would flip the row
    // between walkers every run.
    expect(JSON.stringify(fromBranch[0])).toBe(JSON.stringify(fromHistory));
    expect(fromBranch[0].payload.authoredAt).toBe("2026-01-05T10:00:00Z");
  });

  it("queues a follow-up when a PR has more commits than one page", () => {
    const pr = {
      ...prs[1],
      commits: {
        ...prs[1].commits,
        pageInfo: { hasNextPage: true, endCursor: "commit-cursor-1" },
      },
    };
    expect(parsePrNode(pr).followUps).toEqual([
      {
        kind: "pr_overflow",
        nodeId: "PR_kwDOtest0002",
        prNumber: 2,
        reviewCursor: null,
        commentCursor: null,
        commitCursor: "commit-cursor-1",
      },
    ]);
  });
});

describe("isCountableReview", () => {
  it("skips containers and drafts, counts real submissions", () => {
    expect(isCountableReview("APPROVED", "")).toBe(true);
    expect(isCountableReview("CHANGES_REQUESTED", "")).toBe(true);
    expect(isCountableReview("DISMISSED", "")).toBe(true);
    expect(isCountableReview("COMMENTED", "")).toBe(false);
    expect(isCountableReview("COMMENTED", "  \n")).toBe(false);
    expect(isCountableReview("COMMENTED", "real prose")).toBe(true);
  });
});

describe("ContributorResolver", () => {
  it("writes nothing when re-resolving an unchanged contributor", async () => {
    const actor = {
      githubId: 4242,
      login: "alice",
      displayName: "Alice",
      avatarUrl: "https://avatars.example/alice",
      typename: "User",
      email: null,
    };
    const changes = async (): Promise<number[]> => {
      const resolver = await ContributorResolver.load(env.DB);
      const statements: D1PreparedStatement[] = [];
      await resolver.resolve(env.DB, actor, "2026-01-10T10:00:00Z", statements);
      const results = await env.DB.batch(statements);
      return results.map((r) => r.meta.changes ?? 0);
    };
    expect(await changes()).toEqual([1]); // rule 2/3: insert
    expect(await changes()).toEqual([0]); // rule 1: unchanged refresh
    // A genuinely newer event still moves last_seen_at.
    const resolver = await ContributorResolver.load(env.DB);
    const statements: D1PreparedStatement[] = [];
    await resolver.resolve(env.DB, actor, "2026-02-01T00:00:00Z", statements);
    const [res] = await env.DB.batch(statements);
    expect(res.meta.changes).toBe(1);
    const row = await env.DB.prepare(
      "SELECT first_seen_at, last_seen_at FROM contributors WHERE login = 'alice'",
    ).first();
    expect(row).toEqual({
      first_seen_at: "2026-01-10T10:00:00Z",
      last_seen_at: "2026-02-01T00:00:00Z",
    });
  });
});

describe("bot identity", () => {
  it("resolves a Bot actor and its commits to one row in a single batch", async () => {
    await env.DB.prepare(
      "INSERT INTO contributors (github_id, login, is_bot) VALUES (49699333, 'dependabot[bot]', 1)",
    ).run();
    const resolver = await ContributorResolver.load(env.DB);
    const statements: D1PreparedStatement[] = [];
    const asPrAuthor = await resolver.resolve(
      env.DB,
      actorFrom({
        login: "dependabot",
        __typename: "Bot",
        databaseId: 49699333,
      }),
      "2026-01-10T10:00:00Z",
      statements,
    );
    const asCommitAuthor = await resolver.resolve(
      env.DB,
      {
        githubId: 49699333,
        login: "dependabot[bot]",
        displayName: "dependabot[bot]",
        avatarUrl: null,
        typename: "User",
        email: null,
      },
      "2026-01-10T10:05:00Z",
      statements,
    );
    await env.DB.batch(statements);
    expect(asPrAuthor).toBe("dependabot[bot]");
    expect(asCommitAuthor).toBe("dependabot[bot]");
    const rows = await env.DB.prepare(
      "SELECT login FROM contributors WHERE github_id = 49699333",
    ).all();
    expect(rows.results).toEqual([{ login: "dependabot[bot]" }]);
  });

  it("keeps a known contributor's login when a stale noreply email names them", async () => {
    await env.DB.prepare(
      "INSERT INTO contributors (github_id, login) VALUES (2002, 'bob-renamed')",
    ).run();
    const resolver = await ContributorResolver.load(env.DB);
    const statements: D1PreparedStatement[] = [];
    const login = await resolver.resolve(
      env.DB,
      {
        githubId: null,
        login: null,
        displayName: "Bob",
        avatarUrl: null,
        typename: null,
        email: "2002+bob@users.noreply.github.com",
      },
      "2026-01-10T10:00:00Z",
      statements,
    );
    await env.DB.batch(statements);
    expect(login).toBe("bob-renamed");
  });
});

describe("stale-run guard", () => {
  it("finalizes Foundry cleanup after an old run, even when the next sync is quiet", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sync_runs (kind, started_at, status) VALUES ('incremental', ?, 'running')",
      ).bind(now),
      // No active repos or GitHub pages in this run: only the pending
      // migration can repair rollups left behind by the old partial run.
      env.DB.prepare(
        "INSERT INTO repos VALUES ('bananapayserver', 'main', 0, ?, ?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO contributors (id, login) VALUES (1, 'alice')",
      ),
      env.DB.prepare(
        `INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at)
         VALUES ('bananapayserver', 1, 'commit', 'earlier-page', ?)`,
      ).bind(now),
      // The old invocation held these in memory before migration and wrote
      // them afterward. It can use the canonical name and still be stale.
      env.DB.prepare(
        `INSERT INTO sync_state VALUES
         ('lightningfoundry', 'commits', '{"phase":"incremental"}', ?),
         ('*', 'rotation', '"LightningFactory"', ?)`,
      ).bind(now, now),
    ]);
    const pending = () =>
      env.DB.prepare(
        "SELECT * FROM sync_state WHERE source = 'foundry_cleanup'",
      ).first();
    expect(await pending()).not.toBeNull();
    expect((await runSync(env, "cron")).skipped).toBe(true);
    expect(await pending()).not.toBeNull();
    expect(
      (await env.DB.prepare("SELECT * FROM daily_rollups").all()).results,
    ).toHaveLength(0);

    await env.DB.prepare("UPDATE sync_runs SET status = 'error'").run();
    await env.CACHE.put("cache:gen", "before-cleanup");
    const result = await runSync(env, "cron");
    expect(result.done).toBe(true);
    expect(result.eventsWritten).toBe(0);
    expect(await pending()).toBeNull();
    expect(
      (await env.DB.prepare("SELECT * FROM sync_state").all()).results,
    ).toHaveLength(0);
    expect(
      (await env.DB.prepare("SELECT repo, count FROM daily_rollups").all())
        .results,
    ).toEqual([{ repo: "bananapayserver", count: 1 }]);
    expect(await env.CACHE.get("cache:gen")).not.toBe("before-cleanup");
  });

  it("skips while a fresh run is active and reclaims a stale one", async () => {
    const minutesAgo = (m: number) =>
      new Date(Date.now() - m * 60000).toISOString();
    const row = await env.DB.prepare(
      "INSERT INTO sync_runs (kind, started_at, status) VALUES ('incremental', ?, 'running') RETURNING id",
    )
      .bind(minutesAgo(1))
      .first<{ id: number }>();
    expect((await runSync(env, "cron")).skipped).toBe(true);

    await env.DB.prepare("UPDATE sync_runs SET started_at = ? WHERE id = ?")
      .bind(minutesAgo(6), row!.id)
      .run();
    const result = await runSync(env, "cron");
    expect(result.skipped).toBe(false);
    const stale = await env.DB.prepare(
      "SELECT status, detail FROM sync_runs WHERE id = ?",
    )
      .bind(row!.id)
      .first<{ status: string; detail: string }>();
    expect(stale!.status).toBe("error");
    expect(stale!.detail).toContain("[marked stale]");
  });
});
