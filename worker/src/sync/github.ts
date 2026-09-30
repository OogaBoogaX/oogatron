import { GITHUB_TIMEOUT_MS } from "../config";
import { Budget } from "./budget";

export class RateLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimited";
  }
}

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ type?: string; message: string }>;
}

export interface GqlResult {
  data: Record<string, unknown>;
  rateRemaining: number;
}

export async function githubGraphQL(
  env: Env,
  budget: Budget,
  query: string,
  variables: Record<string, unknown>,
): Promise<GqlResult> {
  let attempt = 0;
  for (;;) {
    budget.spend();
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `bearer ${env.GITHUB_TOKEN}`,
        "content-type": "application/json",
        "user-agent": "oogatron",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });

    if (res.status === 403 || res.status === 429) {
      await res.body?.cancel();
      throw new RateLimited(`GitHub rate limit response: ${res.status}`);
    }
    if ((res.status === 502 || res.status === 503) && attempt === 0) {
      await res.body?.cancel();
      attempt++;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!res.ok) {
      throw new Error(`GitHub GraphQL HTTP ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as GraphQLResponse;
    if (body.errors?.length) {
      if (body.errors.some((e) => e.type === "RATE_LIMITED")) {
        throw new RateLimited(body.errors[0].message);
      }
      // GitHub returns partial data alongside INTERNAL/NOT_FOUND errors for
      // individual nodes it cannot resolve (e.g. entropylab PR #12 is a ghost
      // record: counted by the connection but unresolvable even via REST).
      // Use the partial data — parsers skip the null node slots.
      const tolerable = body.errors.every(
        (e) => e.type === "INTERNAL" || e.type === "NOT_FOUND",
      );
      if (!body.data || !tolerable) {
        throw new Error(
          `GitHub GraphQL errors: ${JSON.stringify(body.errors)}`,
        );
      }
      console.warn(
        JSON.stringify({
          event: "graphql_partial_response",
          errors: body.errors,
        }),
      );
    }
    if (!body.data) throw new Error("GitHub GraphQL: empty data");

    const rl = body.data["rateLimit"] as { remaining: number } | undefined;
    return { data: body.data, rateRemaining: rl?.remaining ?? Infinity };
  }
}
