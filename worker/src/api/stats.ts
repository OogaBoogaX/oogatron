import { RECENT_FETCH, retainRecent, shortGroups } from "../db/recent";
import { botFilter } from "../db/queries";
import { COUNTED } from "../db/rollups";
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
  event_key: string;
  login: string;
  repo: string;
  contributor_id: number;
  type: string;
  occurred_at: string;
  payload: string | null;
}

// Read compact display facts, never archival API payloads. Keep exact timing
// until all type-filter windows have been selected in retainRecent.
const RECENT_COLUMNS = `e.repo || '/' || e.external_id AS event_key,
  c.login, e.repo, e.contributor_id, e.type, e.occurred_at,
  CASE WHEN json_valid(e.payload) AND json_extract(e.payload, '$.draft') = 1
       THEN '{"draft":true}' ELSE NULL END AS payload`;

// More short groups than this and one full pass is cheaper than a statement
// each (and stays far inside D1's per-invocation query limit).
const SHORT_MAX = 40;

// The feed's candidates: each (repo, contributor, raw type)'s newest counted
// events back to its RECENT_FETCH-th newest timestamp (ties included), one
// range on idx_events_counted_recent each, rather than every counted event in
// history; the groups are the rollups' (exactly the pairs and types with
// counted events). shortGroups (db/recent.ts) says which groups that bound
// might have cut short, and those are read whole, so retainRecent keeps
// exactly what it would from all history.
function recentStatement(env: Env, url: URL): D1PreparedStatement {
  return env.DB.prepare(
    `WITH k AS MATERIALIZED (
       SELECT g.repo, g.contributor_id, g.type, COALESCE((
         SELECT x.occurred_at FROM activity_events x
         WHERE x.repo = g.repo AND x.contributor_id = g.contributor_id
           AND x.type = g.type AND x.counted = 1
         ORDER BY x.occurred_at DESC LIMIT 1 OFFSET ${RECENT_FETCH - 1}), '') AS since
       FROM (SELECT DISTINCT r.repo, r.contributor_id, r.type
             FROM daily_rollups r JOIN contributors c ON c.id = r.contributor_id
             WHERE 1=1${botFilter(url)}) g)
     SELECT ${RECENT_COLUMNS}
     FROM k CROSS JOIN activity_events e
       ON e.repo = k.repo AND e.contributor_id = k.contributor_id
      AND e.type = k.type AND e.counted = 1 AND e.occurred_at >= k.since
     JOIN contributors c ON c.id = e.contributor_id`,
  );
}

async function recentRows(env: Env, url: URL, rows: RecentRow[]) {
  const short = shortGroups(rows);
  if (short.length === 0) return rows;
  if (short.length > SHORT_MAX) {
    const all = await env.DB.prepare(
      `SELECT ${RECENT_COLUMNS}
       FROM activity_events e JOIN contributors c ON c.id = e.contributor_id
       WHERE ${COUNTED}${botFilter(url)}`,
    ).all<RecentRow>();
    return all.results;
  }
  const whole = await env.DB.batch<RecentRow>(
    short.map((g) =>
      env.DB.prepare(
        `SELECT ${RECENT_COLUMNS}
         FROM activity_events e JOIN contributors c ON c.id = e.contributor_id
         WHERE e.repo = ? AND e.contributor_id = ? AND e.type = ? AND ${COUNTED}`,
      ).bind(g.repo, g.contributor_id, g.type),
    ),
  );
  const replaced = new Set(
    short.map((g) => JSON.stringify([g.repo, g.contributor_id, g.type])),
  );
  return rows
    .filter(
      (r) => !replaced.has(JSON.stringify([r.repo, r.contributor_id, r.type])),
    )
    .concat(whole.flatMap((res) => res.results));
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
  merges: number;
}

function emptyCounts(): Counts {
  return { commits: 0, prs: 0, reviews: 0, issues: 0, comments: 0, merges: 0 };
}

// Merges are their own count, as the merge commit is its author's commit on
// the default branch (db/rollups.ts). All comment surfaces fold into one
// comments number; opening an issue is its own count.
export function addToCounts(counts: Counts, type: string, n: number): void {
  if (type === "commit") counts.commits += n;
  else if (type === "merge") counts.merges += n;
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
  merges: number;
}

