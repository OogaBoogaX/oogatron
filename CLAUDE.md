# Oogatron — Project Spec

A jumbotron for the voxel world. Oogatron collects contributor analytics from
[OogaBoogaX/entropylab](https://github.com/OogaBoogaX/entropylab), stores them in
Cloudflare D1, serves them from a Cloudflare Worker, and renders them on a voxel
jumbotron screen designed to be integrated into
[OogaBoogaX/oogaboogaland](https://github.com/OogaBoogaX/oogaboogaland) — a
dependency-free WebGL2 floating-island world whose voxel cavemen already represent
entropylab contributors.

This document is the source of truth for scope, architecture, and conventions.
Read it fully before writing code.

---

## Locked decisions

| Decision | Choice |
| --- | --- |
| Repo home | `rules-without-rulers/oogatron` (may transfer to OogaBoogaX later; nothing may depend on the org name) |
| Default branch | `rock` (org convention — entropylab and oogaboogaland both use it) |
| Hosting | Cloudflare Workers + D1 + KV, in the owner's personal Cloudflare account. No Vercel. |
| Ingestion | **Cron polling only.** No webhooks — they require admin on entropylab, which is out of scope. Design so a webhook route can be added later without schema or contract changes. |
| Frontend for integration | Plain JavaScript, **zero runtime dependencies**, no framework, no build requirement — matching oogaboogaland's conventions. No React/Next.js anywhere in the jumbotron module. |
| Integration mode | **Snapshot-first**: oogaboogaland stays zero-network (its CSP and privacy promise forbid runtime requests). Data is baked in at build time. A live-fetch mode may exist in the dev harness only. |
| Data granularity | Event-level storage (not counters), to support arbitrary later filtering by contributor, type, and time window. |
| Per-contributor stats | First-class requirement. The API and the snapshot both carry a full per-contributor breakdown. |

## Repository layout (three pieces)

```
oogatron/
├── CLAUDE.md                  # this file
├── worker/                    # Piece 1 — Cloudflare Worker (the data service)
│   ├── wrangler.toml          # bindings: D1 (DB), KV (CACHE); cron trigger
│   ├── migrations/            # D1 SQL migrations
│   └── src/
│       ├── index.ts           # fetch router + scheduled() handler
│       ├── sync/              # GitHub GraphQL ingestion
│       │   ├── github.ts      # GraphQL client, pagination, rate-limit handling
│       │   ├── repos.ts       # org repo discovery (public, non-fork, non-archived)
│       │   ├── commits.ts     # commit history walker (each repo's default branch)
│       │   ├── prs.ts         # PRs + their reviews
│       │   └── run.ts         # orchestrator: repo round-robin, incremental sync + backfill
│       ├── db/                # typed query helpers over D1
│       └── api/               # /v1/* handlers (JSON, CORS-enabled, KV-cached)
├── jumbotron/                 # Piece 2 — plain-JS voxel display module (no deps)
│   ├── data.js                # parse/validate the stats JSON (shared contract)
│   ├── views.js               # per-view canvas renderers (leaderboard, totals, user card…)
│   ├── screen.js              # offscreen-canvas → WebGL texture on a voxel screen mesh
│   └── jumbotron.js           # public API (see interface below)
├── harness/                   # Piece 3 — standalone dev page
│   ├── index.html             # bare page: minimal WebGL2 context + the jumbotron
│   └── fixtures/stats.json    # sample payload for offline development
├── scripts/
│   └── snapshot.mjs           # fetch /v1/stats → snapshot JSON (used by CI + future oogaboogaland build)
└── .github/workflows/
    ├── ci.yml                 # typecheck, lint, test on PRs and pushes to rock
    └── deploy.yml             # wrangler deploy on merge to rock
```

The worker is TypeScript (it has a build step anyway). The jumbotron and harness
are plain JS with JSDoc types — they must run by opening a file or serving a
static directory, exactly like oogaboogaland's `src/`.

---

## Piece 1 — Worker

### D1 schema

```sql
CREATE TABLE contributors (
  id            INTEGER PRIMARY KEY,
  github_id     INTEGER UNIQUE,           -- NULL for unmatched commit emails
  login         TEXT NOT NULL UNIQUE,     -- or synthesized "email:<hash>" for unmatched
  display_name  TEXT,
  avatar_url    TEXT,
  is_bot        INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT,                     -- ISO 8601
  last_seen_at  TEXT
);

CREATE TABLE activity_events (
  id             INTEGER PRIMARY KEY,
  repo           TEXT NOT NULL DEFAULT 'entropylab',  -- short name; owner is the org constant
  contributor_id INTEGER NOT NULL REFERENCES contributors(id),
  type           TEXT NOT NULL CHECK (type IN
                   ('commit','pr','review','merge','issue','comment_issue','comment_review','comment_commit')),
  external_id    TEXT NOT NULL,           -- commit SHA / GraphQL node id
  occurred_at    TEXT NOT NULL,           -- ISO 8601
  payload        TEXT,                    -- JSON: title, PR number, additions/deletions, state…
  UNIQUE (repo, external_id)              -- idempotent upserts, repo-scoped
);
CREATE INDEX idx_events_contributor_time ON activity_events(contributor_id, occurred_at);
CREATE INDEX idx_events_type_time        ON activity_events(type, occurred_at);
CREATE INDEX idx_events_repo_time        ON activity_events(repo, occurred_at);

CREATE TABLE daily_rollups (              -- recomputed after each sync; serves fast queries
  repo           TEXT NOT NULL DEFAULT 'entropylab',
  day            TEXT NOT NULL,           -- YYYY-MM-DD
  contributor_id INTEGER NOT NULL REFERENCES contributors(id),
  type           TEXT NOT NULL,
  count          INTEGER NOT NULL,
  PRIMARY KEY (repo, day, contributor_id, type)
);

CREATE TABLE sync_runs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,              -- 'backfill' | 'incremental'
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',  -- running | ok | error
  detail      TEXT                        -- error text, cursors, counts
);

CREATE TABLE sync_state (                 -- per-repo per-source incremental cursors
  repo       TEXT NOT NULL,               -- repo short name; '*' holds the rotation pointer
  source     TEXT NOT NULL,               -- 'commits' | 'prs' | 'issue_comments' | 'commit_comments' | 'rotation'
  cursor     TEXT,                        -- last seen timestamp or GraphQL cursor
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, source)
);

CREATE TABLE repos (                      -- discovered org repos (discovery cache)
  name            TEXT PRIMARY KEY,
  default_branch  TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,  -- 0 = archived/excluded/vanished/empty
  discovered_at   TEXT NOT NULL,
  last_checked_at TEXT NOT NULL
);
```

### Ingestion (cron)

- **Schedule:** cron trigger every minute (`crons = ["* * * * *"]`). Each run
  does an incremental sync from the stored cursors; repos without cursors start
  in backfill (also drivable manually via an authenticated
  `POST /admin/backfill`).
- **Repos:** discovered from the **OogaBoogaX org** (public, non-fork,
  non-archived; `EXCLUDED_REPOS` in config opts specific repos out). Discovery
  is TTL-gated (~hourly, `REPO_DISCOVERY_TTL_MINUTES`) and cached in the
  `repos` table with each repo's default branch. Sync loops repos in
  round-robin order resumed from the `'*'/'rotation'` pointer, so one repo's
  backfill can't starve the others.
- **Source of truth:** GitHub **GraphQL API**, authenticated with a
  fine-grained PAT held as a Worker secret (`GITHUB_TOKEN`). All tracked repos
  are public; read-only public-repo scope suffices.
- **What to collect** (commits walk each repo's default branch):
  - `commit` — branch history. Attribute by the commit author's linked GitHub
    user; when a commit has no linked user, match by author email against known
    contributors, else create an unmatched contributor row keyed by a hash of the
    email (never store the raw email in `login`).
  - `pr` — all pull requests, any state, by author.
  - `review` — review submissions on every PR, by reviewer.
  - `merge` — every merged PR, credited to `mergedBy` (whoever pressed the
    button). The payload records the PR's `mergeCommit` oid; rollups exclude
    that auto-generated commit so a merge is exactly one credit (for squash
    merges this shifts the squashed content commit's credit to the merger —
    an accepted, documented rule).
  - `issue` — opening an issue, credited to its author (the issues walker
    sees every issue node anyway, so the event rides along with its comments).
  - `comment_issue` / `comment_review` / `comment_commit` — the three GitHub
    comment surfaces (restored in schema_version 3; served summed as one
    `comments` number).
- **Bots and CI:** entropylab's CI commits build artifacts back to `rock`.
  Maintain a small config list of bot logins/patterns (e.g. `*[bot]`, the CI
  committer); mark them `is_bot = 1`. Bots are stored but **excluded from all
  API responses by default** (`?include_bots=1` overrides).
- **Discipline:** honor GitHub's rate-limit headers with backoff; every upsert is
  idempotent on `external_id`; recompute affected `daily_rollups` and bust the
  KV cache at the end of a successful run; record every run in `sync_runs`.

### HTTP API (versioned, frozen contract)

All responses JSON, CORS `*` for GET, cached in KV (60 s TTL) keyed by full URL.
`meta` appears on every response with the route's schema_version.

Two stats routes are served concurrently from **one shared assembly**
(`api/stats.ts` `assembleModel` + `shapeV2`/`shapeV3`), so site and worker
never need lockstep deploys:

- `GET /v1/stats` — **schema_version 2**, the pre-comments contract, kept
  byte-shaped for older site builds: org `totals`/`leaderboards {commits,prs,
  reviews}`/`contributors` + `repos [{name, totals, weekly}]`. Merges fold
  into commits (deduped); comment activity is invisible here, including in
  the active-contributor counts.
- `GET /v2/stats` — **schema_version 3**, the snapshot format and what the
  island consumes: adds `comments` and `issues` to every totals/weekly/counts
  block and `comments` and `issues` leaderboards; each
  `repos[]` entry gains `last_activity_at` (the jumbotron hides repos idle
  >7 days), its own per-repo `leaderboards {commits,prs,reviews,comments,issues}`,
  and `contributors [{login, last_seen_at}]` — per-repo last activity, which
  is what routes each island Ooga to the cave of the repo they contributed
  to; plus `recent` — the newest 12 events org-wide as `[{login, repo,
  type: commit|pr|review|merge|issue|comment, occurred_at}]`,
  merge-commit-deduped and bot-filtered, where a `pr` row carries
  `draft: true` while that PR is a draft (the ticker's DRAFT PR tag).

Legacy v2 example shape (see the v2 contract test for the source of truth):

```json
{
  "meta": { "generated_at": "…", "org": "OogaBoogaX", "schema_version": 2 },
  "totals": { "contributors": 0, "commits": 0, "prs": 0, "reviews": 0 },
  "leaderboards": {
    "commits":  [ { "login": "…", "count": 0 } ],
    "prs":      [], "reviews": []
  },
  "repos": [
    {
      "name": "entropylab",
      "totals": { "contributors": 0, "commits": 0, "prs": 0, "reviews": 0 },
      "weekly": [ { "week": "2026-W01", "commits": 0, "prs": 0, "reviews": 0 } ]
    }
  ],
  "contributors": [
    {
      "login": "…", "display_name": "…", "avatar_url": "…",
      "first_seen_at": "…", "last_seen_at": "…",
      "counts": { "commits": 0, "prs": 0, "reviews": 0 },
      "weekly": [ { "week": "2026-W01", "commits": 0, "prs": 0, "reviews": 0 } ]
    }
  ]
}
```

- `GET /v1/contributors` — roster only (the `contributors` array minus `weekly`).
- `GET /v1/contributors/{login}` — one contributor's full object; supports
  `?from=`, `?to=` (ISO dates) and `?type=` filters recomputed from
  `activity_events`.
- `GET /v1/health` — last sync run status + row counts.
- `POST /admin/backfill` — bearer-token protected (`ADMIN_TOKEN` secret).

**Contract rules:** additive changes only within a schema_version; the
`contributors` array is always complete (the org has few enough humans that
this stays small), which is what lets snapshot mode filter per-user entirely
client-side. "Total contributors" means the union of humans with ≥1 event of
any type — not GitHub's commit-only contributor count. Contributor identity is
org-global; per-contributor-per-repo splits are deliberately not in the
contract.

---

## Piece 2 — Jumbotron module

Plain JS, zero dependencies, no build. Renders stats onto an offscreen 2D canvas
and uploads it as a WebGL texture on a chunky voxel screen mesh — cheap at
runtime and engine-agnostic until integration.

**Public interface (freeze early):**

```js
// jumbotron.js
export function createJumbotron(gl, options)  // gl: WebGL2RenderingContext
// options: { position, scale, palette, pixelDensity }
// returns:
//   update(statsJson)         // validated via data.js; re-renders current view
//   draw(viewProjMatrix, timeSeconds)
//   setView(name, params)     // 'totals' | 'repo' (name) | 'leaderboard' (type)
//   nextView() / autoRotate(seconds)
//   dispose()
```

**Views:** org totals board (the Live Wire); one totals board per repo (capped
at 6 most-active); leaderboards for commits, PRs, and reviews. Auto-rotation
cycles org totals → repo boards → leaderboards on a timer. (The contributor
card and scrolling ticker were removed along with comment tracking in
schema_version 2.)

**Style:** match oogaboogaland's vector-block look — flat-shaded voxel blocks,
blocky bezel, chunky pixel-grid typography on the canvas (render text large and
snap to a coarse grid for the LED-board feel), palette lifted from
oogaboogaland's `src/` (extract actual values during Phase 4, keep them as named
tokens in one place). Include a Canvas-2D-only fallback path for the display
content, mirroring oogaboogaland's `?canvas2d=1` degradation strategy.

**Data intake:** `data.js` is the only module that understands the JSON shape;
it validates `schema_version`, tolerates unknown extra fields, and computes any
derived values views need. Views never touch raw JSON.

## Piece 3 — Harness

`harness/index.html`: a bare page that creates a WebGL2 context, orbits a camera
around the jumbotron, and loads data from — in order of preference —
`?src=<url>` (the deployed Worker), else `fixtures/stats.json`. Buttons/keys to
switch views and simulate updates. This page is the primary dev loop; it may be
deployed to GitHub Pages as a standalone "oogatron control room" but that is
optional. The harness may fetch over the network; the jumbotron module itself
never fetches — data is always pushed in via `update()`.

---

## Provisioning (one-time, owner's Cloudflare account)

1. `wrangler d1 create oogatron` and `wrangler kv namespace create CACHE` →
   put the returned IDs in `worker/wrangler.toml` (IDs are not secrets; commit them).
2. Cloudflare API token: "Edit Cloudflare Workers" template + D1 edit, scoped to
   the account. Note the Account ID from the dashboard.
3. GitHub repo secrets on `rules-without-rulers/oogatron`:
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
4. Worker secrets (never in the repo): `wrangler secret put GITHUB_TOKEN`
   (fine-grained PAT, public-repo read-only), `wrangler secret put ADMIN_TOKEN`.
5. First deploy: `wrangler d1 migrations apply oogatron --remote`, then
   `wrangler deploy`, then `POST /admin/backfill`, then verify `GET /v1/health`
   and `GET /v1/stats`.

Default `*.workers.dev` URL is fine; custom domain later if desired.

## CI/CD (GitHub Actions — everything defined in-repo, like entropylab)

- `ci.yml` — PRs and pushes to `rock`: install, typecheck (worker), lint, unit
  tests. Same commands locally and in CI; no separate build logic in workflows.
- `deploy.yml` — on push to `rock`: apply D1 migrations, `wrangler deploy` via
  the official `cloudflare/wrangler-action`, using the two repo secrets.
- Keep deploys in Actions (not Cloudflare's git integration) so the setup
  survives a future transfer to the OogaBoogaX org with only a secrets re-check.

## Testing

- **Worker:** unit-test sync parsing against recorded GraphQL fixture responses
  (org repo discovery, commit-email matching, bot filtering, round-robin repo
  rotation, idempotent re-runs); test rollup math and API handlers against a local D1
  (`wrangler d1 execute --local` / miniflare).
- **Jumbotron:** golden-image or pixel-sample tests of the canvas renderers from
  fixture JSON; a headless-browser smoke test that the harness boots with a
  clean console (matching oogaboogaland's clean-console standard).
- **Contract:** one test that validates `fixtures/stats.json` and a live
  `/v1/stats` response against the same schema, so the fixture can never drift.

## Build order

1. **Phase 1 — data is right.** Worker scaffold, migrations, GraphQL sync with
   full backfill of entropylab history, `/v1/health`. Verify counts by hand
   against the GitHub UI (PR count, contributor list). Bugs live in commit-email
   matching and the three comment surfaces — get these right before any pixels.
2. **Phase 2 — API + contract.** `/v1/stats`, `/v1/contributors[/login]`,
   KV caching, `scripts/snapshot.mjs`, fixture generated from real data, CI +
   deploy workflows live.
3. **Phase 3 — jumbotron in the harness.** `data.js`, canvas views (totals,
   leaderboards, contributor card, ticker), voxel screen mesh, auto-rotation,
   Canvas-2D fallback.
4. **Phase 4 — voxel fidelity.** Extract oogaboogaland's actual palette and
   block proportions; tune typography and bezel until the harness screenshot
   reads as native to the island.
5. **Phase 5 — integration PR to oogaboogaland** (separate effort, per its
   AGENTS.md): add the jumbotron as a prop, inline the snapshot JSON in its
   build script, add a scheduled rebuild workflow there, pass its headless
   Chrome suite. Zero runtime network requests — the snapshot preserves
   oogaboogaland's CSP and privacy guarantees. An optional live mode behind a
   URL flag is a future, explicit org decision, not part of this repo's scope.

## Out of scope (deliberately)

- Webhooks on tracked repos (needs repo admin; the per-minute cron covers
  freshness; the router leaves room for a future `POST /webhook`).
- Any React/Next.js UI, any framework in the jumbotron.
- Per-contributor-per-repo COUNT splits (identity stays org-global; per-repo
  last-activity timestamps shipped in schema 3 are the deliberate exception).
- Retiring `/v1/stats`: keep it until no deployed site build polls it, then
  fold shapeV2 away.
- Private data of any kind. Public contributor handles and public activity only,
  matching oogaboogaland's privacy stance.
