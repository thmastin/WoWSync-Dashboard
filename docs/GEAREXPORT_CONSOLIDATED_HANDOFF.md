# GearExport consolidated Windows handoff — Forever launch co-pilot

- Status: **requires Tate authorization** to modify GearExport (`D:\dev\wow-addons\GearExport`). Nothing here has been implemented in the addon.
- Prepared: 2026-10-12, from Omarchy.
- Supersedes: [`GEAREXPORT_PROFESSION_HANDOFF.md`](GEAREXPORT_PROFESSION_HANDOFF.md) (profession-only). That document's §2 data contracts are still the profession contracts referenced below.

## 0. Source-of-truth warning

The Omarchy copies of GearExport are **behind Windows**:

| Copy | SHA |
|---|---|
| `~/src/GearExport` | `adef680` (Retail gear candidates) |
| `~/src/GearExport-forever-recipes` | `24fc5de` (Forever recipes) |
| `~/src/GearExport-forever-update-resilience` | `79b3e19` |

None of them contains a `C_QuestLog` collector or the Forever item-evidence (`itemEvidence`, `C_Item.GetItemStats`) capture. Yet Rordin's DEV snapshot 180 contains both, so a newer Windows branch produced it.

**Before implementing anything, Codex must:**
1. Inventory the Windows repository: branches, the installed SHA, and `git log --oneline -30`.
2. Reconcile this document against it.
3. Mark each requirement below as already done, partially done, or missing.

Do not reimplement working collectors.

## 1. Existing coverage (evidence-labelled)

Labels:
- **VERIFIED:** live-validated per addon docs.
- **SOURCE:** present in source and reviewed.
- **DEV-EVIDENCE:** present in real DEV snapshots.
- **MISSING**, or **UNKNOWN** where it could not be determined from Omarchy.

| Domain | Retail | Forever 1.60.1 | Classic Era | TBC Anniv. | HC/SSF |
|---|---|---|---|---|---|
| Identity: name, realm, class, race, level, XP | SOURCE | VERIFIED | SOURCE | SOURCE | SOURCE, Dashboard quarantines ambiguous |
| Character GUID in export | UNKNOWN | DEV-EVIDENCE (`sourceCharacterGuid`) | MISSING | MISSING | MISSING |
| Equipment + item links | SOURCE | VERIFIED | SOURCE | SOURCE | SOURCE |
| Item stats / item API evidence | Retail gear-candidate sidecar (SOURCE) | DEV-EVIDENCE (`itemEvidence`); tuple semantics verified on 70291 only | MISSING | MISSING | MISSING |
| Bags | SOURCE | VERIFIED | SOURCE | SOURCE | SOURCE |
| Character bank | SOURCE | VERIFIED (one purchased tab; LAST_SEEN persistence) | SOURCE (visit-scoped) | SOURCE | SOURCE |
| Warband / account bank | SOURCE (`accountBank`) | n/a | n/a | n/a | n/a |
| Guild bank | diagnostic only (`WoWSyncGuildBankDiagnostic.lua`) | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| Gold | SOURCE | VERIFIED | SOURCE | SOURCE | SOURCE |
| Currencies | SOURCE (`currencies`) | MISSING | MISSING | MISSING | MISSING |
| Reputation | SOURCE (`reputation`) | MISSING | MISSING | MISSING | MISSING |
| Combat spec / talents | SOURCE (`combatSpecialization`, `C_Traits`) | MISSING | MISSING (no `GetTalentInfo`) | MISSING | MISSING |
| Professions: name, skill | SOURCE | VERIFIED (`GetProfessions`/`GetProfessionInfo`) | SOURCE | SOURCE | SOURCE |
| Profession specialization | SOURCE | n/a | n/a | n/a | n/a |
| Learned recipes, reagents, output | SOURCE (`professionRecipes`) | SOURCE + DEV-EVIDENCE (Rordin 180) | **MISSING** | **MISSING** | **MISSING** |
| Recipe LAST_SEEN persistence | merged at Dashboard import | **MISSING**: snapshot 190 carried no section | — | — | — |
| Trainer services | SOURCE (name, status, level, cost, skill line; **no spell ID**) | VERIFIED (name, status, level, cost, requirements; **no spell ID**) | SOURCE (name, rank, status, cost, level; **no spell ID**) | SOURCE (as Classic) | SOURCE (as Classic) |
| Known spells | SOURCE | VERIFIED (`C_SpellBook`) | SOURCE | SOURCE | SOURCE |
| Quests | UNKNOWN | DEV-EVIDENCE (`C_QuestLog` sidecar) | MISSING | MISSING | MISSING |
| Playtime | SOURCE | VERIFIED (`RequestTimePlayed`) | SOURCE | SOURCE | SOURCE |
| Location | SOURCE | SOURCE | SOURCE | SOURCE | SOURCE |

