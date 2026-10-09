// Stable character identity.
//
// WOWSYNC v1's text export does not include a GUID (see WoWSyncRender.lua —
// renderers.character never emits one), even though SavedVariables key
// characters by GUID internally. So identity here is the best available
// stable key: (version, realm, name). This still satisfies the hard
// requirements: same name on different realms never collides (realm is
// part of the key), and characters never collide across WoW versions
// (version is part of the key). If a future export format adds GUID, it
// should be threaded through as an additional, stronger identity field
// without changing this key's shape.

import type { CharacterIdentity, CharacterSection, VersionOrUnknown } from "./types.ts";

export function characterIdentity(version: VersionOrUnknown, character: CharacterSection): CharacterIdentity {
  const realm = character.realm ?? "unknown-realm";
  const name = character.name ?? "unknown-character";
  const key = `${version}::${realm}::${name}`.toLowerCase();
  return { version, realm, name, key };
}

/** Display helper only. Surname never participates in canonical identity. */
export function characterDisplayName(character: { name?: string; surname?: string }): string {
  const name = character.name?.trim() ?? "";
  const surname = character.surname?.trim() ?? "";
  if (!surname || name.toLocaleLowerCase().endsWith(` ${surname}`.toLocaleLowerCase())) return name;
  return [name, surname].filter(Boolean).join(" ");
}
