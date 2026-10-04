import {
  canonicalRepoName,
  EXCLUDED_REPOS,
  OWNER,
  REPO_DISCOVERY_TTL_MINUTES,
} from "../config";
import { githubGraphQL } from "./github";
import type { SyncContext } from "./context";
import type { RepoRef } from "./types";
import type { PageInfo } from "./types";

const QUERY = `
query OrgRepos($owner: String!, $cursor: String) {
  organization(login: $owner) {
    repositories(first: 100, after: $cursor, privacy: PUBLIC, isFork: false,
                 orderBy: { field: NAME, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { name isArchived defaultBranchRef { name } }
    }
  }
  rateLimit { remaining resetAt }
}`;

interface RepoNode {
  name: string;
  isArchived: boolean;
  defaultBranchRef: { name: string } | null;
}

// Refreshes the repos table from the org listing when it is stale (or empty),
// then returns the active roster. Discovery is TTL-gated so the per-minute
// cron reads the cached table almost every run; a refresh costs one GraphQL
// call plus one D1 batch. Repos that vanish from the listing (deleted,
// privated, archived) flip to is_active = 0: they stop syncing but keep
// their history.
export async function activeRepos(ctx: SyncContext): Promise<RepoRef[]> {
  const now = new Date().toISOString();
  const staleBefore = new Date(
    Date.now() - REPO_DISCOVERY_TTL_MINUTES * 60000,
  ).toISOString();
  const freshest = await ctx.db
    .prepare("SELECT MAX(last_checked_at) AS at FROM repos")
    .first<{ at: string | null }>();

  if (!freshest?.at || freshest.at < staleBefore) {
    const seen = new Map<string, { branch: string; active: boolean }>();
    let cursor: string | null = null;
    do {
      const { data } = await githubGraphQL(ctx.env, ctx.budget, QUERY, {
        owner: OWNER,
        cursor,
      });
      const conn = (data as any).organization?.repositories;
      if (!conn) throw new Error(`org not found: ${OWNER}`);
      for (const node of (conn.nodes as Array<RepoNode | null>).filter(
        (n): n is RepoNode => n !== null,
      )) {
        const branch = node.defaultBranchRef?.name ?? null;
        const name = canonicalRepoName(node.name);
        // Prefer the current name's branch/status if a listing contains
        // both it and a historical alias, regardless of listing order.
        if (seen.has(name) && node.name.toLowerCase() !== name) continue;
        seen.set(name, {
          branch: branch ?? "",
          // An empty repo (no default branch) is remembered but inactive.
          active:
            !node.isArchived &&
            branch !== null &&
            !EXCLUDED_REPOS.includes(name),
        });
      }
      const pageInfo = conn.pageInfo as PageInfo;
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor !== null);

    const statements = [
      ctx.db
        .prepare("UPDATE repos SET is_active = 0, last_checked_at = ?")
        .bind(now),
      ...[...seen.entries()].map(([name, r]) =>
        ctx.db
          .prepare(
            `INSERT INTO repos (name, default_branch, is_active, discovered_at, last_checked_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
               default_branch  = excluded.default_branch,
               is_active       = excluded.is_active,
               last_checked_at = excluded.last_checked_at`,
          )
          .bind(name, r.branch, r.active ? 1 : 0, now, now),
      ),
    ];
    ctx.budget.spend();
    await ctx.db.batch(statements);
  }

  const rows = await ctx.db
    .prepare(
      "SELECT name, default_branch FROM repos WHERE is_active = 1 ORDER BY name",
    )
    .all<{ name: string; default_branch: string }>();
  return rows.results.map((r) => ({
    name: r.name,
    defaultBranch: r.default_branch,
  }));
}
