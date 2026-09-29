import { OWNER } from "../config";
import { githubGraphQL } from "./github";
import { maxIso, persistPage, type SyncContext } from "./context";
import {
  actorFrom,
  type GqlActor,
  type PageInfo,
  type ParsedEvent,
  type RepoRef,
} from "./types";

export type PrsState =
  | { phase: "backfill"; cursor: string | null; maxSeen: string | null }
  | { phase: "incremental"; updatedSince: string };

const ACTOR = `author { login avatarUrl __typename ... on User { databaseId } ... on Bot { databaseId } }`;
const MERGED_BY = `mergedBy { login avatarUrl __typename ... on User { databaseId } ... on Bot { databaseId } }`;
const COMMENTS = `pageInfo { hasNextPage endCursor } nodes { id createdAt ${ACTOR} }`;
const REVIEW = `id state body submittedAt ${ACTOR} comments(first: 50) { ${COMMENTS} }`;
const PR = `
  id number title state isDraft createdAt updatedAt mergedAt additions deletions
  ${ACTOR}
  ${MERGED_BY}
  mergeCommit { oid }
  reviews(first: 50) { pageInfo { hasNextPage endCursor } nodes { ${REVIEW} } }
  comments(first: 50) { ${COMMENTS} }`;

const PAGE_QUERY = `
query PRs($owner: String!, $name: String!, $cursor: String, $order: IssueOrderField!, $dir: OrderDirection!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 25, after: $cursor, orderBy: { field: $order, direction: $dir }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PR} }
    }
  }
  rateLimit { remaining resetAt }
}`;

const PR_OVERFLOW_QUERY = `
query PrOverflow($id: ID!, $reviewCursor: String, $commentCursor: String) {
  node(id: $id) {
    ... on PullRequest {
      number
      reviews(first: 50, after: $reviewCursor) { pageInfo { hasNextPage endCursor } nodes { ${REVIEW} } }
      comments(first: 50, after: $commentCursor) { ${COMMENTS} }
    }
  }
  rateLimit { remaining resetAt }
}`;

const REVIEW_OVERFLOW_QUERY = `
query ReviewOverflow($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReview {
      pullRequest { number }
      comments(first: 50, after: $cursor) { ${COMMENTS} }
    }
  }
  rateLimit { remaining resetAt }
}`;

interface GqlComment {
  id: string;
  createdAt: string;
  author: GqlActor | null;
}

interface GqlReview {
  id: string;
  state: string;
  body: string;
  submittedAt: string | null;
  author: GqlActor | null;
  comments: { pageInfo: PageInfo; nodes: GqlComment[] };
}

interface GqlPr {
  id: string;
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  author: GqlActor | null;
  mergedBy: GqlActor | null;
  mergeCommit: { oid: string } | null;
  reviews: { pageInfo: PageInfo; nodes: GqlReview[] };
  comments: { pageInfo: PageInfo; nodes: GqlComment[] };
}

export interface FollowUp {
  kind: "pr_overflow" | "review_comments";
  nodeId: string;
  prNumber: number;
  reviewCursor: string | null;
  commentCursor: string | null;
}

// GitHub auto-creates an empty-body COMMENTED "container" review for every
// batch of line comments; counting those would turn each line-comment burst
// into a phantom review. PENDING reviews are unsubmitted drafts. A review
// event therefore requires a real submission: an explicit verdict, or a
// COMMENTED review whose body carries actual prose. Its line comments always
// count as comment_review regardless.
export function isCountableReview(state: string, body: string): boolean {
  if (state === "APPROVED" || state === "CHANGES_REQUESTED") return true;
  if (state === "DISMISSED") return true;
  return state === "COMMENTED" && body.trim().length > 0;
}

function reviewEvents(
  review: GqlReview,
  prNumber: number,
  out: ParsedEvent[],
  followUps: FollowUp[],
): void {
  if (review.state === "PENDING") {
    // Unsubmitted draft, only visible to its author; its comments surface
    // later once the review is submitted.
    return;
  }
  if (isCountableReview(review.state, review.body)) {
    out.push({
      type: "review",
      externalId: review.id,
      occurredAt: review.submittedAt ?? "",
      actor: actorFrom(review.author),
      payload: {
        state: review.state,
        prNumber,
        hasBody: review.body.trim().length > 0,
      },
    });
  }
  for (const c of review.comments.nodes) {
    out.push({
      type: "comment_review",
      externalId: c.id,
      occurredAt: c.createdAt,
      actor: actorFrom(c.author),
      payload: { prNumber },
    });
  }
  if (review.comments.pageInfo.hasNextPage) {
    followUps.push({
      kind: "review_comments",
      nodeId: review.id,
      prNumber,
      reviewCursor: null,
      commentCursor: review.comments.pageInfo.endCursor,
    });
  }
}

