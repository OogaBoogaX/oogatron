-- Commit payloads now carry authoredAt (the patch identity for rebase/amend
-- dedupe) and the PR walker now emits each PR's branch commits. Re-walk both
-- sources so existing rows gain authoredAt and existing PRs contribute their
-- branch commits. No schema change — payload is free JSON.
DELETE FROM sync_state WHERE source IN ('commits', 'prs');
