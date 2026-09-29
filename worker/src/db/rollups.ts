// Full recompute after every sync that actually changed an event (unchanged
// re-upserts count zero — see eventUpsertStatements): one batch, one pass
// over activity_events, and it eliminates the incremental-invalidation bug
// class entirely (late-arriving events, bot reclassification, edited
// payloads). Revisit around ~100k events.
//
// Merge dedupe: a merged PR is one credit for the merger (its 'merge' event).
// The auto-generated merge commit on the branch would credit them a second
// time, so any commit whose oid is some same-repo merge event's mergeCommit
// is excluded here. Raw events stay complete for audit; only rollups (and
// the raw recompute in api/contributors.ts, which repeats this predicate)
// serve deduplicated numbers. The lookup is served by the partial expression
// index idx_events_merge_commit (migration 0006), which only matches while
// this text keeps `m.type = 'merge'` and the exact json_extract expression —
// without it, every commit scans its whole repo's events.
export const MERGE_COMMIT_EXCLUSION = `NOT (e.type = 'commit' AND EXISTS (
  SELECT 1 FROM activity_events m
  WHERE m.repo = e.repo AND m.type = 'merge'
    AND json_extract(m.payload, '$.mergeCommit') = e.external_id))`;

export async function recomputeRollups(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM daily_rollups"),
    db.prepare(
      `INSERT INTO daily_rollups (repo, day, contributor_id, type, count)
       SELECT repo, substr(occurred_at, 1, 10), contributor_id, type, COUNT(*)
       FROM activity_events e
       WHERE ${MERGE_COMMIT_EXCLUSION}
       GROUP BY 1, 2, 3, 4`,
    ),
  ]);
}
