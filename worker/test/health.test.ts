import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const health = async () =>
  (await (await SELF.fetch("https://oogatron.test/v1/health")).json()) as any;
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60000).toISOString();

async function record(status: string, at: string, detail = "{}") {
  await env.DB.prepare(
    `INSERT INTO sync_runs (kind, started_at, finished_at, status, detail)
     VALUES ('incremental', ?, ?, ?, ?)`,
  )
    .bind(at, at, status, detail)
    .run();
}

describe("/v1/health ingestion freshness", () => {
  it("reports an uninitialized service as stale", async () => {
    const body = await health();
    expect(body.last_run).toBeNull();
    expect(body.freshness).toMatchObject({
      healthy: false,
      stale: true,
      last_attempt_at: null,
      last_success_at: null,
      last_success_age_seconds: null,
    });
  });

  it("uses successful checks rather than old event watermarks", async () => {
    const at = minutesAgo(1);
    await record("ok", at, '{"partial":false,"eventsWritten":0}');
    await env.DB.prepare(
      `INSERT INTO sync_state VALUES
       ('entropylab', 'commits', '{"phase":"incremental","since":"2026-01-01T00:00:00Z"}', ?)`,
    )
      .bind(at)
      .run();
    const body = await health();
    expect(body.freshness).toMatchObject({
      healthy: true,
      stale: false,
      last_attempt_at: at,
      last_success_at: at,
    });
    expect(
      body.sync_state["entropylab/commits"].age_seconds,
    ).toBeGreaterThanOrEqual(60);
    expect(body.sync_state["entropylab/commits"].age_seconds).toBeLessThan(65);
  });

  it("does not let a newly generated response hide an old successful run", async () => {
    const at = minutesAgo(60);
    await record("ok", at);
    const body = await health();
    expect(body.last_run.status).toBe("ok");
    expect(body.freshness).toMatchObject({
      healthy: false,
      stale: true,
      stale_after_seconds: 300,
      last_attempt_at: at,
      last_success_at: at,
    });
    expect(Date.parse(body.meta.generated_at)).toBeGreaterThan(Date.parse(at));
  });

  it("keeps a new error unhealthy even after a recent success", async () => {
    const good = minutesAgo(1);
    await record("ok", good);
    await record("error", minutesAgo(0), '{"error":"initialization failed"}');
    const body = await health();
    expect(body.freshness).toMatchObject({
      healthy: false,
      stale: false,
      last_success_at: good,
    });
    expect(body.last_run.detail.error).toBe("initialization failed");
  });

  it("does not count rate-limited ok runs as successful ingestion", async () => {
    const good = minutesAgo(60);
    await record("ok", good);
    await record(
      "ok",
      minutesAgo(0),
      '{"partial":true,"error":"RateLimited: retry later"}',
    );
    const body = await health();
    expect(body.freshness).toMatchObject({
      healthy: false,
      stale: true,
      last_success_at: good,
    });
  });
});
