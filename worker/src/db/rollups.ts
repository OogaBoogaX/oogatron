// Full recompute after every sync that actually changed an event (unchanged
// re-upserts count zero — see eventUpsertStatements): one batch, one pass
// over activity_events, and it eliminates the incremental-invalidation bug
// class entirely (late-arriving events, bot reclassification, edited
// payloads). Revisit around ~100k events.
//
// Merge dedupe: a merged PR is one credit for the merger (its 'merge' event).
// The auto-generated merge commit on the branch would credit them a second
// time, so any commit whose oid is some same-repo merge event's mergeCommit
// is flagged counted = 0. The flag is materialized here, once per rebuild,
// rather than re-derived per request: as a correlated subquery it read ~160
// rows per event on every stats cache miss. Raw events stay complete for
// audit; rollups and every raw-event read path (api/stats.ts,
// api/contributors.ts) filter on COUNTED, so they can never disagree.
export const COUNTED = "e.counted = 1";

// Non-correlated: SQLite builds the merge-commit set once. NULL oids are
// filtered out so NOT IN stays two-valued.
const MERGE_COMMITS = `(repo, external_id) IN (
  SELECT repo, json_extract(payload, '$.mergeCommit') FROM activity_events
  WHERE type = 'merge' AND json_extract(payload, '$.mergeCommit') IS NOT NULL)`;

export async function recomputeRollups(db: D1Database): Promise<void> {
  await db.batch([
    // Guarded both ways: only rows whose flag actually changes are written.
    db.prepare(
      `UPDATE activity_events SET counted = 0
       WHERE type = 'commit' AND counted = 1 AND ${MERGE_COMMITS}`,
    ),
    db.prepare(
      `UPDATE activity_events SET counted = 1
       WHERE counted = 0 AND NOT (type = 'commit' AND ${MERGE_COMMITS})`,
    ),
    db.prepare("DELETE FROM daily_rollups"),
    db.prepare(
      `INSERT INTO daily_rollups (repo, day, contributor_id, type, count)
       SELECT repo, substr(occurred_at, 1, 10), contributor_id, type, COUNT(*)
       FROM activity_events e
       WHERE ${COUNTED}
       GROUP BY 1, 2, 3, 4`,
    ),
  ]);
}
