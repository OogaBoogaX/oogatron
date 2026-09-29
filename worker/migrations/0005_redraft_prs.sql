-- The pr payload now carries the draft flag; re-walk PR history so existing
-- rows pick it up. No schema change — payload is free JSON.
DELETE FROM sync_state WHERE source = 'prs';