function conversationCommentEvents(
  comments: GqlComment[],
  prNumber: number,
  out: ParsedEvent[],
): void {
  for (const c of comments) {
    out.push({
      type: "comment_issue",
      externalId: c.id,
      occurredAt: c.createdAt,
      actor: actorFrom(c.author),
      payload: { issueNumber: prNumber, surface: "pr" },
    });
  }
}

export function parsePrNode(pr: GqlPr): {
  events: ParsedEvent[];
  followUps: FollowUp[];
} {
  const events: ParsedEvent[] = [];
  const followUps: FollowUp[] = [];

  events.push({
    type: "pr",
    externalId: pr.id,
    occurredAt: pr.createdAt,
    actor: actorFrom(pr.author),
    payload: {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: !!pr.isDraft,
      mergedAt: pr.mergedAt,
      additions: pr.additions,
      deletions: pr.deletions,
    },
  });

  // A merged PR credits whoever pressed the button. The payload carries the
  // merge commit's oid so rollups can exclude that auto-generated commit —
  // one credit per merge, no double counting (see db/rollups.ts).
  if (pr.mergedAt) {
    events.push({
      type: "merge",
      externalId: `merge:${pr.id}`,
      occurredAt: pr.mergedAt,
      actor: actorFrom(pr.mergedBy),
      payload: {
        prNumber: pr.number,
        mergeCommit: pr.mergeCommit?.oid ?? null,
      },
    });
  }

  for (const review of pr.reviews.nodes) {
    reviewEvents(review, pr.number, events, followUps);
  }
  conversationCommentEvents(pr.comments.nodes, pr.number, events);

  if (pr.reviews.pageInfo.hasNextPage || pr.comments.pageInfo.hasNextPage) {
    followUps.push({
      kind: "pr_overflow",
      nodeId: pr.id,
      prNumber: pr.number,
      reviewCursor: pr.reviews.pageInfo.hasNextPage
        ? pr.reviews.pageInfo.endCursor
        : null,
      commentCursor: pr.comments.pageInfo.hasNextPage
        ? pr.comments.pageInfo.endCursor
        : null,
    });
  }

  return { events, followUps };
}

export function parsePrsPage(data: Record<string, unknown>): {
  prs: GqlPr[];
  pageInfo: PageInfo;
} {
  const conn = (data as any).repository?.pullRequests;
  if (!conn)
    return { prs: [], pageInfo: { hasNextPage: false, endCursor: null } };
  // Null slots are nodes GitHub failed to resolve (partial responses).
  const prs = (conn.nodes as Array<GqlPr | null>).filter(
    (n): n is GqlPr => n !== null,
  );
  return { prs, pageInfo: conn.pageInfo as PageInfo };
}