export function weeklyFrom(
  rows: Array<{ day: string; type: string; count: number }>,
): WeeklyBucket[] {
  const byWeek = new Map<string, WeeklyBucket>();
  for (const r of rows) {
    const week = isoWeek(r.day);
    let b = byWeek.get(week);
    if (!b) {
      b = {
        week,
        commits: 0,
        prs: 0,
        reviews: 0,
        issues: 0,
        comments: 0,
        merges: 0,
      };
      byWeek.set(week, b);
    }
    if (r.type === "commit") b.commits += r.count;
    else if (r.type === "merge") b.merges += r.count;
    else if (r.type === "pr") b.prs += r.count;
    else if (r.type === "review") b.reviews += r.count;
    else if (r.type === "issue") b.issues += r.count;
    else if (r.type.startsWith("comment_")) b.comments += r.count;
  }
  return [...byWeek.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
}

// The v2 contract predates comment, issue and merge tracking, so its
// notions ignore all three; v3 orders by everything.
const totalV2 = (c: Counts): number => c.commits + c.prs + c.reviews;
const totalV3 = (c: Counts): number =>
  totalV2(c) + c.issues + c.comments + c.merges;

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
  // Everyone with tracked activity, contributions or not.
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
      // A bucket's tally is what its events count for (db/rollups.ts
      // TALLIED); the bucket itself, tally or not, is activity.
      env.DB.prepare(
        `SELECT r.repo, r.contributor_id, r.day, r.type, r.tally AS count
       FROM daily_rollups r JOIN contributors c ON c.id = r.contributor_id
       WHERE 1=1${botFilter(url)}`,
      ),
      recentStatement(env, url),
      // Each repo's latest event of any kind, walked back from the newest on
      // idx_events_repo_time only as far as the first non-bot one. Repos come
      // from the rollups, which hold every repo a slice can be built for.
      env.DB.prepare(
        `SELECT p.repo, (
         SELECT e.occurred_at
         FROM activity_events e JOIN contributors c ON c.id = e.contributor_id
         WHERE e.repo = p.repo${botFilter(url)}
         ORDER BY e.occurred_at DESC LIMIT 1) AS at
       FROM (SELECT DISTINCT repo FROM daily_rollups) p
       ORDER BY p.repo`,
      ),
      // Per-repo per-contributor last activity: what lets the island route a
      // clanking Ooga to the cave of the repo they actually contributed to.
      // The pairs are the rollups' (every pair with a counted event), so
      // membership is identical by construction to the rollup-derived
      // repos[].totals.contributors and consumers may assert the two align;
      // each pair's latest counted event is one seek on
      // idx_events_counted_pair_time rather than a scan of every event.
      env.DB.prepare(
        `SELECT p.repo, c.login, (
         SELECT MAX(e.occurred_at) FROM activity_events e
         WHERE e.repo = p.repo AND e.contributor_id = p.contributor_id
           AND ${COUNTED}) AS at
       FROM (SELECT DISTINCT repo, contributor_id FROM daily_rollups) p
       JOIN contributors c ON c.id = p.contributor_id
       WHERE 1=1${botFilter(url)}
       ORDER BY p.repo, p.contributor_id`,
      ),
    ]);
  const contributors = contribRes.results as unknown as ContributorRow[];
  const rollups = rollupRes.results as unknown as RollupRow[];
  const recent = retainRecent(
    await recentRows(env, url, recentRes.results as unknown as RecentRow[]),
  );
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
  const active = new Set<number>();
  for (const r of rollups) {
    active.add(r.contributor_id);
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

  // "Total contributors" = union of humans with >=1 tracked event (or
  // everyone with events under ?include_bots=1), whether or not any of it
  // counts as a contribution yet — not the roster row count and not GitHub's
  // commit-only number. v2 keeps its own notion over its three counts.
  const all = [...perContributor.values()];
  return {
    totals,
    activeV2: all.filter((pc) => totalV2(pc.counts) > 0).length,
    activeV3: active.size,
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
        counts["merges"] = pc.counts.merges;
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
          : weekly.map(({ issues: _i, comments: _c, merges: _m, ...w }) => w);
      }
      return obj;
    })
    .sort((a, b) => {
      const ta = total({
        issues: 0,
        comments: 0,
        merges: 0,
        ...(a["counts"] as object),
      } as Counts);
      const tb = total({
        issues: 0,
        comments: 0,
        merges: 0,
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
          ({ issues: _i, comments: _c, merges: _m, ...w }) => w,
        ),
      }))
      .sort(
        (a, b) =>
          totalV2({
            issues: 0,
            comments: 0,
            merges: 0,
            ...b.totals,
          } as Counts) -
            totalV2({
              issues: 0,
              comments: 0,
              merges: 0,
              ...a.totals,
            } as Counts) || (a.name < b.name ? -1 : 1),
      ),
    contributors: contributorObjs(model, {
      withWeekly: opts.withWeekly,
      withComments: false,
    }),
  };
}

// Schema 3, served on /v2/stats: comments and merges (each its own count)
// everywhere, commits counted once on the default branch, per-repo
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
      merges: leaderboardFor(model.contributors, countsOf, (c) => c.merges),
    },
    repos: [...model.perRepo.entries()]
      .map(([name, slice]) => {
        const repoCountsOf = (id: number) => slice.perContributor.get(id);
        return {
          name,
          totals: {
            contributors: slice.perContributor.size,
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
            merges: leaderboardFor(
              model.contributors,
              repoCountsOf,
              (c) => c.merges,
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
        event_key: r.event_key,
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
