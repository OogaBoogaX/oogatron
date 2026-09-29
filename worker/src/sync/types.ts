export type EventType =
  | "commit"
  | "pr"
  | "review"
  | "merge"
  | "issue"
  | "comment_issue"
  | "comment_review"
  | "comment_commit";

// One discovered org repo, as the sync loop consumes it. defaultBranch comes
// from discovery — hardcoding a branch would silently sync nothing for repos
// whose default differs.
export interface RepoRef {
  name: string;
  defaultBranch: string;
}

// A reference to whoever performed an event, as GraphQL reports it. Identity
// resolution (identity.ts) turns this into a contributors row.
export interface ActorRef {
  githubId: number | null;
  login: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  typename: string | null; // "User" | "Bot" | "Mannequin" | "Organization"
  email: string | null; // commit author email when there is no linked user
}

export interface ParsedEvent {
  type: EventType;
  externalId: string;
  occurredAt: string;
  actor: ActorRef;
  payload: Record<string, unknown>;
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

// GraphQL actor shapes as they appear in responses.
export interface GqlActor {
  login: string;
  avatarUrl?: string;
  __typename?: string;
  databaseId?: number | null;
}

export function actorFrom(a: GqlActor | null | undefined): ActorRef {
  if (!a) {
    return {
      githubId: null,
      login: null,
      displayName: null,
      avatarUrl: null,
      typename: null,
      email: null,
    };
  }
  // GraphQL names a Bot actor "dependabot" but the same account's commits
  // "dependabot[bot]". Both carry one databaseId, so without a single
  // canonical form the resolver renames the row back and forth — and a page
  // holding both forms (a bot's PR plus its branch commits) leaves events
  // pointing at a login that no longer exists.
  const login =
    a.__typename === "Bot" && !a.login.endsWith("[bot]")
      ? `${a.login}[bot]`
      : a.login;
  return {
    githubId: a.databaseId ?? null,
    login,
    displayName: null,
    avatarUrl: a.avatarUrl ?? null,
    typename: a.__typename ?? null,
    email: null,
  };
}
