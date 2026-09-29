import { env, fetchMock } from "cloudflare:test";
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { runSync } from "../src/sync/run";
import { parseCommitsPage } from "../src/sync/commits";
import { isCountableReview } from "../src/sync/prs";
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
      commit: 3,
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
    // 14 raw events minus the excluded commit.
    const rollups = await env.DB.prepare(
      "SELECT SUM(count) AS n FROM daily_rollups WHERE repo = 'entropylab'",
    ).first<{ n: number }>();
    expect(rollups!.n).toBe(13);
    const dedupedCommit = await env.DB.prepare(
      `SELECT SUM(count) AS n FROM daily_rollups WHERE type = 'commit'`,
    ).first<{ n: number }>();
    expect(dedupedCommit!.n).toBe(2); // a1 + a2; a3 folded into the merge

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
    expect(first.eventsWritten).toBe(14);
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
      commit: 3,
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
