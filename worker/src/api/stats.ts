import { botFilter } from "../db/queries";
import { MERGE_COMMIT_EXCLUSION } from "../db/rollups";
import { isoWeek } from "../util/isoweek";
import { json } from "./respond";

interface ContributorRow {
  id: number;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

interface RollupRow {
  repo: string;
  contributor_id: number;
  day: string;
  type: string;
  count: number;
}

interface RecentRow {
  login: string;
  repo: string;
  type: string;
  occurred_at: string;
  payload: string | null;
}

interface LastActivityRow {
  repo: string;
  at: string;
}

interface RepoContributorRow {
  repo: string;
  login: string;
  at: string;
}

export interface Counts {
  commits: number;
  prs: number;
  reviews: number;
  issues: number;
  comments: number;
}

function emptyCounts(): Counts {
  return { commits: 0, prs: 0, reviews: 0, issues: 0, comments: 0 };
}

// Merges fold into commits ("Top Commits" credits the merger; the merge
// commit itself was excluded at rollup time). All comment surfaces fold into
// one comments number; opening an issue is its own count.
export function addToCounts(counts: Counts, type: string, n: number): void {
  if (type === "commit" || type === "merge") counts.commits += n;
  else if (type === "pr") counts.prs += n;
  else if (type === "review") counts.reviews += n;
  else if (type === "issue") counts.issues += n;
  else if (type.startsWith("comment_")) counts.comments += n;
}

interface WeeklyBucket {
  week: string;
  commits: number;
  prs: number;
  reviews: number;
  issues: number;
  comments: number;
}

export function weeklyFrom(
  rows: Array<{ day: string; type: string; count: number }>,
): WeeklyBucket[] {
  const byWeek = new Map<string, WeeklyBucket>();
  for (const r of rows) {
    const week = isoWeek(r.day);
    let b = byWeek.get(week);
    if (!b) {
      b = { week, commits: 0, prs: 0, reviews: 0, issues: 0, comments: 0 };
      byWeek.set(week, b);
    }
    if (r.type === "commit" || r.type === "merge") b.commits += r.count;
    else if (r.type === "pr") b.prs += r.count;
    else if (r.type === "review") b.reviews += r.count;
    else if (r.type === "issue") b.issues += r.count;
    else if (r.type.startsWith("comment_")) b.comments += r.count;
  }
  return [...byWeek.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
}

// The v2 contract predates comment and issue tracking, so its activity
// notions ignore both entirely; v3 counts everything.
const totalV2 = (c: Counts): number => c.commits + c.prs + c.reviews;
const totalV3 = (c: Counts): number => totalV2(c) + c.issues + c.comments;

// Recent-feed labels collapse the three comment surfaces into one word.
const recentType = (type: string): string =>
  type.startsWith("comment_") ? "comment" : type;

interface RepoSlice {
  counts: Counts;
  perContributor: Map<number, Counts>;
  rollups: RollupRow[];
  lastActivityAt: string | null;
  contributorActivity: Array<{ login: string; last_seen_at: string }>;
}

interface StatsModel {
  totals: Counts;
  activeV2: number;
  activeV3: number;
  contributors: ContributorRow[];
  perContributor: Map<number, { counts: Counts; rollups: RollupRow[] }>;
  perRepo: Map<string, RepoSlice>;
  recent: RecentRow[];
}

// One read for both served shapes: /v1/stats (schema 2) and /v2/stats
// (schema 3) project from this model, so the two contracts can never drift.
async function assembleModel(env: Env, url: URL): Promise<StatsModel> {
  const [contribRes, rollupRes, recentRes, lastRes, repoContribRes] =
    await env.DB.batch([
      env.DB.prepare(
        `SELECT c.id, c.login, c.display_name, c.avatar_url, c.first_seen_at, c.last_seen_at
       FROM contributors c WHERE 1=1${botFilter(url)}
       ORDER BY c.login`,
      ),
      env.DB.prepare(
        `SELECT r.repo, r.contributor_id, r.day, r.type, r.count
       FROM daily_rollups r JOIN contributors c ON c.id = r.contributor_id
       WHERE 1=1${botFilter(url)}`,
      ),
      // The recent feed reads raw events (rollups are day-grained); the same
      // merge-commit exclusion keeps a merged PR from showing twice.
      env.DB.prepare(
        `SELECT c.login, e.repo, e.type, e.occurred_at, e.payload
       FROM activity_events e JOIN contributors c ON c.id = e.contributor_id
       WHERE ${MERGE_COMMIT_EXCLUSION}${botFilter(url)}
       ORDER BY e.occurred_at DESC LIMIT 12`,
      ),
      env.DB.prepare(
        `SELECT e.repo, MAX(e.occurred_at) AS at
       FROM activity_events e JOIN contributors c ON c.id = e.contributor_id
       WHERE 1=1${botFilter(url)}
       GROUP BY e.repo`,
      ),
      // Per-repo per-contributor last activity: what lets the island route a
      // clanking Ooga to the cave of the repo they actually contributed to.
      // The merge-commit exclusion keeps membership identical by construction
      // to the rollup-derived repos[].totals.contributors, so consumers may
      // assert the two counts align.
      env.DB.prepare(
        `SELECT e.repo, c.login, MAX(e.occurred_at) AS at
       FROM activity_events e JOIN contributors c ON c.id = e.contributor_id
       WHERE ${MERGE_COMMIT_EXCLUSION}${botFilter(url)}
       GROUP BY e.repo, e.contributor_id`,
      ),
    ]);
  const contributors = contribRes.results as unknown as ContributorRow[];
  const rollups = rollupRes.results as unknown as RollupRow[];
  const recent = recentRes.results as unknown as RecentRow[];
  const lastActivity = lastRes.results as unknown as LastActivityRow[];
  const repoContributors =
    repoContribRes.results as unknown as RepoContributorRow[];

  const totals = emptyCounts();
  const perContributor = new Map<
    number,
    { counts: Counts; rollups: RollupRow[] }
  >();
  const perRepo = new Map<string, RepoSlice>();
  for (const c of contributors) {
    perContributor.set(c.id, { counts: emptyCounts(), rollups: [] });
  }
  for (const r of rollups) {
    addToCounts(totals, r.type, r.count);
    const pc = perContributor.get(r.contributor_id);
    if (pc) {
      addToCounts(pc.counts, r.type, r.count);
      pc.rollups.push(r);
    }
    let slice = perRepo.get(r.repo);
    if (!slice) {
      slice = {
        counts: emptyCounts(),
        perContributor: new Map(),
        rollups: [],
        lastActivityAt: null,
        contributorActivity: [],
      };
      perRepo.set(r.repo, slice);
    }
    addToCounts(slice.counts, r.type, r.count);
    let rc = slice.perContributor.get(r.contributor_id);
    if (!rc) {
      rc = emptyCounts();
      slice.perContributor.set(r.contributor_id, rc);
    }
    addToCounts(rc, r.type, r.count);
    slice.rollups.push(r);
  }
  for (const row of lastActivity) {
    const slice = perRepo.get(row.repo);
    if (slice) slice.lastActivityAt = row.at;
  }
  for (const row of repoContributors) {
    const slice = perRepo.get(row.repo);
    if (slice)
      slice.contributorActivity.push({
        login: row.login,
        last_seen_at: row.at,
      });
  }

  // "Total contributors" = union of humans with >=1 qualifying event (or
  // everyone with events under ?include_bots=1) — not the roster row count
  // and not GitHub's commit-only number.
  const all = [...perContributor.values()];
  return {
    totals,
    activeV2: all.filter((pc) => totalV2(pc.counts) > 0).length,
    activeV3: all.filter((pc) => totalV3(pc.counts) > 0).length,
    contributors,
    perContributor,
    perRepo,
    recent,
  };
}

function leaderboardFor(
  contributors: ContributorRow[],
  countsOf: (id: number) => Counts | undefined,
  metric: (c: Counts) => number,
): Array<{ login: string; count: number }> {
  return contributors
    .map((c) => ({
      login: c.login,
      count: metric(countsOf(c.id) ?? emptyCounts()),
    }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count || (a.login < b.login ? -1 : 1));
}

function contributorObjs(
  model: StatsModel,
  opts: { withWeekly: boolean; withComments: boolean },
): Array<Record<string, unknown>> {
  const total = opts.withComments ? totalV3 : totalV2;
  return model.contributors
    .map((c) => {
      const pc = model.perContributor.get(c.id)!;
      const counts: Record<string, number> = {
        commits: pc.counts.commits,
        prs: pc.counts.prs,
        reviews: pc.counts.reviews,
      };
      if (opts.withComments) {
        counts["issues"] = pc.counts.issues;
        counts["comments"] = pc.counts.comments;
      }
      const obj: Record<string, unknown> = {
        login: c.login,
        display_name: c.display_name,
        avatar_url: c.avatar_url,
        first_seen_at: c.first_seen_at,
        last_seen_at: c.last_seen_at,
        counts,
      };
      if (opts.withWeekly) {
        const weekly = weeklyFrom(pc.rollups);
        obj["weekly"] = opts.withComments
          ? weekly
          : weekly.map(({ issues: _i, comments: _c, ...w }) => w);
      }
      return obj;
    })
    .sort((a, b) => {
      const ta = total({
        issues: 0,
        comments: 0,
        ...(a["counts"] as object),
      } as Counts);
      const tb = total({
        issues: 0,
        comments: 0,
        ...(b["counts"] as object),
      } as Counts);
      return (
        tb - ta || ((a["login"] as string) < (b["login"] as string) ? -1 : 1)
      );
    });
}

// The pre-comments contract, served on /v1/stats until every consumer moves
// to /v2: same fields as before, comment activity invisible.
export function shapeV2(
  model: StatsModel,
  opts: { withWeekly: boolean },
): Record<string, unknown> {
  const countsOf = (id: number) => model.perContributor.get(id)?.counts;
  return {
    totals: {
      contributors: model.activeV2,
      commits: model.totals.commits,
      prs: model.totals.prs,
      reviews: model.totals.reviews,
    },
    leaderboards: {
      commits: leaderboardFor(model.contributors, countsOf, (c) => c.commits),
      prs: leaderboardFor(model.contributors, countsOf, (c) => c.prs),
      reviews: leaderboardFor(model.contributors, countsOf, (c) => c.reviews),
    },
    repos: [...model.perRepo.entries()]
      .filter(([, slice]) => totalV2(slice.counts) > 0)
      .map(([name, slice]) => ({
        name,
        totals: {
          contributors: [...slice.perContributor.values()].filter(
            (c) => totalV2(c) > 0,
          ).length,
          commits: slice.counts.commits,
          prs: slice.counts.prs,
          reviews: slice.counts.reviews,
        },
        weekly: weeklyFrom(slice.rollups).map(
          ({ issues: _i, comments: _c, ...w }) => w,
        ),
      }))
      .sort(
        (a, b) =>
          totalV2({ issues: 0, comments: 0, ...b.totals } as Counts) -
            totalV2({ issues: 0, comments: 0, ...a.totals } as Counts) ||
          (a.name < b.name ? -1 : 1),
      ),
    contributors: contributorObjs(model, {
      withWeekly: opts.withWeekly,
      withComments: false,
    }),
  };
}

// Schema 3, served on /v2/stats: comments and merges everywhere, per-repo
// leaderboards for the jumbotron's per-repo boards, last_activity_at for its
// seven-day display filter, and the recent-contributions feed.
export function shapeV3(model: StatsModel): Record<string, unknown> {
  const countsOf = (id: number) => model.perContributor.get(id)?.counts;
  return {
    totals: { contributors: model.activeV3, ...model.totals },
    leaderboards: {
      commits: leaderboardFor(model.contributors, countsOf, (c) => c.commits),
      prs: leaderboardFor(model.contributors, countsOf, (c) => c.prs),
      reviews: leaderboardFor(model.contributors, countsOf, (c) => c.reviews),
      comments: leaderboardFor(model.contributors, countsOf, (c) => c.comments),
      issues: leaderboardFor(model.contributors, countsOf, (c) => c.issues),
    },
    repos: [...model.perRepo.entries()]
      .map(([name, slice]) => {
        const repoCountsOf = (id: number) => slice.perContributor.get(id);
        return {
          name,
          totals: {
            contributors: [...slice.perContributor.values()].filter(
              (c) => totalV3(c) > 0,
            ).length,
            ...slice.counts,
          },
          weekly: weeklyFrom(slice.rollups),
          last_activity_at: slice.lastActivityAt,
          contributors: slice.contributorActivity,
          leaderboards: {
            commits: leaderboardFor(
              model.contributors,
              repoCountsOf,
              (c) => c.commits,
            ),
            prs: leaderboardFor(model.contributors, repoCountsOf, (c) => c.prs),
            reviews: leaderboardFor(
              model.contributors,
              repoCountsOf,
              (c) => c.reviews,
            ),
            comments: leaderboardFor(
              model.contributors,
              repoCountsOf,
              (c) => c.comments,
            ),
            issues: leaderboardFor(
              model.contributors,
              repoCountsOf,
              (c) => c.issues,
            ),
          },
        };
      })
      .sort(
        (a, b) =>
          totalV3(b.totals as unknown as Counts) -
            totalV3(a.totals as unknown as Counts) ||
          (a.name < b.name ? -1 : 1),
      ),
    recent: model.recent.map((r) => {
      const row: Record<string, unknown> = {
        login: r.login,
        repo: r.repo,
        type: recentType(r.type),
        occurred_at: r.occurred_at,
      };
      // A draft PR keeps type "pr" (additive contract); the flag lets the
      // ticker label it DRAFT PR. The payload tracks the PR's current state,
      // so the tag clears when the PR is marked ready.
      if (r.type === "pr" && r.payload) {
        try {
          if (JSON.parse(r.payload).draft === true) row["draft"] = true;
        } catch {
          // tolerate malformed payload rows; the flag just stays off
        }
      }
      return row;
    }),
    contributors: contributorObjs(model, {
      withWeekly: true,
      withComments: true,
    }),
  };
}

// Kept for /v1/contributors, which serves the v2 projection of the model.
export async function assembleStats(
  env: Env,
  url: URL,
  opts: { withWeekly: boolean },
): Promise<Record<string, unknown>> {
  return shapeV2(await assembleModel(env, url), opts);
}

export async function handleStats(
  env: Env,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  return json(
    shapeV2(await assembleModel(env, url), { withWeekly: true }),
    undefined,
    2,
  );
}

export async function handleStatsV3(
  env: Env,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  return json(shapeV3(await assembleModel(env, url)), undefined, 3);
}