## 2. Missing capture requirements, prioritized for Forever launch (2026-11-04)

### P0: Launch-day compatibility

**G1. Addon load on the launch client.**
- Forever `.toc` files declare `## Interface: 16001`. If the launch client reports a different interface number, the addon will be "out of date" and may not load.
- The Lua guards are already per-API (`type()` plus `pcall`) and the hard build allowlist was removed (`79b3e19`), so the TOC is the remaining gate.
- *Hypothesis:* Forever accepts a comma-separated interface list like modern clients. Verify in §7.
- Prepare a one-line TOC update and a release procedure for launch day.

**G2. Capture profile.**
- Keep emitting `captureProfile = "Forever:<clientVersion>:<build>:<interface>"` from the live client values, never constants.
- Dashboard (`75180a0`) accepts any well-formed profile, rejects a sidecar whose profile differs from the export's `Client:` line, and labels non-70291/70338 builds `UNVERIFIED_BUILD`.

### P1: Core co-pilot questions

**G3. Recipe LAST_SEEN persistence (Forever).**
- Retain the last successful `professionRecipes` section in SavedVariables when the panel is not opened.
- Re-emit it with `lastAttemptStale = true` and an unchanged `changedAt`, as the bank and trainer collectors already do.
- Dashboard already carries missing sections forward (`aacd0bc`), so this is redundancy plus correctness for clean reinstalls.

**G4. Classic Era / TBC / HC learned recipes.** See [`GEAREXPORT_PROFESSION_HANDOFF.md`](GEAREXPORT_PROFESSION_HANDOFF.md) §2.1 and §3:
- Use the TradeSkill API, plus the Craft API for Enchanting and Beast Training.
- Rows are learned-only.
- Never expand or collapse headers; record `collapsedHeadersSeen`.

**G5. Trainer offers linked to recipes.**
- No version's trainer collector emits a spell or recipe ID today (`WoWSyncCompat.lua` `C.GetTrainerService`, `WoWSyncForeverTrainers.lua`), so the Dashboard can only join by exact name (DERIVED).
- *Hypothesis:* `GetTrainerServiceItemLink(i)` or `GetTrainerServiceSkillLine(i)` / `GetTrainerServiceSkillReq(i)` exist on Forever. Probe once in §7, guarded.
- Emit `serviceSpellID`/`serviceItemID` only when returned. Contract: §2.2 of the profession handoff.
- Dashboard (`0162049`) already joins by exact ID when present, otherwise by unique exact name as DERIVED.

**G6. Character GUID for all versions.**
- Emit `UnitGUID("player")` in every export record (`identity.guid`).
- The Dashboard uses it to refuse merging a recreated same-name character's history. Today only Forever has it.

**G7. Forever reputation and currencies.**
- *Hypothesis:* Forever exposes `C_Reputation`/`GetFactionInfo`-style APIs and `C_CurrencyInfo`. Verify with the §7 probe.
- Shape: the Retail `reputation` and `currencies` sections. Add a per-entry `scope`; Forever has no Warband.

### P2: Planning depth

**G8. Recipe requirements.**
- Add `requiredSkill` and `facility`/`tools` when an API returns them. Contract: profession handoff §2.3.
- Never derive them from `maxTrivialLevel`.

