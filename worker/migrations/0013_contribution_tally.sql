-- Activity and contributions part ways. Every counted event stays activity
-- (the recent feed, each pair's last activity, the island's routing), and
-- daily_rollups.count keeps counting them. The numbers the stats serve come
-- from daily_rollups.tally instead, which follows GitHub's contribution graph
-- for commits: a commit counts once it is on the default branch.
--
-- activity_events.landed: 1 when the commit is on its repo's default branch
-- (the default-branch walker saw it, or the PR walker saw it on a PR merged
-- with a merge commit), 0 when only a PR branch is known to hold it. NULL is
-- a commit stored before this migration: it counts as landed until its repo's
-- default-branch re-walk (below) finishes and turns every NULL left into 0,
-- so the counts never dip while the walk runs.
ALTER TABLE activity_events ADD COLUMN landed INTEGER;
ALTER TABLE daily_rollups ADD COLUMN tally INTEGER NOT NULL DEFAULT 0;

-- The merge rule leaves the commit dedupe: a merge commit (or a squash merge's
-- one commit) on the default branch is its author's commit, as on GitHub, and
-- the merge itself is its own kind, outside the contribution total.
DROP TRIGGER rollups_event_insert;
DROP TRIGGER rollups_event_delete;
DROP TRIGGER rollups_event_update;
DROP TRIGGER counted_dirty_insert;
DROP TRIGGER counted_dirty_delete;
DROP TRIGGER counted_dirty_update;
DROP INDEX idx_events_merge_commit;
-- The flags are recomputed from all history just below, so no note is owed.
DELETE FROM counted_dirty;

UPDATE activity_events SET counted = 0 WHERE counted = 1 AND id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY repo, contributor_id,
        json_extract(payload, '$.authoredAt'), json_extract(payload, '$.headline')
      ORDER BY occurred_at DESC, external_id DESC) AS rn
    FROM activity_events
    WHERE type = 'commit' AND json_extract(payload, '$.authoredAt') IS NOT NULL)
  WHERE rn > 1);
UPDATE activity_events SET counted = 1 WHERE counted = 0 AND id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY repo, contributor_id,
        json_extract(payload, '$.authoredAt'), json_extract(payload, '$.headline')
      ORDER BY occurred_at DESC, external_id DESC) AS rn
    FROM activity_events
    WHERE type = 'commit' AND json_extract(payload, '$.authoredAt') IS NOT NULL)
  WHERE rn > 1);
INSERT INTO daily_rollups (repo, day, contributor_id, type, count, tally)
  SELECT repo, substr(occurred_at, 1, 10), contributor_id, type, COUNT(*),
    SUM(CASE WHEN type <> 'commit' OR landed IS NOT 0 THEN 1 ELSE 0 END)
  FROM activity_events e WHERE e.counted = 1
  GROUP BY 1, 2, 3, 4
  ON CONFLICT(repo, day, contributor_id, type) DO UPDATE SET
    count = excluded.count, tally = excluded.tally;
DELETE FROM daily_rollups WHERE (repo, day, contributor_id, type) NOT IN (
  SELECT repo, substr(occurred_at, 1, 10), contributor_id, type
  FROM activity_events e WHERE e.counted = 1 GROUP BY 1, 2, 3, 4);

-- The same triggers as migration 0012, each bucket's tally following its
-- events' landed flag alongside its count.
CREATE TRIGGER rollups_event_insert AFTER INSERT ON activity_events
WHEN NEW.counted = 1
BEGIN
  INSERT INTO daily_rollups (repo, day, contributor_id, type, count, tally)
  VALUES (NEW.repo, substr(NEW.occurred_at, 1, 10), NEW.contributor_id, NEW.type, 1,
    CASE WHEN NEW.type <> 'commit' OR NEW.landed IS NOT 0 THEN 1 ELSE 0 END)
  ON CONFLICT(repo, day, contributor_id, type) DO UPDATE SET
    count = count + 1, tally = tally + excluded.tally;
END;

