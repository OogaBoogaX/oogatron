import type { ActorRef } from "./types";

// The maintainer confirmed that Harry and hotpixelgroup are the same person.
// This maps contribution credits only; it grants no authentication permissions.
// Prefer the immutable source account ID; a conflicting linked ID never maps
// merely because its login resembles the alias.
export function attributedActor(actor: ActorRef): ActorRef {
  if (
    actor.githubId === 19156 ||
    (actor.githubId === null && actor.login?.toLowerCase() === "harry")
  ) {
    return {
      githubId: 2301075,
      login: "hotpixelgroup",
      displayName: null,
      avatarUrl: "https://avatars.githubusercontent.com/u/2301075?v=4",
      typename: "User",
      email: null,
    };
  }
  return actor;
}