**G9. Classic/TBC/Forever talents.**
- *Hypothesis:* Classic `GetNumTalentTabs`/`GetTalentInfo`; Forever is UNKNOWN.
- Emit a `talents` section with `{ tab, index, name, rank, maxRank }` when the API exists; otherwise emit nothing.

**G10. Classic/TBC quests.**
- Port the Forever `C_QuestLog` collector if the API exists there; fall back to `GetQuestLogTitle`.
- Use the same section shape as Forever quests.

**G11. Guild bank.**
- Promote the diagnostic to a per-tab, visit-scoped observation:
  - per-tab view/withdraw permission;
  - `ownerScope = "GUILD"`;
  - Retail first, Classic/TBC if the API exists.
- Guild assets must never merge with personal assets. The Dashboard keeps a separate guild ownership domain.

Out of scope for the addon:
- Recipe sources (vendor, drop, quest, reputation) and auction prices. These are external research or data gaps, to be handled by a Dashboard research dataset.
- Any automation, item movement, or UI interaction beyond reading.

## 3. Version-specific API notes

Labels: VERIFIED, SOURCE, or HYPOTHESIS.

- **Forever trainer tuple** is `name, status, texture, requiredLevel` (VERIFIED, build 70009); Classic's is `name, rank, status, expanded`. Never reinterpret texture.
- **Forever professions:** `GetProfessions`/`GetProfessionInfo` are authoritative before the trade-skill window opens (VERIFIED). `C_TradeSkillUI` returns pre-hydration `0/0` (VERIFIED).
- **Forever bank:** `C_Bank.CanViewBank(Enum.BankType.Character)` and `FetchPurchasedBankTabIDs`, followed by `C_Container` (VERIFIED, one tab).
- **Item tuple semantics:** `GetItemInfo` positions are live-corroborated on 70291 only. The Dashboard keeps that interpretation gated to verified builds.
- **Classic Enchanting** uses the Craft API (SOURCE knowledge, HYPOTHESIS for the 1.15.x and 2.5.x clients). Probe both.

## 4. Proposed data contracts

- **Professions:** profession handoff §2.1–2.4, which covers `professionRecipes` (Classic), `trainerOffers`, the requirement fields, and the stale marker.
- `identity.guid: string`, in every version (G6).
- **Forever `reputation` and `currencies`:** same envelope as Retail (`capture`, `revision`, `changedAt`, `source`, `data`). `data.entries[]` holds `{ id, name, standing|quantity, max?, scope }`. Use `completeness = "partial"` unless the API enumerates everything.
- `talents` (G9), `quests` for Classic (G10, Forever shape), `guildBank` tabs (G11): each section carries `observedAt`, `completeness`, `reason` when not complete, and `lastAttemptStale` for retained data.

## 5. Schema and compatibility

- All changes are additive, and every unchanged section stays byte-stable.
- SavedVariables top-level version is unchanged.
- No taint and no UI mutation.
- Every API call is guarded with `type()` and `pcall`. A missing API produces no section or an UNKNOWN reason, never zero.

## 6. Fixtures and automated tests (`tests/*.lua`)

Fixtures to add:
- A Forever launch-build profile string.
- Recipe retention with `lastAttemptStale`.
- A trainer with and without link APIs.
- Classic TradeSkill and Craft panels with collapsed headers.
- GUID present in each version.
- Forever reputation and currency, with the API present and absent.
- Classic talents and quests.
- A guild bank tab without withdraw permission.

All existing Retail, Forever and Classic tests must pass unchanged.

## 7. Installation, rollback, and the single live-validation session

**Install:**
1. Close all clients.
2. Run `scripts/deploy-forever.ps1` for Forever and the normal Classic/TBC deploy.
3. Record the installed SHA.

**Rollback:** reinstall the previously recorded SHA with the same script. SavedVariables additions are ignored by older Dashboard builds and accepted by current ones.

**One session** (each step ends with `/wowsync` and a normal logout to flush SavedVariables):

