// HTTP routes for reconciled shared storage (checkpoint C4).
//
//   GET    /api/shared-storage                     the DERIVED projection of the Warband and every guild
//   DELETE /api/shared-storage/warband             explicit deletion of the Warband's stored history
//   DELETE /api/shared-storage/guilds/:guildClubId explicit deletion of one guild's stored history
//
// The server reconciles nothing and queries no tables: it serializes `store.projectSharedStorage()`
// (sharedStorageApi.ts) and calls the typed `store.deleteSharedStorageOwner(owner)`. Owners are always
// built server-side from a fixed route (`warband`) or the route's opaque guild id; a client never sends a
// serialized owner key as identity (the key only appears as a CONFIRMATION, matched against the owner the
// route already named).
//
// Security is the server's existing baseline, unchanged: the app-wide hostGuard (Host for every request,
// Origin for state-changing ones), no CORS headers, and no route reachable beyond the bind address.
// Deletion additionally needs a JSON body that confirms the owner (a non-JSON body is not parsed, so it
// can never confirm anything).
import type { Express, Request, Response } from "express";
import {
  SharedStorageIntegrityError,
  buildSharedStorageResponse,
  guildOwner,
  ownerKey,
  parseOwnerKey,
  sharedOwnerIdentity,
  warbandOwner,
  type DeleteSharedStorageOwnerResponse,
  type SharedStorageIntegrityErrorBody,
  type SharedStorageOwner,
  type SnapshotStore,
} from "@wowsync-dashboard/core";

const MAX_GUILD_CLUB_ID_LENGTH = 200;

/**
 * GuildClubID is opaque text: it is never parsed, normalized or re-encoded. This only rejects what cannot
 * be an id (empty, or padded with whitespace, which would otherwise silently change identity), plus control
 * characters and absurd lengths. Returns the problem, or undefined when the id is acceptable as given.
 */
export function guildClubIdProblem(id: string): string | undefined {
  if (id.length === 0) return "it is empty";
  if (id !== id.trim()) return "it has leading or trailing whitespace";
  if (id.length > MAX_GUILD_CLUB_ID_LENGTH) return `it is longer than ${MAX_GUILD_CLUB_ID_LENGTH} characters`;
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code < 32 || code === 127) return "it contains control characters";
  }
  return undefined;
}

/** The body for a shared-storage integrity failure: distinct code, named damaged owners, no stack, no SQL. */
export function integrityErrorBody(err: SharedStorageIntegrityError, whatWasNotDone: string): SharedStorageIntegrityErrorBody {
  return {
    error:
      `${whatWasNotDone} The stored shared-storage journal failed its integrity check, so nothing was skipped or guessed. ` +
      "A damaged owner (the Warband or a guild) can be cleared with the explicit shared-storage delete operation; " +
      "a later WoWSync export may add it again.",
    code: "SHARED_STORAGE_INTEGRITY",
    damagedOwners: err.ownerKeys.map((key) => {
      const owner = parseOwnerKey(key);
      if (!owner) return { ownerKey: key };
      return owner.kind === "guild" ? { ownerKey: key, kind: "guild" as const, guildClubId: owner.guildClubId } : { ownerKey: key, kind: "warband" as const };
    }),
  };
}

export function registerSharedStorageRoutes(app: Express, store: SnapshotStore): void {
  // The reconciled state of every shared-storage owner. Derived (never OBSERVED as a whole), read-time, and
  // deliberately separate from AccountFacts / totals / search / diffs / AccountContext / the LLM context.
  // Empty is a normal answer: { warband: null, guilds: [] }. `?now=<unix seconds>` mirrors /api/account-context
  // (reproducible ages); omitted, it is the wall clock.
  app.get("/api/shared-storage", (req, res) => {
    const rawNow = req.query.now;
    const now = rawNow !== undefined ? (typeof rawNow === "string" && rawNow.trim() !== "" ? Number(rawNow) : NaN) : Math.floor(Date.now() / 1000);
    if (!Number.isFinite(now)) {
      return res.status(400).json({ error: `Invalid "now" query parameter: must be a Unix timestamp in seconds.` });
    }
    try {
      res.json(buildSharedStorageResponse(store.projectSharedStorage(), now));
    } catch (err) {
      if (err instanceof SharedStorageIntegrityError) {
        return res.status(500).json(integrityErrorBody(err, "The shared-storage state cannot be shown."));
      }
      throw err;
    }
  });

  // EXPLICIT, destructive, owner-scoped: deletes the named owner's stored shared-storage HISTORY (its
  // observations and their provenance). It clears stored history; it is not permanent. A later WoWSync
  // export that carries a valid observation for the owner is new evidence and may add it again (the addon
  // keeps carrying what it last saw). Re-importing an export that is already stored is a duplicate import
  // and restores nothing. Character deletion never does this; this never touches characters or snapshots.
  //
  // Mirrors DELETE /api/characters/:identityKey: a JSON body must confirm the owner, then
  //   400 - missing/malformed confirmation, a confirmation that does not match, or an invalid guild id
  //   404 - the owner has no stored history (code SHARED_OWNER_NOT_FOUND; nothing was deleted)
  //   200 - { deleted: { owner, existed: true, observationsDeleted, sourcesDeleted } }
  function deleteOwner(req: Request, res: Response, owner: SharedStorageOwner) {
    const key = ownerKey(owner);
    const confirm: unknown = req.body?.confirmOwnerKey;
    if (typeof confirm !== "string" || confirm.length === 0) {
      return res.status(400).json({
        error: `Deleting shared-storage history requires confirmation: send {"confirmOwnerKey": "${key}"} as a JSON body naming the owner in the URL.`,
        code: "CONFIRMATION_REQUIRED",
      });
    }
    // A display guild name may accompany the request; it is never identity, so it is not consulted.
    if (confirm !== key) {
      return res.status(400).json({ error: "Confirmation does not match the shared-storage owner being deleted. Nothing was deleted.", code: "CONFIRMATION_MISMATCH" });
    }
    const result = store.deleteSharedStorageOwner(owner);
    if (!result.existed) {
      return res.status(404).json({ error: "No stored shared-storage history for this owner (it may already have been deleted).", code: "SHARED_OWNER_NOT_FOUND" });
    }
    const body: DeleteSharedStorageOwnerResponse = {
      deleted: { owner: sharedOwnerIdentity(owner), existed: true, observationsDeleted: result.observationsDeleted, sourcesDeleted: result.sourcesDeleted },
    };
    res.json(body);
  }

  // The Warband here is the installation-local account scope ONLY; it is not a Battle.net account id.
  app.delete("/api/shared-storage/warband", (req, res) => deleteOwner(req, res, warbandOwner()));

  // Express has already percent-decoded the parameter exactly once; it is used as given (never Number/BigInt).
  app.delete("/api/shared-storage/guilds/:guildClubId", (req, res) => {
    const id = req.params.guildClubId;
    const problem = guildClubIdProblem(id);
    if (problem) {
      return res.status(400).json({ error: `Invalid GuildClubID: ${problem}. Nothing was deleted.`, code: "INVALID_GUILD_CLUB_ID" });
    }
    return deleteOwner(req, res, guildOwner(id));
  });
}
