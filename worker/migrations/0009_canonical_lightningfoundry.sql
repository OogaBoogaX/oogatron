-- These names belong to one renamed repository. Keep only duplicate copies
-- of the SAME external_id out of the raw store: timestamps, contributor and
-- title are not event identifiers. Prefer the canonical row's current
-- payload, then the last ingested alias copy when no canonical row exists.
DELETE FROM activity_events WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY external_id
      ORDER BY (repo = 'lightningfoundry') DESC, id DESC) AS rn
    FROM activity_events
    WHERE lower(repo) IN ('lightningfactory', 'lightning-factory', 'lightning_factory',
                         'lightningfoundry', 'lightning-foundry', 'lightning_foundry'))
  WHERE rn > 1);

UPDATE activity_events SET repo = 'lightningfoundry'
WHERE repo != 'lightningfoundry'
  AND lower(repo) IN ('lightningfactory', 'lightning-factory', 'lightning_factory',
                      'lightningfoundry', 'lightning-foundry', 'lightning_foundry');

-- Preserve the current repository's metadata (or the most recently checked
-- alias if discovery has not seen the new name yet) and earliest discovery.
INSERT INTO repos (name, default_branch, is_active, discovered_at, last_checked_at)
SELECT 'lightningfoundry', default_branch, is_active,
       (SELECT MIN(discovered_at) FROM repos
        WHERE lower(name) IN ('lightningfactory', 'lightning-factory', 'lightning_factory',
                              'lightningfoundry', 'lightning-foundry', 'lightning_foundry')),
       last_checked_at
FROM repos
WHERE lower(name) IN ('lightningfactory', 'lightning-factory', 'lightning_factory',
                      'lightningfoundry', 'lightning-foundry', 'lightning_foundry')
ORDER BY (name = 'lightningfoundry') DESC, last_checked_at DESC, name
LIMIT 1
ON CONFLICT(name) DO UPDATE SET discovered_at = excluded.discovered_at;

DELETE FROM repos
WHERE name != 'lightningfoundry'
  AND lower(name) IN ('lightningfactory', 'lightning-factory', 'lightning_factory',
                      'lightningfoundry', 'lightning-foundry', 'lightning_foundry');

-- Opaque pagination cursors cannot be merged. Re-walk this repository only;
-- the canonical upsert makes the retained history idempotent. Other repos'
-- cursors, including BananaPayServer, are untouched.
DELETE FROM sync_state
WHERE lower(repo) IN ('lightningfactory', 'lightning-factory', 'lightning_factory',
                      'lightningfoundry', 'lightning-foundry', 'lightning_foundry');
DELETE FROM sync_state
WHERE repo = '*' AND source = 'rotation'
  AND lower(json_extract(cursor, '$')) IN (
    'lightningfactory', 'lightning-factory', 'lightning_factory',
    'lightningfoundry', 'lightning-foundry', 'lightning_foundry');

-- Re-evaluate the same merge/patch rules as db/rollups.ts after joining the
-- histories. A merge and its commit, or two rebased SHAs, may previously have
-- lived under different names. Raw distinct SHAs remain available for audit.
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
WHERE repo = 'lightningfoundry';

DELETE FROM daily_rollups
WHERE lower(repo) IN ('lightningfactory', 'lightning-factory', 'lightning_factory',
                      'lightningfoundry', 'lightning-foundry', 'lightning_foundry');
INSERT INTO daily_rollups (repo, day, contributor_id, type, count)
SELECT repo, substr(occurred_at, 1, 10), contributor_id, type, COUNT(*)
FROM activity_events
WHERE repo = 'lightningfoundry' AND counted = 1
GROUP BY 1, 2, 3, 4;

-- An old run may already hold canonical cursors in memory, or have committed
-- earlier pages before an alias write is rejected below. The new worker
-- finalizes after the existing running-row guard says that run has ended:
-- reset cursors again, rebuild ALL rollups, invalidate cache, then clear this
-- marker last. A failed finalization leaves the marker for a safe retry.
INSERT INTO sync_state (repo, source, cursor, updated_at)
VALUES ('*', 'foundry_cleanup', 'true', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(repo, source) DO NOTHING;

-- Migrations precede Worker deployment. An old in-flight sync must not put
-- retired names/cursors back afterward. Abort its whole page/discovery batch
-- (including cursor advancement); the next deployed run retries canonically.
-- Redirecting with a trigger would hide writes from the old run's changed-row
-- accounting and could skip its rollup rebuild. New code normalizes before
-- these guards, so ordinary idempotent sync never reaches them.
CREATE TRIGGER IF NOT EXISTS reject_foundry_alias_events
BEFORE INSERT ON activity_events
WHEN NEW.repo != 'lightningfoundry'
  AND lower(NEW.repo) IN ('lightningfactory', 'lightning-factory', 'lightning_factory',
                          'lightningfoundry', 'lightning-foundry', 'lightning_foundry')
BEGIN
  SELECT RAISE(ABORT, 'retired repository alias: use lightningfoundry');
END;

CREATE TRIGGER IF NOT EXISTS reject_foundry_alias_repos
BEFORE INSERT ON repos
WHEN NEW.name != 'lightningfoundry'
  AND lower(NEW.name) IN ('lightningfactory', 'lightning-factory', 'lightning_factory',
                          'lightningfoundry', 'lightning-foundry', 'lightning_foundry')
BEGIN
  SELECT RAISE(ABORT, 'retired repository alias: use lightningfoundry');
END;

CREATE TRIGGER IF NOT EXISTS reject_foundry_alias_sync_state
BEFORE INSERT ON sync_state
WHEN NEW.repo != 'lightningfoundry'
  AND lower(NEW.repo) IN ('lightningfactory', 'lightning-factory', 'lightning_factory',
                          'lightningfoundry', 'lightning-foundry', 'lightning_foundry')
BEGIN
  SELECT RAISE(ABORT, 'retired repository alias: use lightningfoundry');
END;
