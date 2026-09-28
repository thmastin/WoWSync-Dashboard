import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
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
    { instructions: "Read-only WoWSync retrieval. Require an explicit WoW version for account-state questions. Latest-known data is not guaranteed live; preserve OBSERVED, DERIVED, LAST_SEEN, and UNKNOWN provenance." },
  );

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
  server.registerTool("get_character_equipment", {
    title: "Get latest-known character equipment",
    description: "Returns normal equipment slots from the latest-known explicit-version snapshot, with OBSERVED, LAST_SEEN, or UNKNOWN provenance.",
    inputSchema: characterQuery,
    annotations: toolAnnotations,
  }, async (query) => textResult(readModel.getCharacterEquipment(query)));
  server.registerTool("get_character_professions", {
    title: "Get latest-known character professions",
    description: "Returns profession state for one explicit-version character and preserves UNKNOWN or LAST_SEEN instead of inventing empty data.",
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
    description: "Lists compact metadata for registered research only. It never reads caller-supplied filesystem paths or returns full documents.",
    inputSchema: z.object({ version: z.string().max(64).optional(), patch: z.string().max(64).optional(), season: z.string().max(64).optional(), documentClass: documentClassSchema.optional() }).strict(),
    annotations: toolAnnotations,
  }, async ({ version, patch, season, documentClass }) => {
    const documents = registry.listDocuments(documentClass as ResearchDocumentClass | undefined)
      .filter((document) => (!version || document.version === version) && (!patch || document.patch === patch) && (!season || document.season === season))
      .map(documentMetadata);
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

  return {
    server,
    async close() {
      try { await server.close(); } finally { store.close(); }
    },
  };
}
