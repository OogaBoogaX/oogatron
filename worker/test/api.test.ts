import { env, fetchMock, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { recomputeRollups } from "../src/db/rollups";
import commitsPage from "./fixtures/graphql/commits-page.json";
import prsPage from "./fixtures/graphql/prs-page.json";
import issuesPage from "./fixtures/graphql/issues-page.json";
import commitComments from "./fixtures/graphql/commit-comments.json";
import orgRepos from "./fixtures/graphql/org-repos.json";

const BASE = "https://oogatron.test";

// Events seeded raw, rollups derived through the real recompute so the API
// tests exercise the merge-commit dedupe exactly as production does: e2 is
// the merge's mergeCommit and must vanish from every served number.
async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO contributors (id, github_id, login, display_name, avatar_url, is_bot, first_seen_at, last_seen_at) VALUES
       (1, 1001, 'alice', 'Alice A', 'https://a.example/alice.png', 0, '2026-01-05T10:00:00Z', '2026-01-13T08:00:00Z'),
       (2, 4004, 'erik', NULL, NULL, 0, '2026-01-09T10:00:00Z', '2026-01-13T09:00:00Z'),
       (3, 5005, 'robo[bot]', NULL, NULL, 1, '2026-01-05T10:00:00Z', '2026-01-05T10:00:00Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at, payload) VALUES
       ('entropylab', 1, 'commit', 'e1', '2026-01-05T10:00:00Z', NULL),
       ('entropylab', 1, 'commit', 'e2', '2026-01-12T15:00:00Z', NULL),
       ('bedrock',    1, 'pr',     'e3', '2026-01-06T10:00:00Z', '{"number":3,"draft":true}'),
       ('entropylab', 2, 'review', 'e5', '2026-01-09T10:00:00Z', NULL),
       ('entropylab', 3, 'commit', 'e6', '2026-01-05T10:00:00Z', NULL),
       ('entropylab', 2, 'merge',  'merge:pr9', '2026-01-12T16:00:00Z', '{"prNumber":9,"mergeCommit":"e2"}'),
       ('entropylab', 1, 'comment_issue',  'e7', '2026-01-13T08:00:00Z', NULL),
       ('bedrock',    2, 'comment_review', 'e8', '2026-01-13T09:00:00Z', NULL),
       ('bedrock',    1, 'issue',          'e9', '2026-01-13T10:00:00Z', NULL)`,
    ),
  ]);
  await recomputeRollups(env.DB);
}

describe("/v1/stats (schema 2, comments invisible)", () => {
  it("serves the pre-comments shape with org totals, leaderboards, repos", async () => {
    await seed();
    const res = await SELF.fetch(`${BASE}/v1/stats`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as any;

    expect(body.meta).toMatchObject({ org: "OogaBoogaX", schema_version: 2 });
    expect(body.totals).toEqual({
      contributors: 2,
      commits: 2, // e1 + erik's merge; e2 deduped away, bot e6 excluded
      prs: 1,
      reviews: 1,
    });
    expect(body.totals.comments).toBeUndefined();
    expect(body.totals.issues).toBeUndefined();
    expect(body.leaderboards.commits).toEqual([
      { login: "alice", count: 1 },
      { login: "erik", count: 1 },
    ]);
    expect(body.leaderboards.comments).toBeUndefined();
    // bedrock's only erik activity is a comment -> invisible to v2.
    expect(body.repos.map((r: any) => r.name)).toEqual([
      "entropylab",
      "bedrock",
    ]);
    expect(body.repos[1].totals).toEqual({
      contributors: 1,
      commits: 0,
      prs: 1,
      reviews: 0,
    });
    expect(body.repos[0].leaderboards).toBeUndefined();
    expect(body.repos[0].last_activity_at).toBeUndefined();
    expect(body.recent).toBeUndefined();
    expect(body.contributors[0].counts.comments).toBeUndefined();
    expect(
      body.contributors[0].weekly.every((w: any) => w.comments === undefined),
    ).toBe(true);
  });
});

describe("/v2/stats (schema 3)", () => {
  it("serves comments, merges-as-commits, per-repo leaderboards, last activity, and the recent feed", async () => {
    await seed();
    const res = await SELF.fetch(`${BASE}/v2/stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.meta).toMatchObject({ org: "OogaBoogaX", schema_version: 3 });
    expect(body.totals).toEqual({
      contributors: 2,
      commits: 2,
      prs: 1,
      reviews: 1,
      issues: 1,
      comments: 2,
    });
    expect(body.leaderboards.comments).toEqual([
      { login: "alice", count: 1 },
      { login: "erik", count: 1 },
    ]);

    expect(body.repos.map((r: any) => r.name)).toEqual([
      "entropylab",
      "bedrock",
    ]);
    expect(body.repos[0].totals).toEqual({
      contributors: 2,
      commits: 2,
      prs: 0,
      reviews: 1,
      issues: 0,
      comments: 1,
    });
    expect(body.repos[0].last_activity_at).toBe("2026-01-13T08:00:00Z");
    expect(body.repos[0].leaderboards.commits).toEqual([
      { login: "alice", count: 1 },
      { login: "erik", count: 1 },
    ]);
    // erik's bedrock comment counts in v3: repo contributors = 2.
    expect(body.repos[1].totals).toEqual({
      contributors: 2,
      commits: 0,
      prs: 1,
      reviews: 0,
      issues: 1,
      comments: 1,
    });
    expect(body.repos[1].last_activity_at).toBe("2026-01-13T10:00:00Z");
    // Per-repo contributor activity: what routes each Ooga to its repo's cave.
    const activity = (i: number) =>
      [...body.repos[i].contributors].sort((a: any, b: any) =>
        a.login < b.login ? -1 : 1,
      );
    expect(activity(0)).toEqual([
      { login: "alice", last_seen_at: "2026-01-13T08:00:00Z" },
      { login: "erik", last_seen_at: "2026-01-12T16:00:00Z" },
    ]);
    expect(activity(1)).toEqual([
      { login: "alice", last_seen_at: "2026-01-13T10:00:00Z" },
      { login: "erik", last_seen_at: "2026-01-13T09:00:00Z" },
    ]);
    // Membership is guaranteed to align with each repo's contributor total
    // (both sides apply the same merge-commit exclusion) — the island's
    // baked-snapshot integrity check relies on this invariant.
    for (const repo of body.repos) {
      expect(repo.contributors.length, repo.name).toBe(
        repo.totals.contributors,
      );
    }
    expect(body.repos[1].leaderboards.comments).toEqual([
      { login: "erik", count: 1 },
    ]);
    // Issues have leaderboards too (org and per repo).
    expect(body.leaderboards.issues).toEqual([{ login: "alice", count: 1 }]);
    expect(body.repos[0].leaderboards.issues).toEqual([]);
    expect(body.repos[1].leaderboards.issues).toEqual([
      { login: "alice", count: 1 },
    ]);

    // Recent: newest first, bot-filtered, merge commit deduped, comment
    // surfaces folded to "comment", merges labelled as merges, draft PRs
    // flagged from their payload.
    expect(
      body.recent.map((r: any) => [r.login, r.repo, r.type, r.draft]),
    ).toEqual([
      ["alice", "bedrock", "issue", undefined],
      ["erik", "bedrock", "comment", undefined],
      ["alice", "entropylab", "comment", undefined],
      ["erik", "entropylab", "merge", undefined],
      ["erik", "entropylab", "review", undefined],
      ["alice", "bedrock", "pr", true],
      ["alice", "entropylab", "commit", undefined],
    ]);

    expect(body.contributors[0].counts).toEqual({
      commits: 1,
      prs: 1,
      reviews: 0,
      issues: 1,
      comments: 1,
    });
    expect(body.contributors[0].login).toBe("alice");
  });

  it("includes bots with ?include_bots=1", async () => {
    await seed();
    const res = await SELF.fetch(`${BASE}/v2/stats?include_bots=1`);
    const body = (await res.json()) as any;
    expect(body.totals.commits).toBe(3);
    expect(body.totals.contributors).toBe(3);
  });

  it("serves the second request from KV and misses after a generation bump", async () => {
    await seed();
    const first = await SELF.fetch(`${BASE}/v2/stats`);
    expect(first.headers.get("x-oogatron-cache")).toBeNull();
    const second = await SELF.fetch(`${BASE}/v2/stats`);
    expect(second.headers.get("x-oogatron-cache")).toBe("hit");
    // The two routes cache independently (pathname is in the key).
    const v1 = await SELF.fetch(`${BASE}/v1/stats`);
    expect(v1.headers.get("x-oogatron-cache")).toBeNull();
    await env.CACHE.put("cache:gen", "999");
    const third = await SELF.fetch(`${BASE}/v2/stats`);
    expect(third.headers.get("x-oogatron-cache")).toBeNull();
  });
});

