import { attributedActor } from "./attributions";
import { isBot } from "./bots";
import type { ActorRef } from "./types";

interface KnownContributor {
  login: string;
  githubId: number | null;
}

// Resolves ActorRefs to canonical contributor logins, emitting the D1
// statements that create or refresh contributors rows. All known contributors
// are loaded into memory once per run so resolution costs zero subrequests per
// event; events reference their contributor via
// (SELECT id FROM contributors WHERE login = ?) inside the same batch.
//
// Match order: github databaseId (survives login renames) -> login -> commit
// email (noreply parsing, else privacy-preserving hash) -> "ghost" for
// deleted accounts. Raw emails are never stored anywhere.
export class ContributorResolver {
  private byGithubId = new Map<number, KnownContributor>();
  private byLogin = new Map<string, KnownContributor>();
  private history = new Map<
    string,
    { github_id: number; valid_before: string }
  >();

  static async load(db: D1Database): Promise<ContributorResolver> {
    const r = new ContributorResolver();
    const rows = await db
      .prepare("SELECT login, github_id FROM contributors")
      .all<{ login: string; github_id: number | null }>();
    for (const row of rows.results) {
      const known = { login: row.login, githubId: row.github_id };
      r.byLogin.set(row.login.toLowerCase(), known);
      if (row.github_id !== null) r.byGithubId.set(row.github_id, known);
    }
    const history = await db
      .prepare(
        "SELECT login, github_id, valid_before FROM contributor_login_history",
      )
      .all<{ login: string; github_id: number; valid_before: string }>();
    for (const row of history.results)
      r.history.set(row.login.toLowerCase(), row);
    return r;
  }

