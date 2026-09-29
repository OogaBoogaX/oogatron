import { COMMIT_OVERLAP_DAYS, OWNER } from "../config";
import { githubGraphQL } from "./github";
import { maxIso, persistPage, type SyncContext } from "./context";
import type { ParsedEvent, PageInfo, RepoRef } from "./types";

export type CommitsState =
  | { phase: "backfill"; cursor: string | null; maxSeen: string | null }
  | { phase: "incremental"; since: string };

// Shared with the PR walker (prs.ts), which reads the same fields off each
// PR's branch commits.
export const COMMIT_FIELDS = `
  oid committedDate messageHeadline additions deletions
  author { name email date user { login databaseId avatarUrl } }`;

const QUERY = `
query Commits($owner: String!, $name: String!, $branch: String!, $cursor: String, $since: GitTimestamp) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $branch) {
      target { ... on Commit {
        history(first: 100, after: $cursor, since: $since) {
          pageInfo { hasNextPage endCursor }
          nodes { ${COMMIT_FIELDS} }
        }
      } }
    }
  }
  rateLimit { remaining resetAt }
}`;

export interface CommitNode {
  oid: string;
  committedDate: string;
  messageHeadline: string;
  additions: number;
  deletions: number;
  author: {
    name: string | null;
    email: string | null;
    date: string;
    user: {
      login: string;
      databaseId: number | null;
      avatarUrl: string;
    } | null;
  } | null;
}

export function parseCommitsPage(data: Record<string, unknown>): {
  events: ParsedEvent[];
  pageInfo: PageInfo;
  maxSeen: string | null;
} {
  const history = (data as any).repository?.ref?.target?.history;
  if (!history) {
    return {
      events: [],
      pageInfo: { hasNextPage: false, endCursor: null },
      maxSeen: null,
    };
  }
  const events: ParsedEvent[] = [];
  let maxSeen: string | null = null;
  for (const node of (history.nodes as Array<CommitNode | null>).filter(
    (n): n is CommitNode => n !== null,
  )) {
    maxSeen = maxIso(maxSeen, node.committedDate);
    events.push(commitEvent(node));
  }
  return { events, pageInfo: history.pageInfo as PageInfo, maxSeen };
}

// The one commit -> event mapping for both walkers. A commit reached from a
// PR branch and later from the default branch is the same SHA, so the two
// must produce byte-identical payloads — otherwise the guarded upsert would
// flip the row on every run and force a rollup rebuild each tick.
// authoredAt (with the headline) is the patch identity the rollup rebuild
// uses to count a rebased or amended commit once (see db/rollups.ts).
export function commitEvent(node: CommitNode): ParsedEvent {
  const user = node.author?.user ?? null;
  return {
    type: "commit",
    externalId: node.oid,
    occurredAt: node.committedDate,
    actor: {
      githubId: user?.databaseId ?? null,
      login: user?.login ?? null,
      displayName: node.author?.name ?? null,
      avatarUrl: user?.avatarUrl ?? null,
      typename: user ? "User" : null,
      email: node.author?.email ?? null,
    },
    payload: {
      headline: node.messageHeadline,
      additions: node.additions,
      deletions: node.deletions,
      authoredAt: node.author?.date ?? null,
    },
  };
}

export async function syncCommits(
  ctx: SyncContext,
  repo: RepoRef,
  state: CommitsState | null,
): Promise<boolean> {
  let s: CommitsState = state ?? {
    phase: "backfill",
    cursor: null,
    maxSeen: null,
  };

  if (s.phase === "backfill") {
    while (ctx.budget.canAfford(3)) {
      const { data } = await githubGraphQL(ctx.env, ctx.budget, QUERY, {
        owner: OWNER,
        name: repo.name,
        branch: repo.defaultBranch,
        cursor: s.cursor,
        since: null,
      });
      const { events, pageInfo, maxSeen } = parseCommitsPage(data);
      const newMax = maxIso(s.maxSeen, maxSeen);
      if (pageInfo.hasNextPage) {
        s = { phase: "backfill", cursor: pageInfo.endCursor, maxSeen: newMax };
        await persistPage(ctx, repo.name, "commits", events, s);
      } else {
        // Backfill complete: promote to incremental. The watermark is the max
        // committedDate observed during the walk (not "now"), so nothing
        // between backfill start and the first incremental run is missed.
        s = {
          phase: "incremental",
          since: newMax ?? new Date(0).toISOString(),
        };
        await persistPage(ctx, repo.name, "commits", events, s);
        return true;
      }
    }
    return false;
  }

  // Incremental: history(since:) filters on committedDate; overlap the
  // watermark by a window to absorb rebase/cherry-pick out-of-order dates.
  const sinceParam = new Date(
    Date.parse(s.since) - COMMIT_OVERLAP_DAYS * 86400000,
  ).toISOString();
  let cursor: string | null = null;
  let watermark = s.since;
  while (ctx.budget.canAfford(3)) {
    const { data } = await githubGraphQL(ctx.env, ctx.budget, QUERY, {
      owner: OWNER,
      name: repo.name,
      branch: repo.defaultBranch,
      cursor,
      since: sinceParam,
    });
    const { events, pageInfo, maxSeen } = parseCommitsPage(data);
    watermark = maxIso(watermark, maxSeen)!;
    await persistPage(ctx, repo.name, "commits", events, {
      phase: "incremental",
      since: watermark,
    });
    if (!pageInfo.hasNextPage) return true;
    cursor = pageInfo.endCursor;
  }
  return false;
}
