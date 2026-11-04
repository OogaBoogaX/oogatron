-- Prepared before a rename. History stays empty until an operator verifies the
-- same GitHub ID after the rename and records the last verified old-login time.
-- Preflight every case-folded login first (see docs/account-renames.md). This
-- first statement refuses an unresolved duplicate instead of deploying a resolver
-- that would choose one row arbitrarily. It neither merges nor deletes history.
CREATE UNIQUE INDEX contributors_login_nocase ON contributors(login COLLATE NOCASE);

CREATE TABLE contributor_login_history (
  login TEXT PRIMARY KEY COLLATE NOCASE,
  github_id INTEGER NOT NULL REFERENCES contributors(github_id),
  valid_before TEXT NOT NULL CHECK (julianday(valid_before) IS NOT NULL)
);

-- Guard the database too: a concurrent resolver may have an older in-memory map.
-- ABORT rolls back a batch instead of assigning existing events to a new account.
CREATE TRIGGER contributor_identity_insert BEFORE INSERT ON contributors
WHEN EXISTS (SELECT 1 FROM contributors c WHERE lower(c.login) = lower(NEW.login)
  AND ((NEW.github_id IS NOT NULL AND c.github_id IS NOT NEW.github_id)
    OR c.login <> NEW.login))
BEGIN
  SELECT RAISE(ABORT, 'Contributor identity collision');
END;
CREATE TRIGGER contributor_identity_update BEFORE UPDATE OF github_id, login ON contributors
WHEN (NEW.github_id IS NOT OLD.github_id)
  OR EXISTS (SELECT 1 FROM contributors c WHERE c.id <> OLD.id AND lower(c.login) = lower(NEW.login))
BEGIN
  SELECT RAISE(ABORT, 'Contributor identity collision');
END;

-- A cutoff is evidence, not an editable alias. Exact reapplication is harmless.
CREATE TRIGGER contributor_history_immutable BEFORE UPDATE ON contributor_login_history
WHEN OLD.login <> NEW.login OR OLD.github_id <> NEW.github_id OR OLD.valid_before <> NEW.valid_before
BEGIN
  SELECT RAISE(ABORT, 'Contributor history requires review');
END;
CREATE TRIGGER contributor_history_retained BEFORE DELETE ON contributor_login_history
BEGIN
  SELECT RAISE(ABORT, 'Contributor history requires review');
END;
