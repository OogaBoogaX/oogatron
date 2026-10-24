import { STALE_RUN_MINUTES } from "../config";
import { json } from "./respond";

// Last sync run + cursors + row counts: the primary verification surface for
// checking ingested totals against the GitHub UI. Cursors and event counts
// are broken out per repo so backfill progress is visible repo by repo.
export async function handleHealth(env: Env): Promise<Response> {
  const [
    lastRun,
    state,
    byType,
    byRepo,
    repoRows,
    contribs,
    rollups,
    lastSuccess,
  ] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1"),
    env.DB.prepare("SELECT repo, source, cursor, updated_at FROM sync_state"),
    env.DB.prepare(
      "SELECT type, COUNT(*) AS n FROM activity_events GROUP BY type",
    ),
    env.DB.prepare(
      "SELECT repo, type, COUNT(*) AS n FROM activity_events GROUP BY repo, type",
    ),
    env.DB.prepare(
      "SELECT name, default_branch, is_active, last_checked_at FROM repos ORDER BY name",
    ),
    env.DB.prepare(
      "SELECT is_bot, COUNT(*) AS n FROM contributors GROUP BY is_bot",
    ),
    env.DB.prepare("SELECT COUNT(*) AS n FROM daily_rollups"),
    env.DB.prepare(
      `SELECT MAX(finished_at) AS at FROM sync_runs WHERE status = 'ok'
         AND CASE WHEN json_valid(detail) THEN json_extract(detail, '$.error') IS NULL
           ELSE detail IS NULL END`,
    ),
  ]);

  const events: Record<string, number> = {};
  for (const r of byType.results as Array<{ type: string; n: number }>) {
    events[r.type] = r.n;
  }
  const eventsByRepo: Record<string, Record<string, number>> = {};
  for (const r of byRepo.results as Array<{
    repo: string;
    type: string;
    n: number;
  }>) {
    (eventsByRepo[r.repo] ??= {})[r.type] = r.n;
  }
  const contributors = { human: 0, bot: 0 };
  for (const r of contribs.results as Array<{ is_bot: number; n: number }>) {
    if (r.is_bot) contributors.bot = r.n;
    else contributors.human = r.n;
  }

  const last = (lastRun.results[0] ?? null) as Record<string, unknown> | null;
  if (last && typeof last["detail"] === "string") {
    try {
      last["detail"] = JSON.parse(last["detail"]);
    } catch {
      // leave as text
    }
  }

  const now = Date.now();
  const ageSeconds = (at: unknown): number | null => {
    const time = typeof at === "string" ? Date.parse(at) : NaN;
    return Number.isFinite(time)
      ? Math.max(0, Math.floor((now - time) / 1000))
      : null;
  };
  const lastSuccessAt = (lastSuccess.results[0] as { at: string | null }).at;
  const successAge = ageSeconds(lastSuccessAt);
  const staleAfter = STALE_RUN_MINUTES * 60;
  const stale = successAge === null || successAge > staleAfter;
  const detail = last?.["detail"] as { error?: unknown } | null;

  return json({
    last_run: last,
    // generated_at says when this response was assembled. This separately
    // reports ingestion health; quiet GitHub activity does not make it stale.
    freshness: {
      healthy: !stale && last?.["status"] !== "error" && !detail?.error,
      stale,
      stale_after_seconds: staleAfter,
      last_attempt_at: last?.["started_at"] ?? null,
      last_success_at: lastSuccessAt,
      last_success_age_seconds: successAge,
    },
    repos: repoRows.results,
    sync_state: Object.fromEntries(
      (
        state.results as Array<{
          repo: string;
          source: string;
          cursor: string | null;
          updated_at: string;
        }>
      ).map((r) => [
        `${r.repo}/${r.source}`,
        {
          cursor: r.cursor === null ? null : JSON.parse(r.cursor),
          updated_at: r.updated_at,
          // This is when a page/check was persisted, not its event watermark.
          age_seconds: ageSeconds(r.updated_at),
        },
      ]),
    ),
    counts: {
      contributors,
      events,
      events_by_repo: eventsByRepo,
      daily_rollups: (rollups.results[0] as { n: number }).n,
    },
  });
}