// Drains follow-up fetches for one page of PRs. Returns false if the budget
// ran out first (the caller then abandons the page without persisting, so the
// next invocation redoes it — idempotent upserts make that free).
async function drainFollowUps(
  ctx: SyncContext,
  followUps: FollowUp[],
  events: ParsedEvent[],
): Promise<boolean> {
  while (followUps.length > 0) {
    if (!ctx.budget.canAfford(2)) return false;
    const f = followUps.pop()!;
    if (f.kind === "pr_overflow") {
      const { data } = await githubGraphQL(
        ctx.env,
        ctx.budget,
        PR_OVERFLOW_QUERY,
        {
          id: f.nodeId,
          reviewCursor: f.reviewCursor,
          commentCursor: f.commentCursor,
        },
      );
      const node = (data as any).node as GqlPr | null;
      if (!node) continue;
      if (f.reviewCursor !== null) {
        for (const review of node.reviews.nodes) {
          reviewEvents(review, f.prNumber, events, followUps);
        }
        if (node.reviews.pageInfo.hasNextPage) {
          followUps.push({
            ...f,
            reviewCursor: node.reviews.pageInfo.endCursor,
            commentCursor: null,
          });
        }
      }
      if (f.commentCursor !== null) {
        conversationCommentEvents(node.comments.nodes, f.prNumber, events);
        if (node.comments.pageInfo.hasNextPage) {
          followUps.push({
            ...f,
            reviewCursor: null,
            commentCursor: node.comments.pageInfo.endCursor,
          });
        }
      }
    } else {
      const { data } = await githubGraphQL(
        ctx.env,
        ctx.budget,
        REVIEW_OVERFLOW_QUERY,
        { id: f.nodeId, cursor: f.commentCursor },
      );
      const node = (data as any).node as {
        comments: { pageInfo: PageInfo; nodes: GqlComment[] };
      } | null;
      if (!node) continue;
      for (const c of node.comments.nodes) {
        events.push({
          type: "comment_review",
          externalId: c.id,
          occurredAt: c.createdAt,
          actor: actorFrom(c.author),
          payload: { prNumber: f.prNumber },
        });
      }
      if (node.comments.pageInfo.hasNextPage) {
        followUps.push({
          ...f,
          commentCursor: node.comments.pageInfo.endCursor,
        });
      }
    }
  }
  return true;
}

export async function syncPrs(
  ctx: SyncContext,
  repo: RepoRef,
  state: PrsState | null,
): Promise<boolean> {
  let s: PrsState = state ?? { phase: "backfill", cursor: null, maxSeen: null };

  if (s.phase === "backfill") {
    // CREATED_AT ASC: createdAt is immutable, so the resume cursor stays
    // stable across invocations even while the repo moves.
    while (ctx.budget.canAfford(3)) {
      const { data } = await githubGraphQL(ctx.env, ctx.budget, PAGE_QUERY, {
        owner: OWNER,
        name: repo.name,
        cursor: s.cursor,
        order: "CREATED_AT",
        dir: "ASC",
      });
      const { prs, pageInfo } = parsePrsPage(data);
      const events: ParsedEvent[] = [];
      const followUps: FollowUp[] = [];
      let pageMax: string | null = s.maxSeen;
      for (const pr of prs) {
        const parsed = parsePrNode(pr);
        events.push(...parsed.events);
        followUps.push(...parsed.followUps);
        pageMax = maxIso(pageMax, pr.updatedAt);
      }
      if (!(await drainFollowUps(ctx, followUps, events))) return false;
      if (pageInfo.hasNextPage) {
        s = { phase: "backfill", cursor: pageInfo.endCursor, maxSeen: pageMax };
        await persistPage(ctx, repo.name, "prs", events, s);
      } else {
        s = {
          phase: "incremental",
          updatedSince: pageMax ?? new Date(0).toISOString(),
        };
        await persistPage(ctx, repo.name, "prs", events, s);
        return true;
      }
    }
    return false;
  }

  // Incremental: UPDATED_AT DESC, stop at the watermark. Re-upserting a whole
  // PR node catches new reviews / comments / merges on old PRs, since any of
  // those bumps the PR's updatedAt.
  let cursor: string | null = null;
  let newWatermark = s.updatedSince;
  for (;;) {
    if (!ctx.budget.canAfford(3)) return false;
    const { data } = await githubGraphQL(ctx.env, ctx.budget, PAGE_QUERY, {
      owner: OWNER,
      name: repo.name,
      cursor,
      order: "UPDATED_AT",
      dir: "DESC",
    });
    const { prs, pageInfo } = parsePrsPage(data);
    const events: ParsedEvent[] = [];
    const followUps: FollowUp[] = [];
    let sawOlder = false;
    for (const pr of prs) {
      if (pr.updatedAt < s.updatedSince) {
        sawOlder = true;
        break;
      }
      const parsed = parsePrNode(pr);
      events.push(...parsed.events);
      followUps.push(...parsed.followUps);
      newWatermark = maxIso(newWatermark, pr.updatedAt)!;
    }
    if (!(await drainFollowUps(ctx, followUps, events))) return false;
    const done = sawOlder || !pageInfo.hasNextPage;
    await persistPage(ctx, repo.name, "prs", events, {
      phase: "incremental",
      updatedSince: done ? newWatermark : s.updatedSince,
    });
    if (done) return true;
    cursor = pageInfo.endCursor;
  }
}