describe("/v1/contributors", () => {
  it("returns the roster without weekly", async () => {
    await seed();
    const res = await SELF.fetch(`${BASE}/v1/contributors`);
    const body = (await res.json()) as any;
    expect(body.contributors[0].weekly).toBeUndefined();
    expect(body.contributors[0].counts).toBeDefined();
  });

  it("serves one contributor with from/to/type filters, merge-deduped", async () => {
    await seed();
    const all = (await (
      await SELF.fetch(`${BASE}/v1/contributors/alice`)
    ).json()) as any;
    expect(all.counts.commits).toBe(1); // e2 is the merge's commit: deduped
    expect(all.counts.prs).toBe(1);
    expect(all.counts.comments).toBe(1);

    const windowed = (await (
      await SELF.fetch(
        `${BASE}/v1/contributors/alice?from=2026-01-10&to=2026-01-12`,
      )
    ).json()) as any;
    expect(windowed.counts.commits).toBe(0); // only e2 in the window, deduped

    const merges = (await (
      await SELF.fetch(`${BASE}/v1/contributors/erik?type=merge`)
    ).json()) as any;
    expect(merges.counts.commits).toBe(1); // merges fold into commits

    const commented = (await (
      await SELF.fetch(`${BASE}/v1/contributors/alice?type=comment_issue`)
    ).json()) as any;
    expect(commented.counts.comments).toBe(1);

    const opened = (await (
      await SELF.fetch(`${BASE}/v1/contributors/alice?type=issue`)
    ).json()) as any;
    expect(opened.counts.issues).toBe(1);

    const bad = await SELF.fetch(`${BASE}/v1/contributors/alice?type=nope`);
    expect(bad.status).toBe(400);
  });

  it("404s unknown logins and hides bots by default", async () => {
    await seed();
    expect((await SELF.fetch(`${BASE}/v1/contributors/nobody`)).status).toBe(
      404,
    );
    expect((await SELF.fetch(`${BASE}/v1/contributors/robo[bot]`)).status).toBe(
      404,
    );
    expect(
      (await SELF.fetch(`${BASE}/v1/contributors/robo[bot]?include_bots=1`))
        .status,
    ).toBe(200);
  });
});

