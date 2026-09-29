import { STALE_RUN_MINUTES, SYNC_RUNS_RETENTION_DAYS } from "../config";
import { loadSyncState, stateKey, syncStateUpsert } from "../db/queries";
import { recomputeRollups } from "../db/rollups";
import { bumpCacheGeneration } from "../api/cache";
import { Budget } from "./budget";
import { reconcileBots } from "./bots";
import { activeRepos } from "./repos";
import { syncCommits, type CommitsState } from "./commits";
import { syncPrs, type PrsState } from "./prs";
import {
  syncCommitComments,
  syncIssueComments,
  type CommitCommentsState,
  type IssuesState,
} from "./comments";
import { ContributorResolver } from "./identity";
import { RateLimited } from "./github";
import type { RepoRef } from "./types";
import type { SyncContext } from "./context";

export interface SyncResult {
  skipped: boolean;
  done: boolean;
  kind: "backfill" | "incremental";
  eventsWritten: number;
  budgetSpent: number;
}

// The fairness pointer lives in sync_state under a repo name no real repo can
// have; it records which repo led the last run's rotation.
const ROTATION_REPO = "*";
const ROTATION_SOURCE = "rotation";

function isBackfilling(state: Map<string, unknown>, repos: RepoRef[]): boolean {
  return repos.some((repo) =>
    ["commits", "prs", "issue_comments"].some((s) => {
      const v = state.get(stateKey(repo.name, s)) as
        { phase?: string } | null | undefined;
      return !v || v.phase === "backfill";
    }),
  );
}

// Round-robin: start after the repo that led last time, so one repo mid-
// backfill eating the whole budget delays the others by at most one cron
// tick, never forever.
function rotated(repos: RepoRef[], lastLead: string | null): RepoRef[] {
  const i = lastLead ? repos.findIndex((r) => r.name === lastLead) : -1;
  if (i < 0) return repos;
  return [...repos.slice(i + 1), ...repos.slice(0, i + 1)];
}

export async function runSync(
  env: Env,
  trigger: "cron" | "admin",
): Promise<SyncResult> {
  const db = env.DB;
  const now = new Date().toISOString();
  const staleBefore = new Date(
    Date.now() - STALE_RUN_MINUTES * 60000,
  ).toISOString();

  // Stale-run guard: a row stuck 'running' past the window is presumed
  // crashed; a fresh one means another invocation is active — skip, so cron
  // and admin-driven runs never overlap.
  await db
    .prepare(
      `UPDATE sync_runs SET status = 'error', finished_at = ?,
         detail = COALESCE(detail, '') || ' [marked stale]'
       WHERE status = 'running' AND started_at < ?`,
    )
    .bind(now, staleBefore)
    .run();
  const active = await db
    .prepare("SELECT id FROM sync_runs WHERE status = 'running' LIMIT 1")
    .first();
  if (active) {
    return {
      skipped: true,
      done: false,
      kind: "incremental",
      eventsWritten: 0,
      budgetSpent: 0,
    };
  }

  const ctx: SyncContext = {
    env,
    db,
    budget: new Budget(),
    resolver: await ContributorResolver.load(db),
    eventsWritten: 0,
  };

  const repos = await activeRepos(ctx);
  const state = await loadSyncState(db);
  const kind = isBackfilling(state, repos) ? "backfill" : "incremental";
  const run = await db
    .prepare(
      "INSERT INTO sync_runs (kind, started_at, status) VALUES (?, ?, 'running') RETURNING id",
    )
    .bind(kind, now)
    .first<{ id: number }>();
  const runId = run!.id;

  const lastLead = (state.get(stateKey(ROTATION_REPO, ROTATION_SOURCE)) ??
    null) as string | null;
  const order = rotated(repos, lastLead);
  if (order.length > 0 && order[0].name !== lastLead) {
    await syncStateUpsert(
      db,
      ROTATION_REPO,
      ROTATION_SOURCE,
      order[0].name,
    ).run();
  }

  let done = false;
  try {
    done = true;
    for (const repo of order) {
      const commitsDone = await syncCommits(
        ctx,
        repo,
        state.get(stateKey(repo.name, "commits")) as CommitsState | null,
      );
      const prsDone =
        commitsDone &&
        (await syncPrs(
          ctx,
          repo,
          state.get(stateKey(repo.name, "prs")) as PrsState | null,
        ));
      const issuesDone =
        prsDone &&
        (await syncIssueComments(
          ctx,
          repo,
          state.get(
            stateKey(repo.name, "issue_comments"),
          ) as IssuesState | null,
        ));
      const repoDone =
        issuesDone &&
        (await syncCommitComments(
          ctx,
          repo,
          state.get(
            stateKey(repo.name, "commit_comments"),
          ) as CommitCommentsState | null,
        ));
      if (!repoDone) {
        done = false;
        break;
      }
    }

    if (ctx.eventsWritten > 0) {
      await recomputeRollups(db);
      await reconcileBots(db);
      await bumpCacheGeneration(env);
    }

    await db
      .prepare(
        "UPDATE sync_runs SET status = 'ok', finished_at = ?, detail = ? WHERE id = ?",
      )
      .bind(
        new Date().toISOString(),
        JSON.stringify({
          trigger,
          partial: !done,
          repos: repos.length,
          eventsWritten: ctx.eventsWritten,
          budgetSpent: ctx.budget.spent,
        }),
        runId,
      )
      .run();

    // The per-minute cron adds 1,440 rows a day; health reads only the newest.
    // The started_at range is served by idx_sync_runs_started.
    await db
      .prepare(
        "DELETE FROM sync_runs WHERE started_at < ? AND status != 'running'",
      )
      .bind(
        new Date(
          Date.now() - SYNC_RUNS_RETENTION_DAYS * 86400000,
        ).toISOString(),
      )
      .run();
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    // Rate limiting is an expected, graceful stop: cursors for completed
    // pages are already persisted, the next run resumes.
    const status = e instanceof RateLimited ? "ok" : "error";
    await db
      .prepare(
        "UPDATE sync_runs SET status = ?, finished_at = ?, detail = ? WHERE id = ?",
      )
      .bind(
        status,
        new Date().toISOString(),
        JSON.stringify({
          trigger,
          partial: true,
          error: message,
          eventsWritten: ctx.eventsWritten,
          budgetSpent: ctx.budget.spent,
        }),
        runId,
      )
      .run();
    if (status === "error") {
      console.error(
        JSON.stringify({ event: "sync_failed", runId, trigger, message }),
      );
      throw e;
    }
  }

  return {
    skipped: false,
    done,
    kind,
    eventsWritten: ctx.eventsWritten,
    budgetSpent: ctx.budget.spent,
  };
}
