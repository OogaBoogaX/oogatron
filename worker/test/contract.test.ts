import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
// The same validator that snapshot.mjs runs before writing a snapshot and
// that the jumbotron's data.js will wrap — fixture and live responses can
// never drift apart without a test failing. It dispatches on schema_version,
// so one checker covers both served shapes.
import { validateStats } from "../../scripts/lib/validate-stats.mjs";
import fixture from "../../harness/fixtures/stats.json";

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO contributors (id, github_id, login, display_name, avatar_url, is_bot, first_seen_at, last_seen_at)
       VALUES (1, 1001, 'alice', 'Alice A', NULL, 0, '2026-01-05T10:00:00Z', '2026-01-05T10:00:00Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO activity_events (contributor_id, type, external_id, occurred_at)
       VALUES (1, 'commit', 'e1', '2026-01-05T10:00:00Z'),
              (1, 'comment_issue', 'e2', '2026-01-06T10:00:00Z')`,
    ),
    // daily_rollups follows from these through migration 0012's triggers.
  ]);
}

describe("stats contract", () => {
  it("harness fixture matches the v3 schema", () => {
    const { ok, errors } = validateStats(fixture);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(
      (fixture as { meta: { schema_version: number } }).meta.schema_version,
    ).toBe(3);
  });

  it("live /v1/stats and /v2/stats responses match their schemas", async () => {
    await seed();
    for (const [path, version] of [
      ["/v1/stats", 2],
      ["/v2/stats", 3],
    ] as const) {
      const res = await SELF.fetch(`https://oogatron.test${path}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { meta: { schema_version: number } };
      expect(body.meta.schema_version).toBe(version);
      const { ok, errors } = validateStats(body);
      expect(errors, path).toEqual([]);
      expect(ok, path).toBe(true);
    }
  });
});
