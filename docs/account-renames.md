# Verified contributor account renames

Migration `0011_contributor_identity_guard.sql` and `src/sync/identity.ts` accompany OogaBoogaLand PR #459. Install the migration before deploying the resolver: it reads the history table on every sync. Installation creates an empty history table and guards identity collisions; it moves no events or contributor rows. Merging to `rock` automatically runs production migrations and deploys the Worker, so complete the preflight and reviewed repairs before merging.

Preflight all contributors, not only the account being renamed:

```sql
SELECT lower(login) AS folded_login, count(*) AS rows,
       group_concat(id) AS contributor_ids
FROM contributors
GROUP BY lower(login)
HAVING count(*) > 1;
```

Any result blocks installation. Back up and restore-test D1, inspect each row's numeric GitHub ID and event/rollup ownership, and settle each group through a separately reviewed repair. Do not choose a row by spelling or merge/delete events automatically. Re-run the query under paused ingestion immediately before migration; require zero rows. The migration's first statement creates a case-insensitive unique index and aborts if any group remains, preventing deployment of the new resolver. A login-only or plain-noreply event for one existing row uses that row's stored spelling, preserving its ID and history; it does not create a lowercase duplicate. Explicit IDs still decide ownership.

The numeric GitHub ID remains authoritative. A rename updates the existing contributor row, so activity events, daily rollups, first/last activity and total counts keep their original attribution. A different ID attempting to reuse an occupied login is refused both in the resolver and inside the database transaction. A stale concurrent resolver cannot overwrite the owner. An existing login-only row cannot be adopted just because GitHub now returns an ID for that spelling: stop and review its provenance before a separate repair.

Before activation, pause ingestion and coordinate the OBL character owner/cast update and contributor generation. Export and restore-test D1; record the contributor row ID, GitHub ID, event/rollup counts and both login collisions. Record the last UTC verification that the old login belonged to the numeric ID. The account owner performs the rename; independently verify both public ID-to-login and new-login-to-ID lookups afterward. Insert a `contributor_login_history` row with that conservative cutoff and update the same contributor's login in one atomic D1 batch. OBL's `scripts/account-migration.mjs` prepares reviewable SQL only after those GitHub checks; it executes nothing.

History applies only to events with no numeric ID whose occurrence time is at or before the cutoff. Explicit IDs always win. A later missing-ID event using the old spelling stops the sync for review rather than attributing it to the former owner or the new claimant. Numeric noreply addresses retain their known current identity even when their embedded historical login is stale. Git author names and email addresses are never rewritten.

Verify all event and rollup counts, each repository total, all activity leaderboards and recent/weekly data before resuming. Rebuild KV snapshots with a normal successful sync, wait out the 60-second API cache and refresh OBL's baked snapshot. Resolve any duplicate historical contributor rows through a separately reviewed, backed-up repair; this change deliberately refuses an unverifiable merge. Keep OBL onboarding paused until the character's current `github` owner and new snapshots agree.

The history cutoff cannot be edited or deleted through ordinary writes. Recovery requires a reviewed forward migration and invariant checks. A failed batch must leave the old rows untouched. Local regression tests cover owner-first, claimant-first, occupied destinations, stale-resolver races, login-only adoption, cutoff boundaries, numeric noreply addresses and unchanged event/rollup attribution. Production data and Cloudflare access have not been verified by these tests.
