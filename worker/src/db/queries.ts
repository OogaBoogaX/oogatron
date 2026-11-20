import type { EventType } from "../sync/types";
import { canonicalRepoName } from "../config";

export interface ResolvedEvent {
  login: string;
  type: EventType;
  externalId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  landed?: boolean;
}

// The DO UPDATE is guarded so re-upserting an unchanged event (incremental
// overlap windows re-fetch the same pages every run) writes nothing and
// returns no row — which is what lets a quiet sync skip the rollup
// reconcile. RETURNING names exactly the events inserted or changed;
// meta.changes would also count what migration 0012's triggers write.
//
// landed only ever rises: a walker that reaches a commit from a PR branch
// knows nothing about whether the default branch holds it too.
//
// Multi-row upserts chunked to stay well under D1's ~100 bound-parameter
// limit per statement (7 params per row).
const EVENT_CHUNK = 10;

export function eventUpsertStatements(
  db: D1Database,
  repo: string,
  events: ResolvedEvent[],
): D1PreparedStatement[] {
  repo = canonicalRepoName(repo);
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < events.length; i += EVENT_CHUNK) {
    const chunk = events.slice(i, i + EVENT_CHUNK);
    const values = chunk
      .map(
        () =>
          "(?, (SELECT id FROM contributors WHERE login = ?), ?, ?, ?, ?, ?)",
      )
      .join(", ");
    const params = chunk.flatMap((e) => [
      repo,
      e.login,
      e.type,
      e.externalId,
      e.occurredAt,
      JSON.stringify(e.payload),
      e.landed ? 1 : 0,
    ]);
    statements.push(
      db
        .prepare(
          `INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at, payload, landed)
           VALUES ${values}
           ON CONFLICT(repo, external_id) DO UPDATE SET
             contributor_id = excluded.contributor_id,
             occurred_at    = excluded.occurred_at,
             payload        = excluded.payload,
             landed         = CASE WHEN excluded.landed = 1 THEN 1 ELSE activity_events.landed END
           WHERE contributor_id IS NOT excluded.contributor_id
              OR occurred_at    IS NOT excluded.occurred_at
              OR payload        IS NOT excluded.payload
              OR (excluded.landed = 1 AND activity_events.landed IS NOT 1)
           RETURNING id`,
        )
        .bind(...params),
    );
  }
  return statements;
}

export function syncStateUpsert(
  db: D1Database,
  repo: string,
  source: string,
  cursor: unknown,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sync_state (repo, source, cursor, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(repo, source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    )
    .bind(
      canonicalRepoName(repo),
      source,
      JSON.stringify(cursor),
      new Date().toISOString(),
    );
}

export function stateKey(repo: string, source: string): string {
  return `${canonicalRepoName(repo)}/${source}`;
}

export async function loadSyncState(
  db: D1Database,
): Promise<Map<string, unknown>> {
  const rows = await db
    .prepare("SELECT repo, source, cursor FROM sync_state")
    .all<{ repo: string; source: string; cursor: string | null }>();
  const map = new Map<string, unknown>();
  for (const r of rows.results) {
    map.set(
      stateKey(r.repo, r.source),
      r.cursor === null ? null : JSON.parse(r.cursor),
    );
  }
  return map;
}

// Every API query over contributors appends this so no endpoint can forget
// bot exclusion. Default excludes bots; ?include_bots=1 overrides.
export function botFilter(url: URL, alias = "c"): string {
  return url.searchParams.get("include_bots") === "1"
    ? ""
    : ` AND ${alias}.is_bot = 0`;
}
