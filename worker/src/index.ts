import { cached } from "./api/cache";
import { preflight, withCors } from "./api/cors";
import { error } from "./api/respond";
import { handleBackfill } from "./api/admin";
import { handleContributor, handleContributors } from "./api/contributors";
import { handleHealth } from "./api/health";
import { handleStats, handleStatsV3 } from "./api/stats";
import { runSync } from "./sync/run";

// Hand-rolled route table: five routes don't justify a router dependency, and
// a future POST /webhook is one added row.
type Handler = (
  env: Env,
  request: Request,
  ...captures: string[]
) => Promise<Response>;

const routes: Array<[method: string, pattern: RegExp, handler: Handler]> = [
  ["GET", /^\/v1\/stats$/, (env, req) => cachedCors(env, req, handleStats)],
  ["GET", /^\/v2\/stats$/, (env, req) => cachedCors(env, req, handleStatsV3)],
  [
    "GET",
    /^\/v1\/contributors$/,
    (env, req) => cachedCors(env, req, handleContributors),
  ],
  [
    "GET",
    /^\/v1\/contributors\/([^/]+)$/,
    (env, req, login) =>
      cachedCors(env, req, (e, r) => handleContributor(e, r, login)),
  ],
  [
    "GET",
    /^\/v1\/health$/,
    async (env, req) => withCors(await handleHealth(env)),
  ],
  ["POST", /^\/admin\/backfill$/, (env, req) => handleBackfill(env, req)],
];

async function cachedCors(
  env: Env,
  request: Request,
  handler: (env: Env, request: Request) => Promise<Response>,
): Promise<Response> {
  return withCors(await cached(env, request, () => handler(env, request)));
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "OPTIONS" &&
      (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/v2/"))
    ) {
      return preflight();
    }
    for (const [method, pattern, handler] of routes) {
      if (request.method !== method) continue;
      const m = pattern.exec(url.pathname);
      if (!m) continue;
      try {
        return await handler(env, request, ...m.slice(1));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          JSON.stringify({
            event: "request_failed",
            path: url.pathname,
            message,
          }),
        );
        return error(500, "internal error");
      }
    }
    return error(404, "not found");
  },

  async scheduled(controller, env): Promise<void> {
    try {
      await runSync(env, "cron");
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "cron_sync_failed",
          cron: controller.cron,
          scheduledTime: controller.scheduledTime,
          message: e instanceof Error ? e.message : String(e),
        }),
      );
      // Let Cloudflare record the failed invocation, including failures before
      // D1 can store an attempt. Swallowing it reports a successful cron event.
      throw e;
    }
  },
} satisfies ExportedHandler<Env>;
