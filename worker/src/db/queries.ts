import type { EventType } from "../sync/types";

export interface ResolvedEvent {
  login: string;
  type: EventType;
  externalId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

// The DO UPDATE is guarded so re-upserting an unchanged event (incremental
// overlap windows re-fetch the same pages every run) writes nothing and
// reports zero changes — which is what lets a quiet sync skip the rollup
// rebuild.
//
// Multi-row upserts chunked to stay well under D1's ~100 bound-parameter
// limit per statement (6 params per row).
const EVENT_CHUNK = 10;

export function eventUpsertStatements(
  db: D1Database,
  repo: string,
  events: ResolvedEvent[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < events.length; i += EVENT_CHUNK) {
    const chunk = events.slice(i, i + EVENT_CHUNK);
    const values = chunk
      .map(
        () => "(?, (SELECT id FROM contributors WHERE login = ?), ?, ?, ?, ?)",
      )
      .join(", ");
    const params = chunk.flatMap((e) => [
      repo,
      e.login,
      e.type,
      e.externalId,
      e.occurredAt,
      JSON.stringify(e.payload),
    ]);
    statements.push(
      db
        .prepare(
          `INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at, payload)
           VALUES ${values}
           ON CONFLICT(repo, external_id) DO UPDATE SET
             contributor_id = excluded.contributor_id,
             occurred_at    = excluded.occurred_at,
             payload        = excluded.payload
           WHERE contributor_id IS NOT excluded.contributor_id
              OR occurred_at    IS NOT excluded.occurred_at
              OR payload        IS NOT excluded.payload`,
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
    .bind(repo, source, JSON.stringify(cursor), new Date().toISOString());
}

export function stateKey(repo: string, source: string): string {
  return `${repo}/${source}`;
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
