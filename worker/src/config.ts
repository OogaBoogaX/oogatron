export const OWNER = "OogaBoogaX";

// Historical names of the same org repository. Keep the storage key stable
// through a rename; BananaPayServer is a separate repository, not an alias.
export function canonicalRepoName(name: string): string {
  return /^lightning[-_]?(?:factory|foundry)$/i.test(name)
    ? "lightningfoundry"
    : name;
}

// Default meta version for v1-route responses; /v2/stats serves schema 3.
export const SCHEMA_VERSION = 2;
export const SCHEMA_VERSION_V3 = 3;

// Repos are discovered from the org (public, non-fork, non-archived); list
// short names here to keep specific repos off the jumbotron anyway.
// oogatron lives in the org too, but the scoreboard does not score itself.
export const EXCLUDED_REPOS: string[] = ["oogatron"];

// Org repo discovery re-runs when the repos table is older than this; between
// refreshes each sync run reads the cached table only.
export const REPO_DISCOVERY_TTL_MINUTES = 60;

// Incremental commit sync re-reads this many days before the watermark:
// rebases and cherry-picks can introduce commits whose committedDate predates
// the newest one already seen, and upserts are idempotent so overlap is free.
export const COMMIT_OVERLAP_DAYS = 7;

// A sync_runs row stuck in 'running' longer than this is presumed crashed.
// Runs are budget-bounded and finish in under a minute of wall time; a run
// the runtime kills mid-flight (e.g. clientDisconnected) never marks itself
// finished, and every cron skips until this expires — so keep it short.
export const STALE_RUN_MINUTES = 5;

// Per-request cap on GitHub GraphQL calls. A hung request would otherwise
// hold the run open until the runtime kills it, leaving a stale row.
export const GITHUB_TIMEOUT_MS = 20_000;

// Finished sync_runs rows older than this are pruned after each successful run.
export const SYNC_RUNS_RETENTION_DAYS = 1;

// /v2/stats `recent` keeps this many newest events per (repo, contributor,
// public type) cell. Any client-side filter is a union of cells, so every
// filtered feed has at least this many rows (or the selection's whole
// history). 12 is >= the 10 the island shows and equals the old org-wide cap,
// so the unfiltered feed's first 12 rows are unchanged.
export const RECENT_DEPTH = 12;
