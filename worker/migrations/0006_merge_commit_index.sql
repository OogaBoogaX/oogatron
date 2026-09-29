-- The merge-commit dedupe (MERGE_COMMIT_EXCLUSION in src/db/rollups.ts) is a
-- correlated lookup per commit. Without this index it scanned every event in
-- the repo per commit — commits x events rows read on each rollup rebuild.
-- The expression and partial predicate must match the query text exactly for
-- the planner to use it.
CREATE INDEX idx_events_merge_commit
  ON activity_events(repo, json_extract(payload, '$.mergeCommit'))
  WHERE type = 'merge';

-- The per-run stale/active checks filter sync_runs by status and age; the
-- table also gets pruned by age after each successful run.
CREATE INDEX idx_sync_runs_status ON sync_runs(status, started_at);
