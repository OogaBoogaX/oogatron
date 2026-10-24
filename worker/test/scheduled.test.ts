import { createScheduledController, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

afterEach(() => vi.restoreAllMocks());

describe("scheduled handler", () => {
  it("waits for the sync attempt to finish successfully", async () => {
    const now = new Date().toISOString();
    // A freshly discovered empty roster is a valid quiet sync: no GitHub
    // requests are needed, but cleanup and run bookkeeping still execute.
    await env.DB.prepare("INSERT INTO repos VALUES ('quiet', 'rock', 0, ?, ?)")
      .bind(now, now)
      .run();
    await worker.scheduled(
      createScheduledController({ cron: "*/1 * * * *" }),
      env,
    );
    const run = await env.DB.prepare("SELECT * FROM sync_runs").first<{
      status: string;
      finished_at: string | null;
      detail: string;
    }>();
    expect(run!.status).toBe("ok");
    expect(run!.finished_at).not.toBeNull();
    expect(JSON.parse(run!.detail)).toMatchObject({
      trigger: "cron",
      partial: false,
      eventsWritten: 0,
    });
  });

  it("logs and propagates a failure before D1 can record an attempt", async () => {
    const failure = new Error("D1 unavailable");
    const brokenDB = {
      prepare() {
        throw failure;
      },
    } as unknown as D1Database;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = createScheduledController({
      cron: "*/1 * * * *",
      scheduledTime: 1792872000000,
    });
    await expect(
      worker.scheduled(controller, { ...env, DB: brokenDB }),
    ).rejects.toBe(failure);
    expect(logged).toHaveBeenCalledOnce();
    expect(JSON.parse(logged.mock.calls[0][0])).toEqual({
      event: "cron_sync_failed",
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
      message: "D1 unavailable",
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_runs").first("n"),
    ).toBe(0);
  });
});
