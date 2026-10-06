-- Maintainer-confirmed contribution alias: Harry (19156) -> hotpixelgroup (2301075).
-- Keep immutable events and their payloads; combine credit, never authentication.
INSERT INTO contributors (github_id, login, avatar_url, is_bot, first_seen_at, last_seen_at)
SELECT 2301075, 'hotpixelgroup', 'https://avatars.githubusercontent.com/u/2301075?v=4', 0,
       first_seen_at, last_seen_at
FROM contributors WHERE github_id = 19156
  AND NOT EXISTS (SELECT 1 FROM contributors WHERE github_id = 2301075)
ON CONFLICT(login) DO NOTHING;

UPDATE contributors SET
  first_seen_at = (SELECT MIN(first_seen_at) FROM contributors WHERE github_id IN (19156, 2301075)),
  last_seen_at = (SELECT MAX(last_seen_at) FROM contributors WHERE github_id IN (19156, 2301075))
WHERE github_id = 2301075;

UPDATE activity_events
SET contributor_id = (SELECT id FROM contributors WHERE github_id = 2301075)
WHERE contributor_id = (SELECT id FROM contributors WHERE github_id = 19156)
  AND EXISTS (SELECT 1 FROM contributors WHERE github_id = 2301075);

-- Re-evaluate the existing merge/patch rules after the histories are joined.
UPDATE activity_events SET counted = CASE WHEN id IN (
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
  WHERE rn > 1
) THEN 0 ELSE 1 END
;

DELETE FROM daily_rollups;
INSERT INTO daily_rollups (repo, day, contributor_id, type, count)
SELECT repo, substr(occurred_at, 1, 10), contributor_id, type, COUNT(*)
FROM activity_events WHERE counted = 1
GROUP BY 1, 2, 3, 4;

DELETE FROM contributors WHERE github_id = 19156
  AND NOT EXISTS (SELECT 1 FROM activity_events WHERE contributor_id = contributors.id)
  AND NOT EXISTS (SELECT 1 FROM daily_rollups WHERE contributor_id = contributors.id);

INSERT INTO sync_state (repo, source, cursor, updated_at)
SELECT '*', 'attribution_cleanup', 'true', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM contributors WHERE github_id = 2301075)
ON CONFLICT(repo, source) DO NOTHING;

-- An in-flight old Worker must not recreate the alias between migration and
-- deployment. Abort its page atomically; the new resolver retries canonically.
CREATE TRIGGER IF NOT EXISTS reject_harry_alias_insert
BEFORE INSERT ON contributors
WHEN NEW.github_id = 19156 OR (NEW.github_id IS NULL AND lower(NEW.login) = 'harry')
BEGIN
  SELECT RAISE(ABORT, 'confirmed contributor alias: use hotpixelgroup');
END;

CREATE TRIGGER IF NOT EXISTS reject_harry_alias_update
BEFORE UPDATE ON contributors
WHEN NEW.github_id = 19156 OR (NEW.github_id IS NULL AND lower(NEW.login) = 'harry')
BEGIN
  SELECT RAISE(ABORT, 'confirmed contributor alias: use hotpixelgroup');
END;