| # | Character / version | Actions | Confirms |
|---|---|---|---|
| 1 | Rordin (Forever) | open Blacksmithing panel; visit Blacksmithing trainer (all filters); open bank | G3, G5, G6, G7 probe, bank |
| 2 | Rordin (Forever) | relog, do **not** open panel/bank/trainer | G3 stale retention, LAST_SEEN |
| 3 | Hallo (Forever) | open Mining/Engineering panels | multi-character crafters/materials |
| 4 | Classic Era character with a profession | open profession, Enchanting if available, trainer, bank, talents | G4, G9, G10 |
| 5 | TBC Anniversary character | same as 4 | G4 (Jewelcrafting) |
| 6 | Retail character in a guild | open guild bank tab | G11 |
| 7 | Forever, one-shot `/wowsync probe` | prints `type()` of each hypothesis API + one sample | G1, G5, G7, G9 |

## 8. Dashboard ingestion dependencies

| Addon item | Dashboard state on `feature/profession-intelligence` |
|---|---|
| G1, G2 | **Ready** (`75180a0`). |
| G3 | Dashboard carry-forward ready (`aacd0bc`, `dfc6b4b`). `lastAttemptStale` handling for recipes is **TODO** (treat it as LAST_SEEN). |
| G4 | **TODO.** Accept the Classic `professionRecipes` with `recipeKey`; reuse `recipeEvidence.ts` and `recipeIntelligence.ts`. |
| G5 | **Ready.** The join by ID or name exists. The `trainerOffers` section parser is **TODO**. |
| G6 | **TODO.** Use the GUID in `snapshotEvidence`/`recipeEvidence` compatibility for all versions; Forever only today. |
| G7 | **TODO.** Generalize the Retail `characterState` reputation/currency normalizers to Forever with a version guard. |
| G8 | **TODO.** Surface the fields in `get_recipe_reagent_availability` and the crafted assessment craftability. |
| G9, G10, G11 | **TODO.** New version-scoped normalizers. Guild bank goes into the existing shared-storage journal under guild ownership. |

## 9. Copyable Codex prompt

```
Repository: D:\dev\wow-addons\GearExport. Authorized by Tate for this task only.
Do not modify BankCleanup, Herdr, or the Dashboard. Do not deploy.

0. First inventory this repository (branches, installed SHA per docs, git log -30)
   and reconcile it with WoWSync-Dashboard docs/GEAREXPORT_CONSOLIDATED_HANDOFF.md
   (copy provided). Report which items G1-G11 already exist. Do not reimplement
   working collectors.

Implement every missing item, in priority order:
P0  G1 Forever TOC interface strategy for the launch client (prepare a one-line
       update + procedure; verify comma-separated interface support in the probe).
    G2 captureProfile always from live client values.
P1  G3 Forever recipe-section retention with lastAttemptStale (mirror bank/trainer).
    G4 Classic Era/TBC/HC learned recipes per docs/GEAREXPORT_PROFESSION_HANDOFF.md
       §2.1 (TradeSkill + Craft APIs, learned-only rows, never touch headers/filters).
    G5 trainerOffers per profession handoff §2.2 with guarded link APIs.
    G6 identity.guid = UnitGUID("player") in every version.
    G7 Forever reputation + currencies sections, guarded; absent API => no section.
P2  G8 optional requiredSkill/facility/tools on recipe rows when an API returns them.
    G9 talents section where the API exists. G10 Classic/TBC quests (Forever shape).
    G11 guild bank per-tab visit observations with permissions, ownerScope GUILD.
Add a chat-only `/wowsync probe` printing type() and one sample return for every
hypothesis API in §3/§7.

Rules: additive only; byte-stable unchanged sections; type()+pcall around every
API; missing API => no section or UNKNOWN reason, never 0; no taint; no UI
mutation; never infer recipe sources or prices.
Add the §6 fixtures/tests to tests/*.lua; keep every existing test passing.
Update WOWSYNC_SCHEMA.md. Commit on a feature branch, push, and report SHA,
full test output, and every API you could not confirm. Tate runs the single
§7 live session afterwards.
```
