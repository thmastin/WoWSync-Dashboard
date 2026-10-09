import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import {
  DASHBOARD_RESEARCH_REGISTRATIONS,
  DashboardReadModel,
  READ_MODEL_VERSIONS,
  ResearchRegistry,
  SqliteSnapshotReadStore,
  type ResearchDocumentClass,
  type VersionOrUnknown,
} from "@wowsync-dashboard/core";
import { z } from "zod";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const DEFAULT_DATABASE_PATH = path.join(REPO_ROOT, "data", "wowsync.sqlite");
const DEFAULT_RESEARCH_ROOT = path.join(REPO_ROOT, "docs");
const MAX_CHARACTER_LIST = 100;
const DEFAULT_CHARACTER_LIST = 50;
const MAX_CURRENCIES = 100;
const DEFAULT_RESEARCH_HITS = 5;
const MAX_RESEARCH_HITS = 8;
const MAX_SECTION_CHARACTERS = 20_000;
const MAX_DOCUMENT_CHARACTERS = 40_000;

const versionSchema = z.enum(READ_MODEL_VERSIONS as unknown as [VersionOrUnknown, ...VersionOrUnknown[]]);
const nameSchema = z.string().trim().min(1).max(64);
const realmSchema = z.string().trim().min(1).max(64);
const limitSchema = z.number().int().min(1);
const documentClassSchema = z.enum(["VERSIONED_RESEARCH", "OPERATIONAL_TRUTH"]);
const toolAnnotations = { readOnlyHint: true, openWorldHint: false, destructiveHint: false } as const;

export interface WoWSyncMcpConfiguration {
  /** Process configuration only. MCP callers cannot select databases. */
  databasePath?: string;
  /** Process configuration only. MCP callers cannot select research roots. */
  researchRoot?: string;
}

export interface WoWSyncMcpServer {
  server: McpServer;
  close(): Promise<void>;
}

export function defaultMcpConfiguration(): Required<WoWSyncMcpConfiguration> {
  return { databasePath: DEFAULT_DATABASE_PATH, researchRoot: DEFAULT_RESEARCH_ROOT };
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function safeFailure(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }],
    structuredContent: { error: { code, message } },
    isError: true,
  };
}

function documentMetadata(document: ReturnType<ResearchRegistry["listDocuments"]>[number]) {
  return {
    documentId: document.documentId,
    title: document.title,
    documentClass: document.documentClass,
    version: document.version,
    expansion: document.expansion,
    patch: document.patch,
    season: document.season,
    researchSnapshot: document.researchSnapshot,
    contentHash: document.contentHash,
    citations: document.citations,
  };
}

/**
 * A deliberately thin MCP adapter. Its only data dependencies are the strict
 * read-only SQLite store and the registered-path ResearchRegistry. It never
 * constructs SqliteSnapshotStore or exposes SQL, files, HTTP, or commands.
 */
