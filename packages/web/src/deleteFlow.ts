// The outcome of a delete request, decided in one place so a FAILED deletion
// can never look like a successful one.
//
//   deleted      - the server confirmed it removed exactly this character.
//   already-gone - the server says (with its stable CHARACTER_NOT_FOUND code)
//                  that no such character exists. The end state is right, but
//                  THIS action removed nothing, and the UI says so.
//   failed       - anything else: network failure, HTTP 4xx/5xx (including a
//                  404 that is not the server's own "character not found" - a
//                  wrong server, a proxy, an out-of-date build), a body that is
//                  not JSON, or a reply that does not name this character.
//
// Callers must only leave the character page / refresh as "deleted" for the
// first two outcomes, and must show the message for `failed`.
import { ApiError, describeApiError } from "./api.ts";

export type DeleteOutcome =
  | { kind: "deleted" }
  | { kind: "already-gone"; message: string }
  | { kind: "failed"; message: string };

export async function performDelete(
  identityKey: string,
  deleteFn: (identityKey: string) => Promise<{ deleted?: { identityKey?: unknown } }>,
): Promise<DeleteOutcome> {
  try {
    const reply = await deleteFn(identityKey);
    if (reply?.deleted?.identityKey !== identityKey) {
      return { kind: "failed", message: "The server's reply did not confirm that this character was deleted. Nothing was assumed - check the character list." };
    }
    return { kind: "deleted" };
  } catch (err) {
    if (err instanceof ApiError && err.kind === "http" && err.status === 404 && err.code === "CHARACTER_NOT_FOUND") {
      return { kind: "already-gone", message: "This character was already gone - this action removed nothing." };
    }
    // The server REFUSED (an HTTP error): the character was not deleted. But if the request or its
    // reply was lost (network / unparseable / unexpected reply) the deletion may have happened
    // anyway - say so, rather than claiming it did not.
    if (err instanceof ApiError && err.kind !== "http") {
      return {
        kind: "failed",
        message: `Could not confirm the deletion - it may or may not have happened, so check the character list. (${describeApiError(err)})`,
      };
    }
    return { kind: "failed", message: `Not deleted: ${describeApiError(err)}` };
  }
}
