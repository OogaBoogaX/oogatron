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
}

// Persists one page atomically: contributor upserts, event upserts, and the
// sync_state cursor advance all land in a single db.batch — a crash can never
// persist a cursor without its page's events. Costs 1 subrequest.
export async function persistPage(
  ctx: SyncContext,
  repo: string,
  source: string,
  events: ParsedEvent[],
  newState: unknown,
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
    });
  }
  const eventsFrom = statements.length;
  statements.push(...eventUpsertStatements(ctx.db, repo, resolved));
  const eventsTo = statements.length;
  statements.push(syncStateUpsert(ctx.db, repo, source, newState));
  ctx.budget.spend();
  const results = await ctx.db.batch(statements);
  // Count rows actually inserted or changed, not rows sent: overlap windows
  // re-send unchanged events every run, and counting those would trigger a
  // full rollup rebuild on every tick.
  for (let i = eventsFrom; i < eventsTo; i++) {
    ctx.eventsWritten += results[i].meta.changes ?? 0;
  }
}

export function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