  // Returns the canonical login for the actor and appends any contributor
  // upsert statements needed to `statements`.
  async resolve(
    db: D1Database,
    actor: ActorRef,
    occurredAt: string,
    statements: D1PreparedStatement[],
  ): Promise<string> {
    let a = actor;
    if (!a.login && !a.githubId && a.email) {
      a = await fromEmail(a);
      // A noreply address embeds the login as of the commit, which may be
      // stale; a known id keeps its current login rather than being renamed.
      if (a.githubId !== null && this.byGithubId.has(a.githubId)) {
        a = { ...a, login: null };
      }
    }
    a = attributedActor(a);
    // Operator-reviewed history is time-bounded. Explicit GitHub IDs always win;
    // a later claimant never inherits old events just by taking the spelling.
    const historical =
      a.login && a.githubId === null
        ? this.history.get(a.login.toLowerCase())
        : null;
    if (historical) {
      if (
        Date.parse(occurredAt) > Date.parse(historical.valid_before) ||
        !Number.isFinite(Date.parse(occurredAt)) ||
        !this.byGithubId.has(historical.github_id)
      )
        throw new Error("Unverified historical contributor identity");
      a = { ...a, githubId: historical.github_id, login: null };
    }
    if (!a.login && !a.githubId) {
      a = { ...a, login: "ghost", displayName: "Deleted user" };
    }

    // Rule 1: known github_id — refresh (handles login renames via UPDATE).
    // Both writes below are guarded like eventUpsertStatements: overlap
    // windows re-resolve the same actors every run, and an unguarded refresh
    // rewrote a contributor row for every re-sent event (~1.4M writes/day).
    if (a.githubId !== null && this.byGithubId.has(a.githubId)) {
      const known = this.byGithubId.get(a.githubId)!;
      const login = a.login ?? known.login;
      const occupied = this.byLogin.get(login.toLowerCase());
      if (occupied && occupied !== known)
        throw new Error("Contributor identity collision");
      statements.push(
        db
          .prepare(
            `UPDATE contributors SET
               login = ?1, display_name = COALESCE(?3, display_name),
               avatar_url = COALESCE(?4, avatar_url),
               first_seen_at = MIN(COALESCE(first_seen_at, ?2), ?2),
               last_seen_at  = MAX(COALESCE(last_seen_at, ?2), ?2)
             WHERE github_id = ?5 AND (
               login IS NOT ?1
               OR display_name IS NOT COALESCE(?3, display_name)
               OR avatar_url   IS NOT COALESCE(?4, avatar_url)
               OR first_seen_at IS NOT MIN(COALESCE(first_seen_at, ?2), ?2)
               OR last_seen_at  IS NOT MAX(COALESCE(last_seen_at, ?2), ?2))`,
          )
          .bind(login, occurredAt, a.displayName, a.avatarUrl, a.githubId),
      );
      if (known.login !== login) {
        this.byLogin.delete(known.login.toLowerCase());
        known.login = login;
        this.byLogin.set(login.toLowerCase(), known);
      }
      return login;
    }

    const login = a.login!;
    const occupied = this.byLogin.get(login.toLowerCase());
    if (occupied && a.githubId !== null && occupied.githubId !== a.githubId)
      throw new Error("Contributor identity collision");

    // Rule 2/3: upsert by login only when identity is compatible. Attaching an
    // ID to a previously unverified login requires a separately reviewed repair.
    statements.push(
      db
        .prepare(
          `INSERT INTO contributors
             (github_id, login, display_name, avatar_url, is_bot, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(login) DO UPDATE SET
             github_id     = COALESCE(excluded.github_id, contributors.github_id),
             display_name  = COALESCE(excluded.display_name, contributors.display_name),
             avatar_url    = COALESCE(excluded.avatar_url, contributors.avatar_url),
             is_bot        = MAX(excluded.is_bot, contributors.is_bot),
             first_seen_at = MIN(COALESCE(contributors.first_seen_at, excluded.first_seen_at), excluded.first_seen_at),
             last_seen_at  = MAX(COALESCE(contributors.last_seen_at, excluded.last_seen_at), excluded.last_seen_at)
           WHERE contributors.github_id IS NOT COALESCE(excluded.github_id, contributors.github_id)
              OR contributors.display_name IS NOT COALESCE(excluded.display_name, contributors.display_name)
              OR contributors.avatar_url IS NOT COALESCE(excluded.avatar_url, contributors.avatar_url)
              OR contributors.is_bot IS NOT MAX(excluded.is_bot, contributors.is_bot)
              OR contributors.first_seen_at IS NOT MIN(COALESCE(contributors.first_seen_at, excluded.first_seen_at), excluded.first_seen_at)
              OR contributors.last_seen_at IS NOT MAX(COALESCE(contributors.last_seen_at, excluded.last_seen_at), excluded.last_seen_at)`,
        )
        .bind(
          a.githubId,
          login,
          a.displayName,
          a.avatarUrl,
          Number(isBot(login, a.typename)),
          occurredAt,
          occurredAt,
        ),
    );

    const existing = this.byLogin.get(login.toLowerCase());
    if (!existing) {
      const known = { login, githubId: a.githubId };
      this.byLogin.set(login.toLowerCase(), known);
      if (a.githubId !== null) this.byGithubId.set(a.githubId, known);
    }
    return login;
  }
}

const NOREPLY_WITH_ID = /^(\d+)\+(.+)@users\.noreply\.github\.com$/;
const NOREPLY_PLAIN = /^(.+)@users\.noreply\.github\.com$/;

async function fromEmail(a: ActorRef): Promise<ActorRef> {
  const email = a.email!.trim().toLowerCase();
  const withId = NOREPLY_WITH_ID.exec(email);
  if (withId) return { ...a, githubId: Number(withId[1]), login: withId[2] };
  const plain = NOREPLY_PLAIN.exec(email);
  if (plain) return { ...a, login: plain[1] };
  return { ...a, login: `email:${await emailHash(email)}` };
}

// 64 bits of SHA-256 is collision-proof at this project's scale and keeps
// synthesized logins short. The raw email never leaves this function.
async function emailHash(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(email),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
