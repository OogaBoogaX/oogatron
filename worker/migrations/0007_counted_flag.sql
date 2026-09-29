-- The merge-commit dedupe used to be a correlated subquery evaluated on every
-- stats request and rollup rebuild; in production it read ~160 rows per event
-- (~570k per /v2/stats cache miss). It is now materialized once per rebuild
-- into activity_events.counted (see recomputeRollups in src/db/rollups.ts),
-- and every read path filters on the flag.
ALTER TABLE activity_events ADD COLUMN counted INTEGER NOT NULL DEFAULT 1;

UPDATE activity_events SET counted = 0
WHERE type = 'commit' AND (repo, external_id) IN (
  SELECT repo, json_extract(payload, '$.mergeCommit') FROM activity_events
  WHERE type = 'merge' AND json_extract(payload, '$.mergeCommit') IS NOT NULL);

DROP INDEX idx_events_merge_commit;

-- The recent feed's ORDER BY occurred_at DESC LIMIT 12 walks this instead of
-- scanning and sorting every event.
CREATE INDEX idx_events_time ON activity_events(occurred_at);

-- sync_runs pruning is a started_at range; the (status, started_at) index
-- can't serve its status != 'running' predicate.
CREATE INDEX idx_sync_runs_started ON sync_runs(started_at);
