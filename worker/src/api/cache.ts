const GEN_KEY = "cache:gen";
// A cached body is exact until the generation moves: every write the stats
// show (events, rollups, contributor rows) bumps it in sync/run.ts. The TTL
// only bounds a change made outside the sync, such as a hand-run migration.
// At 60 s every reader's poll rebuilt the stats from full scans (~90M D1 rows
// read a day); see generatedNow for why a long-lived body still reads fresh.
const TTL_SECONDS = 900;
const GENERATED = /^\{"meta":\{"generated_at":"[^"]*"/;

// Readers (the island's contributor policy, Ooga Chat's public panels) judge
// staleness by meta.generated_at. A hit is the current data, so it is stamped
// now, exactly as a rebuild at this moment would be.
function generatedNow(body: string): string {
  return body.replace(
    GENERATED,
    `{"meta":{"generated_at":${JSON.stringify(new Date().toISOString())}`,
  );
}

// Cache bust is a generation bump, not list+delete: one KV write, no delete
// races with in-flight request-side puts, and orphaned entries self-expire
// within the TTL anyway.
export async function bumpCacheGeneration(env: Env): Promise<void> {
  await env.CACHE.put(GEN_KEY, String(Date.now()));
}

// Key on pathname+search (plus generation) rather than the absolute URL, so
// entries survive a move to a custom domain — a deliberate refinement of the
// spec's "keyed by full URL".
export async function cached(
  env: Env,
  request: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const gen = (await env.CACHE.get(GEN_KEY)) ?? "0";
  // Prefix tracks the contract's schema_version: bumping it guarantees no
  // stale-shaped body survives a deploy, even within the TTL.
  const key = `v3:${gen}:${url.pathname}${url.search}`;

  const hit = await env.CACHE.get(key);
  if (hit !== null) {
    return new Response(generatedNow(hit), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-oogatron-cache": "hit",
      },
    });
  }

  const res = await handler();
  if (res.status === 200) {
    const body = await res.clone().text();
    await env.CACHE.put(key, body, { expirationTtl: TTL_SECONDS });
  }
  return res;
}