CREATE TRIGGER rollups_event_delete AFTER DELETE ON activity_events
WHEN OLD.counted = 1
BEGIN
  UPDATE daily_rollups SET count = count - 1,
    tally = tally - (CASE WHEN OLD.type <> 'commit' OR OLD.landed IS NOT 0 THEN 1 ELSE 0 END)
  WHERE repo = OLD.repo AND day = substr(OLD.occurred_at, 1, 10)
    AND contributor_id = OLD.contributor_id AND type = OLD.type;
  DELETE FROM daily_rollups
  WHERE repo = OLD.repo AND day = substr(OLD.occurred_at, 1, 10)
    AND contributor_id = OLD.contributor_id AND type = OLD.type AND count <= 0;
END;

CREATE TRIGGER rollups_event_update
AFTER UPDATE OF repo, contributor_id, type, occurred_at, counted, landed ON activity_events
WHEN (OLD.counted = 1 OR NEW.counted = 1)
  AND (OLD.counted IS NOT NEW.counted OR OLD.repo IS NOT NEW.repo
    OR OLD.contributor_id IS NOT NEW.contributor_id OR OLD.type IS NOT NEW.type
    OR substr(OLD.occurred_at, 1, 10) IS NOT substr(NEW.occurred_at, 1, 10)
    OR (OLD.landed IS NOT 0) IS NOT (NEW.landed IS NOT 0))
BEGIN
  UPDATE daily_rollups SET count = count - 1,
    tally = tally - (CASE WHEN OLD.type <> 'commit' OR OLD.landed IS NOT 0 THEN 1 ELSE 0 END)
  WHERE OLD.counted = 1 AND repo = OLD.repo AND day = substr(OLD.occurred_at, 1, 10)
    AND contributor_id = OLD.contributor_id AND type = OLD.type;
  DELETE FROM daily_rollups
  WHERE OLD.counted = 1 AND repo = OLD.repo AND day = substr(OLD.occurred_at, 1, 10)
    AND contributor_id = OLD.contributor_id AND type = OLD.type AND count <= 0;
  INSERT INTO daily_rollups (repo, day, contributor_id, type, count, tally)
  SELECT NEW.repo, substr(NEW.occurred_at, 1, 10), NEW.contributor_id, NEW.type, 1,
    CASE WHEN NEW.type <> 'commit' OR NEW.landed IS NOT 0 THEN 1 ELSE 0 END
  WHERE NEW.counted = 1
  ON CONFLICT(repo, day, contributor_id, type) DO UPDATE SET
    count = count + 1, tally = tally + excluded.tally;
END;

-- Dedupe inputs: a commit's own identity, before and after an edit, so a
-- commit leaving a group frees the copy it hid.
CREATE TRIGGER counted_dirty_insert AFTER INSERT ON activity_events
WHEN NEW.type = 'commit'
BEGIN
  INSERT INTO counted_dirty (repo, contributor_id, authored_at, headline, oid)
  VALUES (NEW.repo, NEW.contributor_id, json_extract(NEW.payload, '$.authoredAt'),
    json_extract(NEW.payload, '$.headline'), NEW.external_id);
END;

CREATE TRIGGER counted_dirty_delete AFTER DELETE ON activity_events
WHEN OLD.type = 'commit'
BEGIN
  INSERT INTO counted_dirty (repo, contributor_id, authored_at, headline, oid)
  VALUES (OLD.repo, OLD.contributor_id, json_extract(OLD.payload, '$.authoredAt'),
    json_extract(OLD.payload, '$.headline'), OLD.external_id);
END;

CREATE TRIGGER counted_dirty_update
AFTER UPDATE OF repo, contributor_id, type, external_id, occurred_at, payload ON activity_events
WHEN OLD.type = 'commit' OR NEW.type = 'commit'
BEGIN
  INSERT INTO counted_dirty (repo, contributor_id, authored_at, headline, oid)
  SELECT OLD.repo, OLD.contributor_id, json_extract(OLD.payload, '$.authoredAt'),
    json_extract(OLD.payload, '$.headline'), OLD.external_id
  WHERE OLD.type = 'commit'
  UNION ALL
  SELECT NEW.repo, NEW.contributor_id, json_extract(NEW.payload, '$.authoredAt'),
    json_extract(NEW.payload, '$.headline'), NEW.external_id
  WHERE NEW.type = 'commit';
END;

-- Re-walk every default branch so each stored commit learns whether it landed.
DELETE FROM sync_state WHERE source = 'commits';
