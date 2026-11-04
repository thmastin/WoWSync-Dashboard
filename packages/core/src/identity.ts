// Stable character identity. Forever characters may share a first name, so
// observed surnames distinguish them; when the surname is UNKNOWN, the source
// GUID is the only safe identity.

import type { CharacterIdentity, CharacterSection, VersionOrUnknown } from "./types.ts";

export function characterIdentity(version: VersionOrUnknown, character: Pick<CharacterSection, "name" | "realm" | "surname">, sourceCharacterGuid?: string): CharacterIdentity {
  const realm = character.realm ?? "unknown-realm";
  const name = character.name ?? "unknown-character";
  const suffix = version === "forever"
    ? character.surname?.trim() ? `${name}::${character.surname.trim()}` : sourceCharacterGuid ? `${name}::guid:${sourceCharacterGuid}` : `${name}`
    : name;
  const key = `${version}::${realm}::${suffix}`.toLowerCase();
  return { version, realm, name, key };
}

/** Display helper only. Surname never participates in canonical identity. */
export function characterDisplayName(character: { name?: string; surname?: string }): string {
  const name = character.name?.trim() ?? "";
  const surname = character.surname?.trim() ?? "";
  if (!surname || name.toLocaleLowerCase().endsWith(` ${surname}`.toLocaleLowerCase())) return name;
  return [name, surname].filter(Boolean).join(" ");
}
