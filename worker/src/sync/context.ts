import type { Budget } from "./budget";
import type { ContributorResolver } from "./identity";
import type { ParsedEvent } from "./types";
import type { ResolvedEvent } from "../db/queries";
import { eventUpsertStatements, syncStateUpsert } from "../db/queries";

export interface SyncContext {
  env: Env;
  db: D1Database;
  budget: Budget;
  resolver: ContributorResolver;
  eventsWritten: number;
  // Contributor rows a page actually changed: the stats show them, so the
  // response cache is bumped for these too (api/cache.ts).
  contributorsChanged?: number;
}

// Persists one page atomically: contributor upserts, event upserts, any extra
// event writes, and the sync_state cursor advance all land in a single
// db.batch — a crash can never persist a cursor without its page's events.
// An extra statement names the events it changed with RETURNING, as the
// upserts do. Costs 1 subrequest.
export async function persistPage(
  ctx: SyncContext,
  repo: string,
  source: string,
  events: ParsedEvent[],
  newState: unknown,
  extra: D1PreparedStatement[] = [],
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  const resolved: ResolvedEvent[] = [];
  for (const e of events) {
    const login = await ctx.resolver.resolve(
      ctx.db,
      e.actor,
      e.occurredAt,
      statements,
    );
    resolved.push({
      login,
      type: e.type,
      externalId: e.externalId,
      occurredAt: e.occurredAt,
      payload: e.payload,
      landed: e.landed,
    });
  }
  const eventsFrom = statements.length;
  statements.push(...eventUpsertStatements(ctx.db, repo, resolved), ...extra);
  const eventsTo = statements.length;
  statements.push(syncStateUpsert(ctx.db, repo, source, newState));
  ctx.budget.spend();
  const results = await ctx.db.batch(statements);
  // Count rows actually inserted or changed, not rows sent: overlap windows
  // re-send unchanged events every run, and counting those would reconcile
  // the rollups on every tick. Each such row comes back from RETURNING.
  for (let i = eventsFrom; i < eventsTo; i++) {
    ctx.eventsWritten += results[i].results.length;
  }
  for (let i = 0; i < eventsFrom; i++) {
    ctx.contributorsChanged =
      (ctx.contributorsChanged ?? 0) + (results[i].meta.changes ?? 0);
  }
}

export function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
