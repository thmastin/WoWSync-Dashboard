# Ask My Account — live smoke test (opt-in, manual)

`ask.test.ts` (run via `npm test`) never talks to a real LLM provider —
it uses a local mock HTTP server, so it costs nothing and needs no
credentials. This document is the separate, **opt-in** procedure for
exercising the real thing: a real OpenAI account, a real API key, and the
real imported character data already in `data/wowsync.sqlite`. It is
manual and not part of CI — it costs real money per run and its output
requires human judgment (grounding quality isn't something a fixture
assertion can check).

## Setup

1. Make sure you have real WoWSync data imported (Import WoWSync in the
   UI, at least once, for at least one version) so the account context
   isn't empty.
2. Create `.env` at the repo root:
   ```
   OPENAI_API_KEY=sk-...your real key...
   # WOWSYNC_LLM_MODEL=gpt-4o-mini   (optional, this is the default)
   ```
3. `npm run build:web && npm start` (or `npm run dev:server` +
   `npm run dev:web` for iterating), then open the dashboard and click
   **Ask My Account**.

## What to check on every run

- **No fabrication.** The answer never states a number, item, or fact
  that isn't actually present in the account context. If you're not sure
  a claim is grounded, cross-check it against Developer → Export.
- **UNKNOWN ≠ empty.** For a character/section that was never observed
  (e.g. a bank that's never been opened), the answer should say so
  explicitly — never "you have nothing in your bank" when the real
  status is "never observed."
- **Realm/version boundaries respected.** Classic Era and TBC Anniversary
  answers should stay within the realm asked about (or explicitly note
  per-realm figures); Retail answers may correctly combine data
  account-wide. No version's data should ever bleed into another's.
- **Observed change ≠ inferred cause.** A gold or inventory delta between
  two snapshots is a fact; *why* it happened (an AH sale, a vendor
  purchase, a quest reward) is a guess. The answer may offer a guess, but
  only clearly labeled as one — never stated as if it were observed.
- **Says what's missing.** If the context doesn't contain what's needed
  to answer, the answer should say so rather than guess or answer a
  nearby-but-different question.

## Representative questions

These probe the behaviors above; they are deliberately **not** hard-coded
anywhere as fixture answers — grade each run by eye against the rules
above, not against a fixed expected string. Substitute your actual
character/realm names as needed.

1. How much gold do I have on TBC Anniversary?
2. How much total playtime do I have across all my Classic Era characters?
3. Which of my characters are closest to leveling up?
4. What professions am I missing, and on which characters?
5. Do any two of my characters share a realm? Which ones?
6. What changed for [a character who had a recent import] between their
   last two snapshots?
7. Looking at [a character's] gold change between snapshots, can you
   tell me they made an Auction House purchase or sale? *(Expected: no —
   the context only records that gold changed, never the reason; the
   model should not assert a purchase/sale as fact.)*
8. What do we know about [a character]'s bank contents? *(For a
   character whose bank was never observed: expected answer says the
   bank was never observed/opened — not "your bank is empty.")*
9. What's in my bags across all TBC Anniversary characters?
10. Which of my characters haven't been played recently (stale data)?
11. What abilities can [a character] train next, and what will it cost?
12. Based on what you know, what would you recommend I do next? *(Expected: any recommendation is clearly labeled as a suggestion/opinion, not stated as fact.)*

## Recording results

Not automated — if you want a record, copy the question/answer pairs
into a scratch file outside this repo (or a PR description) rather than
committing them; this project doesn't persist conversation history
anywhere, on principle, and a committed transcript would work against
that.
