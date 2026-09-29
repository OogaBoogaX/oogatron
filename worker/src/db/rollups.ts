// Full recompute after every sync that actually changed an event (unchanged
// re-upserts count zero — see eventUpsertStatements): one batch, one pass
// over activity_events, and it eliminates the incremental-invalidation bug
// class entirely (late-arriving events, bot reclassification, edited
// payloads). Revisit around ~100k events.
//
// Commit dedupe, materialized into activity_events.counted once per rebuild
// rather than re-derived per request (as a correlated subquery it read ~160
// rows per event on every stats cache miss). A commit is uncounted when:
//
// - Merge: its oid is some same-repo merge event's mergeCommit. A merged PR
//   is one credit for whoever pressed the button (its 'merge' event); the
//   auto-generated merge commit would credit them a second time.
// - Patch identity: a newer commit in the same repo has the same author,
//   author date and headline. PR branches are walked too (sync/prs.ts), so a
//   rebase merge, a rebased PR branch or an --amend leaves the same patch
//   under several SHAs; only the newest counts. For a rebase merge the newest
//   copy is the mergeCommit, so the patch folds into the merge credit exactly
//   as the merge rule alone did before branch commits were walked.
//
// Raw events stay complete for audit; rollups and every raw-event read path
// (api/stats.ts, api/contributors.ts) filter on COUNTED, so they can never
// disagree.
export const COUNTED = "e.counted = 1";

// Non-correlated: SQLite builds each set once. NULL oids and pre-authoredAt
// rows are filtered out so NOT IN stays two-valued.
const UNCOUNTED_IDS = `
  SELECT id FROM activity_events
  WHERE type = 'commit' AND (repo, external_id) IN (
    SELECT repo, json_extract(payload, '$.mergeCommit') FROM activity_events
    WHERE type = 'merge' AND json_extract(payload, '$.mergeCommit') IS NOT NULL)
  UNION
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY repo, contributor_id,
        json_extract(payload, '$.authoredAt'), json_extract(payload, '$.headline')
      ORDER BY occurred_at DESC, external_id DESC) AS rn
    FROM activity_events
    WHERE type = 'commit' AND json_extract(payload, '$.authoredAt') IS NOT NULL)
  WHERE rn > 1`;

export async function recomputeRollups(db: D1Database): Promise<void> {
  await db.batch([
    // Guarded both ways: only rows whose flag actually changes are written.
    db.prepare(
      `UPDATE activity_events SET counted = 0
       WHERE counted = 1 AND id IN (${UNCOUNTED_IDS})`,
    ),
    db.prepare(
      `UPDATE activity_events SET counted = 1
       WHERE counted = 0 AND id NOT IN (${UNCOUNTED_IDS})`,
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