export function createWoWSyncMcpServer(configuration: WoWSyncMcpConfiguration = {}): WoWSyncMcpServer {
  const defaults = defaultMcpConfiguration();
  const store = new SqliteSnapshotReadStore(configuration.databasePath ?? defaults.databasePath);
  const readModel = new DashboardReadModel(store);
  const registry = new ResearchRegistry(configuration.researchRoot ?? defaults.researchRoot, DASHBOARD_RESEARCH_REGISTRATIONS);
  const server = new McpServer(
    { name: "wowsync-readonly", version: "0.1.0" },
    {
      instructions: "Read-only WoWSync retrieval. Require an explicit WoW version for account-state questions. Latest-known data is not guaranteed live; preserve OBSERVED, DERIVED, LAST_SEEN, and UNKNOWN provenance.",
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    },
  );
  let storeClosed = false;
  const closeStore = () => {
    if (storeClosed) return;
    storeClosed = true;
    store.close();
  };
  // serveStdio owns and closes each factory-created server instance. Close its
  // associated read-only database connection when the SDK closes this server.
  server.server.onclose = closeStore;

  server.registerTool("list_versions", {
    title: "List WoWSync version buckets",
    description: "Lists known version-isolated WoWSync buckets. It does not choose a default version.",
    annotations: toolAnnotations,
  }, async () => textResult({ versions: readModel.listVersions() }));

  server.registerTool("list_characters", {
    title: "List characters in one version",
    description: "Returns compact latest-known character summaries for one explicit WoW version. It never aggregates across versions.",
    inputSchema: z.object({ version: versionSchema, realm: realmSchema.optional(), limit: limitSchema.max(MAX_CHARACTER_LIST).optional() }).strict(),
    annotations: toolAnnotations,
  }, async ({ version, realm, limit }) => {
    const characters = readModel.listCharacters({ version, realm });
    const resolvedLimit = limit ?? DEFAULT_CHARACTER_LIST;
    return textResult({ version, realm, characters: characters.slice(0, resolvedLimit), returnedCount: Math.min(characters.length, resolvedLimit), totalCount: characters.length, truncated: characters.length > resolvedLimit });
  });

  const characterQuery = z.object({ version: versionSchema, name: nameSchema, realm: realmSchema.optional() }).strict();
  server.registerTool("get_character_summary", {
    title: "Get a character summary",
    description: "Returns the latest-known compact summary for one explicit-version character. If name and realm are ambiguous, returns AMBIGUOUS rather than guessing.",
    inputSchema: characterQuery,
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getCharacterSummary(query)));
  server.registerTool("get_character_state", {
    title: "Get compact current character state",
    description: "Returns a bounded current snapshot summary for one explicit-version character, with section-level OBSERVED, LAST_SEEN, or UNKNOWN provenance. Historical bank data is never described as current.",
    inputSchema: characterQuery,
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getCharacterState(query)));
  server.registerTool("get_character_spells", {
    title: "Get captured character spellbook",
    description: "Returns a bounded known-spell section from the latest or one selected snapshot. Coverage describes what the client captured; this is not a complete recipe catalogue or pet spellbook.",
    inputSchema: z.object({ ...characterQuery.shape, snapshotId: z.number().int().positive().optional(), query: z.string().trim().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getCharacterSpells(query)));
  server.registerTool("get_character_trainer", {
    title: "Get captured trainer observations",
    description: "Returns bounded trainer visit evidence from the latest or one selected character snapshot. statusAtVisit is preserved verbatim; available/known/unavailable are observations at visit time, not inferred current learnability or a complete recipe list.",
    inputSchema: z.object({ ...characterQuery.shape, snapshotId: z.number().int().positive().optional(), category: z.string().trim().min(1).max(64).optional(), status: z.enum(["known", "available", "unavailable", "other"]).optional(), query: z.string().trim().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getCharacterTrainer(query)));
  server.registerTool("get_character_history", {
    title: "Get recent character snapshot history",
    description: "Returns a compact newest-first timeline for one explicit-version character. Defaults to 20 snapshots, caps at 100, and uses offset paging; raw snapshots are never returned.",
    inputSchema: z.object({ ...characterQuery.shape, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getCharacterSnapshotHistory(query)));
  server.registerTool("get_character_changes", {
    title: "Compare character snapshots",
    description: "Compares previous to latest for one explicit-version character, or compares two snapshot IDs belonging to that character. Returns bounded semantic changes and explicit UNKNOWN/LAST_SEEN/non-comparable section states.",
    inputSchema: z.object({ ...characterQuery.shape, fromSnapshotId: z.number().int().positive().optional(), toSnapshotId: z.number().int().positive().optional() }).strict().refine((query) => (query.fromSnapshotId === undefined) === (query.toSnapshotId === undefined), "fromSnapshotId and toSnapshotId must be supplied together."),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getCharacterChanges(query)));
  server.registerTool("get_account_overview", {
    title: "Get version-scoped account overview and economy",
    description: "Returns bounded version-scoped account facts, known gold and playtime, progression, profession/currency summaries, and storage coverage. Unknown values remain unknown; Warband and guild storage are not counted as character wealth.",
    inputSchema: z.object({ version: versionSchema }).strict(),
    annotations: toolAnnotations,
  }, async ({ version }) => textResult(readModel.getAccountOverview({ version })));
  server.registerTool("get_account_currencies", {
    title: "Get detailed version-scoped currency evidence",
    description: "Returns bounded currency scope, aggregate evidence, and per-character capture coverage. Realm-partitioned or unrecognized versions require one explicit realm; account-wide balances are represented once and character totals use known quantities only.",
    inputSchema: z.object({ version: versionSchema, realm: realmSchema.optional(), currencyID: z.number().int().positive().optional(), query: z.string().trim().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(), characterOffset: z.number().int().min(0).optional(), characterLimit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getAccountCurrencies(query)));
  server.registerTool("get_account_changes", {
    title: "Get recent version-scoped account changes",
    description: "Returns a bounded page of AccountFacts meaningful character changes, newest observation first. Each entry retains character identity and realm; realm-partitioned version entries are not combined into an economy.",
    inputSchema: z.object({ version: versionSchema, realm: realmSchema.optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getAccountChanges(query)));
  server.registerTool("get_character_equipment", {
    title: "Get latest-known character equipment",
    description: "Returns normal equipment slots from the latest-known explicit-version snapshot, with OBSERVED, LAST_SEEN, or UNKNOWN provenance.",
    inputSchema: characterQuery,
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getCharacterEquipment(query)));
  server.registerTool("get_forever_gear_observation", {
    title: "Get Forever observed equipment and carried items",
    description: "Returns one Forever-version character's observed equipped slots and carried inventory with snapshot/source/freshness provenance. The existing Dashboard identity model has no WoW account identifier, so account scope is explicitly UNKNOWN and limited to this Dashboard import context. Candidate classification remains UNKNOWN unless validated Forever metadata supports it; eligibility, suitability, upgrade status, transferability, and unobserved bank contents remain UNKNOWN. Never applies Retail rules.",
    inputSchema: z.object({ version: z.literal("forever"), name: nameSchema, realm: realmSchema }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getForeverGearObservation(query)));
  server.registerTool("get_forever_gear_allocation", {
    title: "Evaluate observed Forever gear candidates",
    description: "Evaluates exact observed Forever carried candidates against the requested character and screens each candidate against every Dashboard-known Forever character's observed level, equipment slots, and captured equipped stats. Returns explicit Classic-derived armor/weapon proficiency hypotheses separately from confirmed eligibility, exact-variant recorded-stat comparisons, binding category UNKNOWN when target-client semantics are unvalidated, and per-recipient fit/exclusion reasons. Account membership and cross-character transfer access remain UNKNOWN; fit screens are not transfer recommendations and are not ranked without complete validated comparative priority evidence. Never applies Retail rules or initiates gameplay/bank actions.",
    inputSchema: z.object({ version: z.literal("forever"), name: nameSchema, realm: realmSchema }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getForeverGearAllocation(query)));
  server.registerTool("get_character_professions", {
    title: "Get latest-known character professions",
    description: "Returns profession and specialization state plus Retail recipe learned-state observations for one explicit-version character. Recipe candidates are partial, absence never means unlearned, and LAST_SEEN evidence is labeled.",
    inputSchema: characterQuery,
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getCharacterProfessions(query)));
  server.registerTool("get_character_currencies", {
    title: "Get latest-known character currencies",
    description: "Returns at most 100 structured currency records for one explicit-version character. Missing capture remains UNKNOWN, never zero.",
    inputSchema: characterQuery,
    annotations: toolAnnotations,
  }, async (query) => {
    const result = readModel.getCharacterCurrencies(query);
    if (result.status !== "FOUND" || !result.value.data?.currencies) return textResult(result);
    const currencies = result.value.data.currencies;
    const limited = currencies.slice(0, MAX_CURRENCIES);
    return textResult({
      ...result,
      value: {
        ...result.value,
        data: { ...result.value.data, currencies: limited },
        returnedCount: limited.length,
        totalCount: currencies.length,
        truncated: currencies.length > limited.length,
      },
    });
  });

  server.registerTool("search_items", {
    title: "Search observed character items",
    description: "Searches latest-known observed character bags and banks in one explicit version. Shared storage is separate. Results are bounded and include known UNKNOWN storage caveats and item metadata state.",
    inputSchema: z.object({ version: versionSchema, query: z.string().trim().min(1).max(100), storage: z.enum(["bags", "bank"]).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.searchItems(query)));
  server.registerTool("get_character_storage", {
    title: "Get character bags or bank contents",
    description: "Returns one character-owned storage section for an explicit version. Preserves OBSERVED, LAST_SEEN, UNKNOWN, known-empty state, and item metadata state.",
    inputSchema: z.object({ ...characterQuery.shape, storage: z.enum(["bags", "bank"]), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getCharacterStorage(query)));
  server.registerTool("get_shared_storage", {
    title: "Get Warband or guild storage observations",
    description: "Returns bounded Retail Warband or guild storage observations from the shared-storage journal. Preserves owner, accessibility, coverage, OBSERVED/LAST_SEEN carrier provenance, and observation freshness.",
    inputSchema: z.object({ version: versionSchema, kind: z.enum(["warband", "guild"]), guildClubId: z.string().trim().min(1).max(128).optional(), query: z.string().trim().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(), ownerOffset: z.number().int().min(0).optional(), ownerLimit: z.number().int().min(1).max(20).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getSharedStorageContents(query)));
  server.registerTool("get_gear_candidate_evidence", {
    title: "Get Retail gear candidate evidence",
    description: "Returns snapshot-scoped Retail [GEAR CANDIDATES] evidence, latest captured section per character. Shows raw candidate fields and OBSERVED/LAST_SEEN row state with snapshot provenance. Missing sidecars mean not captured, not zero candidates. This tool makes no recipient usability, transferability, upgrade, demand, allocation, surplus, or disposition claims.",
    inputSchema: z.object({ version: versionSchema, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getGearCandidateEvidence(query)));
  server.registerTool("analyze_retail_gear_candidate", {
    title: "Analyze Retail gear candidate allocation",
    description: "Deterministically compares one explicitly referenced Retail candidate snapshot row against all Dashboard-known Retail characters and their retained qualifying per-spec equipment observations. Use get_gear_candidate_evidence first to obtain exporter identityKey, snapshotId and rowOrdinal. Returns eligibility, conservative checked-rule suitability, retained equipment provenance, slot comparison, item-level delta, ties and UNKNOWN reasons. Results are Retail-only; candidate identity remains snapshot-scoped; no transferability or disposition is inferred. Stat lines and item-specific restrictions are absent from candidate evidence, so item-level upgrades are explicitly coarse and not a stat simulation.",
    inputSchema: z.object({ version: z.literal("retail"), exporterIdentityKey: z.string().min(1).max(300), snapshotId: z.number().int().positive(), rowOrdinal: z.number().int().positive() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.analyzeRetailGearCandidate(query)));
  server.registerTool("get_gear_candidate_recipient_screen", {
    title: "Screen Retail gear candidates against recipient evidence",
    description: "For explicitly selected Dashboard-known Retail exporter and recipient characters, screens snapshot-scoped candidate rows against the recipient's OBSERVED known level and captured required level, native armor-family plausibility for clearly identified ordinary body armor, and recipient class-level weapon proficiency/access for supported modern weapon families. Native armor-family mismatches are plausibility-screen results and do not prove that the Retail client technically forbids equipping a lower armor family. Weapon RULED_OUT means only that the checked current Retail class-level proficiency rule identifies a mismatch; UNKNOWN includes Hunter one-handed axe/sword and dagger cases because access is specialization-dependent and recipient specialization is not checked by this screen. Results are RULED_OUT, NOT_RULED_OUT_BY_CHECKED_RULES, or UNKNOWN; positive results do not mean CanEquip. Weapon PASS does not establish specialization suitability, ability compatibility, weapon pairing, primary-stat suitability, or upgrade value. Exposes recipient class evidence, snapshot and row provenance, states that Battle.net account membership is not established, and lists unchecked item-specific restrictions including allowed class, race, faction, profession, unique/equip, and other requirements. It does not assess recipient suitability, upgrades, transferability, demand, allocation, surplus, or disposition.",
    inputSchema: z.object({ version: z.literal("retail"), exporterName: nameSchema, exporterRealm: realmSchema, recipientName: nameSchema, recipientRealm: realmSchema, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getGearCandidateRecipientScreen(query)));
  server.registerTool("get_item_allocation", {
    title: "Get deterministic item allocation decision",
    description: "Returns the deterministic Azeroth ERP allocation decision for one explicit-version base item against its currently active STOCK_TARGET demand, if any. Distinguishes confirmed (OBSERVED) from potential (LAST_SEEN) availability, surfaces unresolved (UNKNOWN) account-owned storage explicitly, never routes guild-owned evidence into account surplus, and never treats a missing demand as zero demand. A confirmed floor surplus may still be reported precisely under unresolved evidence, but disposition never recommends the Hellomags sale pipeline while that uncertainty exists. Held-item identity and binding (CONFIRMED and LAST_SEEN tiers reported separately as confirmed/potentialItemStringIdentity and confirmed/potentialBinding row counts; guild rows never contribute): when the confirmed rows' item strings (viewer linkLevel/specID ignored) show variants or include a bare item:<id>, base-item aggregation is not proven and the result is BASE_ITEM_AGGREGATION_UNPROVEN with disposition REQUIRES_REVIEW and no allocated, confirmedDeficit, or confirmedSurplus fields at all. Confirmed bound or binding-unknown rows withhold SEND_HELLOMAGS from a confirmed surplus (REQUIRES_REVIEW, arithmetic unchanged); they are not unresolved evidence. bound=no never certifies that an item is mailable, auctionable, or sale-eligible, and LAST_SEEN identity/binding facts never gate anything.",
    inputSchema: z.object({ version: versionSchema, baseItemId: z.number().int().positive() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getItemAllocation(query)));
  server.registerTool("get_allocation_review", {
    title: "Get account-wide allocation review",
    description: "Returns the deterministic Azeroth ERP account allocation review for one explicit version. 'demanded' lists every active STOCK_TARGET demand with the same allocation result get_item_allocation returns for that item (ordered HOLD_ALLOCATED, REQUIRES_REVIEW, SEND_HELLOMAGS, NO_ACTION, then base item ID; a BASE_ITEM_AGGREGATION_UNPROVEN result is in the REQUIRES_REVIEW group). 'unallocated' lists account-owned base items (character bags, character bank, Warband) with no active demand, ascending base item ID, with confirmed (OBSERVED) and potential (LAST_SEEN) quantities kept separate. Unallocated inventory is NOT surplus: it has no surplus, disposition, or sale recommendation because none can be determined without a demand. Guild-owned evidence is context only and an item held only by a guild is never listed. Nothing unknown is reported as zero: unknown storage is listed once as unresolved storage; an unreported quantity in observed storage is unresolved item-quantity evidence (the storage was observed) and keeps confirmed quantities a floor; an unreported quantity in LAST_SEEN storage is counted in potentialUnknownQuantityRowCount, making potentialQuantity a known floor without affecting confirmed numbers. Each unallocated entry also reports confirmed/potentialItemStringIdentity and confirmed/potentialBinding facts (evidence only; never a disposition), and unallocatedItemStringIdentityCounts counts identity classes over the whole unallocated list, not just the page; entries are never filtered or reordered by class. Both lists are paged independently. 'itemNames' maps each base item ID on the returned demanded page to the item name observed in account-owned evidence (presentation only; an item with no observed name has no key and is identified by its ID). Names are never part of any allocation result and never change allocation, disposition, or counts.",
    inputSchema: z.object({ version: versionSchema, demandedOffset: z.number().int().min(0).optional(), demandedLimit: z.number().int().min(1).max(100).optional(), unallocatedOffset: z.number().int().min(0).optional(), unallocatedLimit: z.number().int().min(1).max(100).optional() }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getAllocationReview(query)));
  server.registerTool("get_item_metadata", {
    title: "Get deterministic item metadata",
    description: "Returns game-client-reported metadata facets for up to 100 base item IDs in one explicit version. KNOWN, UNKNOWN, and conflicting evidence remain distinct.",
    inputSchema: z.object({ version: versionSchema, itemIds: z.array(z.number().int().positive()).min(1).max(100) }).strict(),
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getItemMetadata(query)));

  server.registerTool("get_profession_coverage", {
    title: "Get version-scoped profession coverage",
    description: "Returns deterministic account-level profession coverage and gaps for one explicit version. Its provenance is DERIVED from captured character state.",
    inputSchema: z.object({ version: versionSchema }).strict(),
    annotations: toolAnnotations,
  }, async ({ version }) => textResult(readModel.getProfessionCoverage({ version })));
  server.registerTool("get_renown", {
    title: "Get captured character Renown",
    description: "Returns the captured Renown state for one explicit-version character. WoWSync does not currently capture Renown, so the result is intentionally UNKNOWN with its reason.",
    inputSchema: characterQuery,
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getRenown(query)));

  server.registerTool("list_research_documents", {
    title: "List registered WoW research documents",
    description: "Lists compact metadata and a bounded section outline for registered research only. It never reads caller-supplied filesystem paths or returns document bodies.",
    inputSchema: z.object({ version: z.string().max(64).optional(), patch: z.string().max(64).optional(), season: z.string().max(64).optional(), documentClass: documentClassSchema.optional() }).strict(),
    annotations: toolAnnotations,
  }, async ({ version, patch, season, documentClass }) => {
    const documents = registry.listDocuments(documentClass as ResearchDocumentClass | undefined)
      .filter((document) => (!version || document.version === version) && (!patch || document.patch === patch) && (!season || document.season === season))
      .map((document) => ({ ...documentMetadata(document), sections: document.sections.slice(0, 100).map(({ sectionId, heading, level, parentSectionId }) => ({ sectionId, heading, level, parentSectionId })), sectionsReturned: Math.min(document.sections.length, 100), sectionsTotal: document.sections.length, sectionsTruncated: document.sections.length > 100 }));
    return textResult({ documents, returnedCount: documents.length });
  });
  server.registerTool("search_research", {
    title: "Search registered WoW research",
    description: "Searches registered research headings and bodies and returns compact matching sections. Use get_research_section for one selected section.",
    inputSchema: z.object({ query: z.string().trim().min(1).max(500), version: z.string().max(64).optional(), patch: z.string().max(64).optional(), season: z.string().max(64).optional(), documentClass: documentClassSchema.optional(), limit: limitSchema.max(MAX_RESEARCH_HITS).optional() }).strict(),
    annotations: toolAnnotations,
  }, async ({ query, version, patch, season, documentClass, limit }) => {
    const resolvedLimit = limit ?? DEFAULT_RESEARCH_HITS;
    const candidates = registry.search({ query, version, patch, season, documentClass: documentClass as ResearchDocumentClass | undefined, limit: resolvedLimit + 1 });
    const matches = candidates.slice(0, resolvedLimit);
    return textResult({ matches, returnedCount: matches.length, limit: resolvedLimit, truncated: candidates.length > matches.length });
  });
  server.registerTool("get_research_section", {
    title: "Get one registered research section",
    description: "Returns one registered document section and its citation URLs. IDs are registry IDs, never filesystem paths; long sections are explicitly truncated.",
    inputSchema: z.object({ documentId: z.string().regex(/^[a-z0-9-]+$/).max(128), sectionId: z.string().regex(/^[a-z0-9-]+$/).max(256) }).strict(),
    annotations: toolAnnotations,
  }, async ({ documentId, sectionId }) => {
    const found = registry.getSection(documentId, sectionId);
    if (!found) return safeFailure("RESEARCH_SECTION_NOT_FOUND", "The registered research document or section was not found.");
    const totalCharacters = found.section.markdown.length;
    const markdown = found.section.markdown.slice(0, MAX_SECTION_CHARACTERS);
    return textResult({
      document: documentMetadata(found.document),
      section: {
        sectionId: found.section.sectionId,
        heading: found.section.heading,
        level: found.section.level,
        parentSectionId: found.section.parentSectionId,
        markdown,
        citations: found.section.citations,
      },
      returnedCharacters: markdown.length,
      totalCharacters,
      truncated: markdown.length < totalCharacters,
    });
  });
  server.registerTool("get_research_document", {
    title: "Get one registered WoW research document",
    description: "Returns the bounded Markdown body and metadata for one registered research document. Document IDs resolve only through the fixed registry, never caller-supplied paths.",
    inputSchema: z.object({ documentId: z.string().regex(/^[a-z0-9-]+$/).max(128) }).strict(),
    annotations: toolAnnotations,
  }, async ({ documentId }) => {
    const document = registry.getDocument(documentId);
    if (!document) return safeFailure("RESEARCH_DOCUMENT_NOT_FOUND", "The registered research document was not found.");
    const markdown = document.markdown.slice(0, MAX_DOCUMENT_CHARACTERS);
    return textResult({ document: documentMetadata(document), markdown, returnedCharacters: markdown.length, totalCharacters: document.markdown.length, truncated: markdown.length < document.markdown.length, source: "registered research document" });
  });

  return {
    server,
    async close() {
      try { await server.close(); } finally { closeStore(); }
    },
  };
}
