import { botFilter } from "../db/queries";
import { COUNTED } from "../db/rollups";
import { addToCounts, assembleStats, weeklyFrom, type Counts } from "./stats";
import { error, json } from "./respond";

const EVENT_TYPES = new Set([
  "commit",
  "pr",
  "review",
  "merge",
  "issue",
  "comment_issue",
  "comment_review",
  "comment_commit",
]);

export async function handleContributors(
  env: Env,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const stats = await assembleStats(env, url, { withWeekly: false });
  return json({
    totals: stats["totals"],
    contributors: stats["contributors"],
  });
}

// One contributor's full object; from/to/type filters are recomputed from
// activity_events (rollups only serve the unfiltered fast path).
export async function handleContributor(
  env: Env,
  request: Request,
  login: string,
): Promise<Response> {
  const url = new URL(request.url);
  const decoded = decodeURIComponent(login);

  const row = await env.DB.prepare(
    `SELECT c.id, c.login, c.display_name, c.avatar_url, c.first_seen_at, c.last_seen_at
     FROM contributors c WHERE c.login = ?${botFilter(url)}`,
  )
    .bind(decoded)
    .first<{
      id: number;
      login: string;
      display_name: string | null;
      avatar_url: string | null;
      first_seen_at: string | null;
      last_seen_at: string | null;
    }>();
  if (!row) return error(404, `unknown contributor: ${decoded}`);

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const type = url.searchParams.get("type");
  if (type && !EVENT_TYPES.has(type)) {
    return error(400, `unknown type: ${type}`);
  }
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
    return error(400, "from/to must be YYYY-MM-DD");
  }

  // Same counted flag as the rollup recompute, so this raw-event
  // path can never disagree with the served rollup numbers.
  let sql = `SELECT type, occurred_at FROM activity_events e WHERE e.contributor_id = ? AND ${COUNTED}`;
  const params: unknown[] = [row.id];
  if (from) {
    sql += " AND occurred_at >= ?";
    params.push(`${from}T00:00:00Z`);
  }
  if (to) {
    // Inclusive end date.
    const next = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10);
    sql += " AND occurred_at < ?";
    params.push(`${next}T00:00:00Z`);
  }
  if (type) {
    sql += " AND type = ?";
    params.push(type);
  }

  const events = await env.DB.prepare(sql)
    .bind(...params)
    .all<{ type: string; occurred_at: string }>();

  const counts: Counts = {
    commits: 0,
    prs: 0,
    reviews: 0,
    issues: 0,
    comments: 0,
  };
  const dayCounts = new Map<string, Map<string, number>>();
  for (const e of events.results) {
    addToCounts(counts, e.type, 1);
    const day = e.occurred_at.slice(0, 10);
    let byType = dayCounts.get(day);
    if (!byType) {
      byType = new Map();
      dayCounts.set(day, byType);
    }
    byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  }
  const rollupLike = [...dayCounts.entries()].flatMap(([day, byType]) =>
    [...byType.entries()].map(([t, count]) => ({ day, type: t, count })),
  );

  return json({
    login: row.login,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    counts,
    weekly: weeklyFrom(rollupLike),
  });
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
