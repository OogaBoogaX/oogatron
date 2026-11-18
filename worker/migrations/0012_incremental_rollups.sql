-- daily_rollups follows activity_events row by row instead of being recounted
-- from all history after every sync that writes an event (about 230k rows read
-- each time, to change one or two of ~2,400 buckets). Triggers add or take one
-- from the event's bucket as it is inserted, deleted, moved or (un)counted, so a
-- new contribution touches only its own bucket. The counted flag (commit dedupe,
-- see src/db/rollups.ts) depends on other rows, so every change that can move it
-- is noted in counted_dirty and reconcileRollups re-evaluates only those commits.
-- The full recompute stays for migrations, cleanups and a daily drift check.

-- Start exact, with recomputeRollups' own guarded statements (only rows that
-- differ are written). Triggers come after, so this does not cascade.
UPDATE activity_events SET counted = 0 WHERE counted = 1 AND id IN (
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
  WHERE rn > 1);
UPDATE activity_events SET counted = 1 WHERE counted = 0 AND id NOT IN (
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
  WHERE rn > 1);
INSERT INTO daily_rollups (repo, day, contributor_id, type, count)
  SELECT repo, substr(occurred_at, 1, 10), contributor_id, type, COUNT(*)
  FROM activity_events e WHERE e.counted = 1
  GROUP BY 1, 2, 3, 4
  ON CONFLICT(repo, day, contributor_id, type) DO UPDATE SET count = excluded.count
  WHERE daily_rollups.count IS NOT excluded.count;
DELETE FROM daily_rollups WHERE (repo, day, contributor_id, type) NOT IN (
  SELECT repo, substr(occurred_at, 1, 10), contributor_id, type
  FROM activity_events e WHERE e.counted = 1 GROUP BY 1, 2, 3, 4);

-- What the dedupe rules look up: a commit's identity group (same repo,
-- author, author date and headline), and the merges naming a commit.
CREATE INDEX idx_events_commit_identity ON activity_events(
  repo, contributor_id, json_extract(payload, '$.authoredAt'),
  json_extract(payload, '$.headline'), occurred_at) WHERE type = 'commit';
CREATE INDEX idx_events_merge_commit ON activity_events(
  repo, json_extract(payload, '$.mergeCommit')) WHERE type = 'merge';
-- Each (repo, contributor)'s latest counted event, one seek each for /v2/stats.
CREATE INDEX idx_events_counted_pair_time ON activity_events(
  repo, contributor_id, occurred_at) WHERE counted = 1;
-- The recent feed's newest counted events of each (repo, contributor, type).
CREATE INDEX idx_events_counted_recent ON activity_events(
  repo, contributor_id, type, occurred_at) WHERE counted = 1;

-- A commit identity group (authored_at not null) and/or a commit oid whose
-- counted flag may have changed. Emptied by every reconcile.
CREATE TABLE counted_dirty (
  repo           TEXT NOT NULL,
  contributor_id INTEGER,
  authored_at    TEXT,
  headline       TEXT,
  oid            TEXT
);

CREATE TRIGGER rollups_event_insert AFTER INSERT ON activity_events
WHEN NEW.counted = 1
BEGIN
  INSERT INTO daily_rollups (repo, day, contributor_id, type, count)
  VALUES (NEW.repo, substr(NEW.occurred_at, 1, 10), NEW.contributor_id, NEW.type, 1)
  ON CONFLICT(repo, day, contributor_id, type) DO UPDATE SET count = count + 1;
END;

CREATE TRIGGER rollups_event_delete AFTER DELETE ON activity_events
WHEN OLD.counted = 1
BEGIN
  UPDATE daily_rollups SET count = count - 1
  WHERE repo = OLD.repo AND day = substr(OLD.occurred_at, 1, 10)
    AND contributor_id = OLD.contributor_id AND type = OLD.type;
  DELETE FROM daily_rollups
  WHERE repo = OLD.repo AND day = substr(OLD.occurred_at, 1, 10)
    AND contributor_id = OLD.contributor_id AND type = OLD.type AND count <= 0;
END;