describe("CORS", () => {
  it("answers preflight on /v1/* and /v2/*", async () => {
    for (const path of ["/v1/stats", "/v2/stats"]) {
      const res = await SELF.fetch(`${BASE}${path}`, { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    }
  });
});

describe("/admin/backfill", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  it("rejects missing or wrong bearer tokens", async () => {
    expect(
      (await SELF.fetch(`${BASE}/admin/backfill`, { method: "POST" })).status,
    ).toBe(401);
    const wrong = await SELF.fetch(`${BASE}/admin/backfill`, {
      method: "POST",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  });

  it("runs a sync slice with a valid token", async () => {
    fetchMock
      .get("https://api.github.com")
      .intercept({ path: "/graphql", method: "POST" })
      .reply(200, (opts) => {
        const body = JSON.parse(String(opts.body)) as { query: string };
        if (body.query.includes("query OrgRepos")) return orgRepos;
        if (body.query.includes("query Commits")) return commitsPage;
        if (body.query.includes("query PRs")) return prsPage;
        if (body.query.includes("query Issues")) return issuesPage;
        if (body.query.includes("query CommitComments")) return commitComments;
        throw new Error("unmocked query");
      })
      .persist();

    const res = await SELF.fetch(`${BASE}/admin/backfill`, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.done).toBe(true);
    expect(body.result.eventsWritten).toBeGreaterThan(0);
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    expect((await SELF.fetch(`${BASE}/nope`)).status).toBe(404);
  });
});
