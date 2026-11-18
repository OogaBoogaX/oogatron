// daily_rollups holds every counted event's (repo, day, contributor, type)
// bucket. Since migration 0012 its triggers keep it current as events change,
// and reconcileRollups re-evaluates only the commits whose dedupe can have
// moved; recomputeRollups below still rebuilds both from all history, writing
// only what differs, for migrations, cleanups and the daily drift check.
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

// A commit is uncounted under either rule above, written for one row of the
// outer UPDATE (activity_events) and answered by an index seek on each side
// (migration 0012's idx_events_merge_commit and idx_events_commit_identity),
// never a scan. NULL headlines share a partition, as in ROW_NUMBER, hence IS.
// The unary + drops external_id's TEXT affinity, without which SQLite cannot
// seek the expression index and reads every merge in the repo; mergeCommit is
// always a JSON string or null (sync/prs.ts), so no comparison changes.
const UNCOUNTED_ROW = `
  EXISTS (SELECT 1 FROM activity_events m
    WHERE m.type = 'merge' AND m.repo = activity_events.repo
      AND json_extract(m.payload, '$.mergeCommit') = +activity_events.external_id)
  OR (json_extract(activity_events.payload, '$.authoredAt') IS NOT NULL
    AND EXISTS (SELECT 1 FROM activity_events d
      WHERE d.type = 'commit' AND d.repo = activity_events.repo
        AND d.contributor_id = activity_events.contributor_id
        AND json_extract(d.payload, '$.authoredAt') = json_extract(activity_events.payload, '$.authoredAt')
        AND json_extract(d.payload, '$.headline') IS json_extract(activity_events.payload, '$.headline')
        AND (d.occurred_at > activity_events.occurred_at
          OR (d.occurred_at = activity_events.occurred_at
            AND d.external_id > activity_events.external_id))))`;

// The commits whose flag can have moved since the last reconcile: the identity
// groups and oids that migration 0012's triggers noted in counted_dirty.
// CROSS JOIN keeps the few notes as the outer loop (SQLite never reorders
// it), so each is one seek on idx_events_commit_identity or the (repo,
// external_id) key; left to choose, the planner walks every commit instead.
const DIRTY_COMMITS = `
  SELECT e.id FROM counted_dirty k CROSS JOIN activity_events e
    ON e.type = 'commit' AND e.repo = k.repo AND e.contributor_id = k.contributor_id
   AND json_extract(e.payload, '$.authoredAt') = k.authored_at
   AND json_extract(e.payload, '$.headline') IS k.headline
  WHERE k.authored_at IS NOT NULL
  UNION
  SELECT e.id FROM counted_dirty k CROSS JOIN activity_events e
    ON e.type = 'commit' AND e.repo = k.repo AND e.external_id = k.oid
  WHERE k.oid IS NOT NULL`;

// After a sync that wrote events. daily_rollups is already current (migration
// 0012's triggers keep each bucket as its events change), so only the counted
// flags of the commits noted dirty are re-evaluated, and a flag that moves
// moves its bucket through the same triggers. Reads rows in proportion to what
// changed, not to all history. One batch, so a failure leaves the notes for the
// next run.
export const RECONCILE_FLAGS = `UPDATE activity_events
  SET counted = CASE WHEN ${UNCOUNTED_ROW} THEN 0 ELSE 1 END
  WHERE id IN (${DIRTY_COMMITS})
    AND counted IS NOT (CASE WHEN ${UNCOUNTED_ROW} THEN 0 ELSE 1 END)`;

export async function reconcileRollups(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(RECONCILE_FLAGS),
    db.prepare("DELETE FROM counted_dirty"),
  ]);
}

// Everything from all history: migrations and cleanups, and the daily check
// that the incremental path has not drifted. Returns how many rows it changed
// (flags and buckets, with what the triggers wrote for them), which is 0
// whenever the incremental path kept up.
export async function recomputeRollups(db: D1Database): Promise<number> {
  const results = await db.batch([
    // Guarded both ways: only rows whose flag actually changes are written.
    db.prepare(
      `UPDATE activity_events SET counted = 0
       WHERE counted = 1 AND id IN (${UNCOUNTED_IDS})`,
    ),
    db.prepare(
      `UPDATE activity_events SET counted = 1
       WHERE counted = 0 AND id NOT IN (${UNCOUNTED_IDS})`,
    ),
    db.prepare(
      `INSERT INTO daily_rollups (repo, day, contributor_id, type, count)
       SELECT repo, substr(occurred_at, 1, 10), contributor_id, type, COUNT(*)
       FROM activity_events e
       WHERE ${COUNTED}
       GROUP BY 1, 2, 3, 4
       ON CONFLICT(repo, day, contributor_id, type) DO UPDATE SET
         count = excluded.count
       WHERE daily_rollups.count IS NOT excluded.count`,
    ),
    // All tuple components are NOT NULL in the schema (occurred_at supplies
    // day), so NOT IN cannot be poisoned by a NULL key. This also removes a
    // final bucket after a correction, deletion or counted-flag change.
    db.prepare(
      `DELETE FROM daily_rollups
       WHERE (repo, day, contributor_id, type) NOT IN (
         SELECT repo, substr(occurred_at, 1, 10), contributor_id, type
         FROM activity_events e
         WHERE ${COUNTED}
         GROUP BY 1, 2, 3, 4)`,
    ),
    // Everything is exact now, including whatever the triggers noted.
    db.prepare("DELETE FROM counted_dirty"),
  ]);
  return results.slice(0, 4).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}