CREATE TRIGGER rollups_event_update
AFTER UPDATE OF repo, contributor_id, type, occurred_at, counted ON activity_events
WHEN (OLD.counted = 1 OR NEW.counted = 1)
  AND (OLD.counted IS NOT NEW.counted OR OLD.repo IS NOT NEW.repo
    OR OLD.contributor_id IS NOT NEW.contributor_id OR OLD.type IS NOT NEW.type
    OR substr(OLD.occurred_at, 1, 10) IS NOT substr(NEW.occurred_at, 1, 10))
BEGIN
  UPDATE daily_rollups SET count = count - 1
  WHERE OLD.counted = 1 AND repo = OLD.repo AND day = substr(OLD.occurred_at, 1, 10)
    AND contributor_id = OLD.contributor_id AND type = OLD.type;
  DELETE FROM daily_rollups
  WHERE OLD.counted = 1 AND repo = OLD.repo AND day = substr(OLD.occurred_at, 1, 10)
    AND contributor_id = OLD.contributor_id AND type = OLD.type AND count <= 0;
  INSERT INTO daily_rollups (repo, day, contributor_id, type, count)
  SELECT NEW.repo, substr(NEW.occurred_at, 1, 10), NEW.contributor_id, NEW.type, 1
  WHERE NEW.counted = 1
  ON CONFLICT(repo, day, contributor_id, type) DO UPDATE SET count = count + 1;
END;

-- Dedupe inputs: a commit's own identity and oid, and a merge's mergeCommit.
-- Before and after an edit, so a commit leaving a group frees the copy it hid.
CREATE TRIGGER counted_dirty_insert AFTER INSERT ON activity_events
WHEN NEW.type IN ('commit', 'merge')
BEGIN
  INSERT INTO counted_dirty (repo, contributor_id, authored_at, headline, oid)
  SELECT NEW.repo, NEW.contributor_id, json_extract(NEW.payload, '$.authoredAt'),
    json_extract(NEW.payload, '$.headline'), NEW.external_id
  WHERE NEW.type = 'commit'
  UNION ALL
  SELECT NEW.repo, NULL, NULL, NULL, json_extract(NEW.payload, '$.mergeCommit')
  WHERE NEW.type = 'merge' AND json_extract(NEW.payload, '$.mergeCommit') IS NOT NULL;
END;

CREATE TRIGGER counted_dirty_delete AFTER DELETE ON activity_events
WHEN OLD.type IN ('commit', 'merge')
BEGIN
  INSERT INTO counted_dirty (repo, contributor_id, authored_at, headline, oid)
  SELECT OLD.repo, OLD.contributor_id, json_extract(OLD.payload, '$.authoredAt'),
    json_extract(OLD.payload, '$.headline'), OLD.external_id
  WHERE OLD.type = 'commit'
  UNION ALL
  SELECT OLD.repo, NULL, NULL, NULL, json_extract(OLD.payload, '$.mergeCommit')
  WHERE OLD.type = 'merge' AND json_extract(OLD.payload, '$.mergeCommit') IS NOT NULL;
END;

CREATE TRIGGER counted_dirty_update
AFTER UPDATE OF repo, contributor_id, type, external_id, occurred_at, payload ON activity_events
WHEN OLD.type IN ('commit', 'merge') OR NEW.type IN ('commit', 'merge')
BEGIN
  INSERT INTO counted_dirty (repo, contributor_id, authored_at, headline, oid)
  SELECT OLD.repo, OLD.contributor_id, json_extract(OLD.payload, '$.authoredAt'),
    json_extract(OLD.payload, '$.headline'), OLD.external_id
  WHERE OLD.type = 'commit'
  UNION ALL
  SELECT OLD.repo, NULL, NULL, NULL, json_extract(OLD.payload, '$.mergeCommit')
  WHERE OLD.type = 'merge' AND json_extract(OLD.payload, '$.mergeCommit') IS NOT NULL
  UNION ALL
  SELECT NEW.repo, NEW.contributor_id, json_extract(NEW.payload, '$.authoredAt'),
    json_extract(NEW.payload, '$.headline'), NEW.external_id
  WHERE NEW.type = 'commit'
  UNION ALL
  SELECT NEW.repo, NULL, NULL, NULL, json_extract(NEW.payload, '$.mergeCommit')
  WHERE NEW.type = 'merge' AND json_extract(NEW.payload, '$.mergeCommit') IS NOT NULL;
END;
