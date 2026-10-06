import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { attributedActor } from "../src/sync/attributions";
import { persistPage } from "../src/sync/context";
import { ContributorResolver } from "../src/sync/identity";
import { Budget } from "../src/sync/budget";
import { recomputeRollups } from "../src/db/rollups";
import type { ParsedEvent } from "../src/sync/types";

const sha = "c2194a0464b66722d3cc98ac3dc6ff35d085f363";
const at = "2026-10-05T02:39:59Z";
const event: ParsedEvent = {
  type: "commit",
  externalId: sha,
  occurredAt: at,
  actor: {
    githubId: 19156,
    login: "Harry",
    displayName: "Harry Beckwith",
    avatarUrl: "https://avatars.githubusercontent.com/u/19156?v=4",
    typename: "User",
    email: "harry@users.noreply.github.com",
  },
  payload: {
    headline: "Merge branch 'rock' into feat/697-codex32-ms1",
    authoredAt: at,
  },
};
const migrate = () => {
  const migration = env.TEST_MIGRATIONS.find((m) =>
    m.name.startsWith("0010_"),
  )!;
  return env.DB.batch(migration.queries.map((q) => env.DB.prepare(q)));
};
const dropGuards = () =>
  env.DB.batch([
    env.DB.prepare("DROP TRIGGER reject_harry_alias_insert"),
    env.DB.prepare("DROP TRIGGER reject_harry_alias_update"),
  ]);

describe("confirmed contribution alias", () => {
  it("maps the confirmed account before persistence and stays idempotent", async () => {
    expect(attributedActor(event.actor).login).toBe("hotpixelgroup");
    expect(
      attributedActor({ ...event.actor, githubId: null, login: "HARRY" }).login,
    ).toBe("hotpixelgroup");
    const unrelated = { ...event.actor, githubId: 999, login: "Harry" };
    expect(attributedActor(unrelated)).toBe(unrelated);
    const ctx = {
      env,
      db: env.DB,
      budget: new Budget(),
      resolver: await ContributorResolver.load(env.DB),
      eventsWritten: 0,
    };
    await persistPage(ctx, "entropylab", "prs", [event], {});
    expect(ctx.eventsWritten).toBe(1);
    ctx.eventsWritten = 0;
    await persistPage(ctx, "entropylab", "commits", [event], {});
    expect(ctx.eventsWritten).toBe(0);
    expect(
      (await env.DB.prepare("SELECT login, github_id FROM contributors").all())
        .results,
    ).toEqual([{ login: "hotpixelgroup", github_id: 2301075 }]);
    await persistPage(
      ctx,
      "another-repo",
      "prs",
      [{ ...event, type: "pr", externalId: "another-event" }],
      {},
    );
    expect(
      (await env.DB.prepare("SELECT login FROM contributors").all()).results,
    ).toEqual([{ login: "hotpixelgroup" }]);
    const statements: D1PreparedStatement[] = [];
    expect(
      await ctx.resolver.resolve(
        env.DB,
        { ...event.actor, githubId: null, login: null },
        at,
        statements,
      ),
    ).toBe("hotpixelgroup");
  });

  it("repairs legacy credit without changing the event or totals and blocks stale-worker rewrites", async () => {
    await dropGuards();
    await env.DB.prepare(
      "INSERT INTO contributors (id, github_id, login, first_seen_at, last_seen_at) VALUES (1, 19156, 'Harry', ?, ?), (2, 2301075, 'hotpixelgroup', ?, ?)",
    )
      .bind(at, at, at, at)
      .run();
    await env.DB.prepare(
      "INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at, payload) VALUES ('entropylab', 1, 'commit', ?, ?, ?)",
    )
      .bind(sha, at, JSON.stringify(event.payload))
      .run();
    await recomputeRollups(env.DB);
    await migrate();
    const row = await env.DB.prepare("SELECT * FROM activity_events").first();
    expect(row).toMatchObject({
      repo: "entropylab",
      contributor_id: 2,
      external_id: sha,
      occurred_at: at,
      payload: JSON.stringify(event.payload),
      counted: 1,
    });
    expect(
      (await env.DB.prepare("SELECT login FROM contributors").all()).results,
    ).toEqual([{ login: "hotpixelgroup" }]);
    expect(
      (
        await env.DB.prepare(
          "SELECT SUM(count) AS n FROM daily_rollups",
        ).first()
      )?.n,
    ).toBe(1);
    await migrate();
    expect(
      await env.DB.prepare("SELECT * FROM activity_events").first(),
    ).toEqual(row);
    await expect(
      env.DB.batch([
        env.DB.prepare(
          "INSERT INTO contributors (id, github_id, login) VALUES (3, 19156, 'Harry')",
        ),
        env.DB.prepare(
          "UPDATE activity_events SET contributor_id = 3 WHERE external_id = ?",
        ).bind(sha),
      ]),
    ).rejects.toThrow("confirmed contributor alias");
    expect(
      (
        await env.DB.prepare(
          "SELECT login FROM contributors WHERE github_id = 19156",
        ).all()
      ).results,
    ).toHaveLength(0);
    const stats = (await (
      await SELF.fetch("https://oogatron.test/v2/stats")
    ).json()) as any;
    expect(stats.totals.commits).toBe(1);
    expect(stats.contributors.map((c: any) => c.login)).toEqual([
      "hotpixelgroup",
    ]);
  });

  it("combines all alias events while preserving unrelated contributors", async () => {
    await dropGuards();
    await env.DB.prepare(
      "INSERT INTO contributors (id, github_id, login) VALUES (1, 19156, 'Harry'), (2, 2301075, 'hotpixelgroup'), (3, 999, 'someone-else')",
    ).run();
    for (const [repo, externalId, contributor] of [
      ["entropylab", sha, 1],
      ["another-repo", "another-harry-commit", 1],
      ["entropylab", "unrelated", 3],
    ] as const)
      await env.DB.prepare(
        "INSERT INTO activity_events (repo, contributor_id, type, external_id, occurred_at) VALUES (?, ?, 'commit', ?, ?)",
      )
        .bind(repo, contributor, externalId, at)
        .run();
    await migrate();
    expect(
      (
        await env.DB.prepare(
          "SELECT login FROM contributors WHERE github_id = 19156",
        ).all()
      ).results,
    ).toHaveLength(0);
    expect(
      (
        await env.DB.prepare(
          "SELECT contributor_id FROM activity_events WHERE external_id = 'another-harry-commit'",
        ).first()
      )?.contributor_id,
    ).toBe(2);
    expect(
      (
        await env.DB.prepare(
          "SELECT contributor_id FROM activity_events WHERE external_id = 'unrelated'",
        ).first()
      )?.contributor_id,
    ).toBe(3);
    expect(
      (
        await env.DB.prepare(
          "SELECT SUM(count) AS n FROM daily_rollups",
        ).first()
      )?.n,
    ).toBe(3);
  });
});
