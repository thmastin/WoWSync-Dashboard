// Deterministic, provider-neutral access to canonical Markdown research. This
// deliberately indexes configured documents only: it is not a filesystem
// browser, a web fetcher, or an executable-document mechanism.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export type ResearchDocumentClass = "VERSIONED_RESEARCH" | "OPERATIONAL_TRUTH";

export interface ResearchDocumentRegistration {
  documentId: string;
  title: string;
  documentClass: ResearchDocumentClass;
  /** Path relative to the configured canonical root; never an arbitrary caller path. */
  canonicalPath: string;
  version?: string;
  expansion?: string;
  patch?: string;
  season?: string;
  researchSnapshot?: string;
}

export interface ResearchCitation { url: string; label?: string }
export interface ResearchSection {
  sectionId: string;
  heading: string;
  level: number;
  parentSectionId?: string;
  markdown: string;
  citations: ResearchCitation[];
}
export interface ResearchDocument extends ResearchDocumentRegistration {
  contentHash: string;
  markdown: string;
  sections: ResearchSection[];
  citations: ResearchCitation[];
}
export interface ResearchSearchQuery {
  query: string;
  documentClass?: ResearchDocumentClass;
  documentId?: string;
  version?: string;
  patch?: string;
  season?: string;
  limit?: number;
}
export interface ResearchSearchMatch {
  document: Pick<ResearchDocument, "documentId" | "title" | "documentClass" | "version" | "expansion" | "patch" | "season" | "researchSnapshot" | "contentHash">;
  section: Pick<ResearchSection, "sectionId" | "heading" | "level">;
  snippet: string;
  citations: ResearchCitation[];
}

const URL_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<)>]+)/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;

function slug(value: string): string {
  const result = value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return result || "section";
}

function citations(markdown: string): ResearchCitation[] {
  const out: ResearchCitation[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(URL_RE)) {
    const url = match[2] ?? match[3];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, ...(match[1] ? { label: match[1] } : {}) });
  }
  return out;
}

function excerpt(markdown: string, term: string): string {
  const compact = markdown.replace(/\s+/g, " ").trim();
  const index = compact.toLowerCase().indexOf(term.toLowerCase());
  if (index < 0) return compact.length > 240 ? `${compact.slice(0, 239)}…` : compact;
  const start = Math.max(0, index - 80);
  const prefix = start > 0 ? "…" : "";
  const hasMore = start + (240 - prefix.length) < compact.length;
  const room = 240 - prefix.length - (hasMore ? 1 : 0);
  const raw = compact.slice(start, start + room);
  return `${prefix}${raw}${start + room < compact.length ? "…" : ""}`;
}

/** Parses headings without interpreting Markdown instructions, links, or code. */
export function parseResearchMarkdown(markdown: string): ResearchSection[] {
  const headings = [...markdown.matchAll(HEADING_RE)].map((match) => ({ index: match.index ?? 0, end: (match.index ?? 0) + match[0].length, level: match[1].length, heading: match[2].trim() }));
  const used = new Map<string, number>();
  return headings.map((current, index) => {
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= current.level);
    const rawId = slug(current.heading);
    const count = (used.get(rawId) ?? 0) + 1;
    used.set(rawId, count);
    const sectionId = count === 1 ? rawId : `${rawId}-${count}`;
    const parent = [...headings.slice(0, index)].reverse().find((candidate) => candidate.level < current.level);
    const parentRaw = parent ? slug(parent.heading) : undefined;
    const parentCount = parentRaw ? used.get(parentRaw) : undefined;
    const body = markdown.slice(current.end, next?.index ?? markdown.length).trim();
    return { sectionId, heading: current.heading, level: current.level, ...(parentRaw ? { parentSectionId: parentCount === 1 ? parentRaw : `${parentRaw}-${parentCount}` } : {}), markdown: body, citations: citations(body) };
  });
}

export class ResearchRegistry {
  private readonly canonicalRoot: string;
  private readonly registrations: readonly ResearchDocumentRegistration[];
  constructor(canonicalRoot: string, registrations: readonly ResearchDocumentRegistration[]) {
    this.canonicalRoot = canonicalRoot;
    this.registrations = registrations;
  }

  listDocuments(documentClass?: ResearchDocumentClass): ResearchDocument[] {
    return this.registrations
      .filter((registration) => !documentClass || registration.documentClass === documentClass)
      .map((registration) => this.read(registration))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  getDocument(documentId: string): ResearchDocument | undefined {
    const registration = this.registrations.find((entry) => entry.documentId === documentId);
    return registration ? this.read(registration) : undefined;
  }

  getSection(documentId: string, sectionId: string): { document: ResearchDocument; section: ResearchSection } | undefined {
    const document = this.getDocument(documentId);
    const section = document?.sections.find((entry) => entry.sectionId === sectionId);
    return document && section ? { document, section } : undefined;
  }

  search(query: ResearchSearchQuery): ResearchSearchMatch[] {
    const terms = query.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
    const matches: Array<ResearchSearchMatch & { score: number }> = [];
    for (const document of this.registrations
      .filter((entry) => (!query.documentClass || entry.documentClass === query.documentClass) && (!query.documentId || entry.documentId === query.documentId) && (!query.version || entry.version === query.version) && (!query.patch || entry.patch === query.patch) && (!query.season || entry.season === query.season))
      .map((entry) => this.read(entry))) {
      for (const section of document.sections) {
        const title = document.title.toLowerCase();
        const heading = section.heading.toLowerCase();
        const body = section.markdown.toLowerCase();
        if (!terms.every((term) => title.includes(term) || heading.includes(term) || body.includes(term))) continue;
        const score = terms.reduce((total, term) => total + (title.includes(term) ? 20 : 0) + (heading.includes(term) ? 10 : 0) + (body.includes(term) ? 1 : 0), 0);
        matches.push({ document: { documentId: document.documentId, title: document.title, documentClass: document.documentClass, version: document.version, expansion: document.expansion, patch: document.patch, season: document.season, researchSnapshot: document.researchSnapshot, contentHash: document.contentHash }, section: { sectionId: section.sectionId, heading: section.heading, level: section.level }, snippet: excerpt(section.markdown, terms[0]), citations: section.citations, score });
      }
    }
    return matches.sort((a, b) => b.score - a.score || a.document.title.localeCompare(b.document.title) || a.section.sectionId.localeCompare(b.section.sectionId)).slice(0, limit).map(({ score: _score, ...match }) => match);
  }

  private read(registration: ResearchDocumentRegistration): ResearchDocument {
    const target = path.resolve(this.canonicalRoot, registration.canonicalPath);
    const root = path.resolve(this.canonicalRoot) + path.sep;
    if (!target.startsWith(root)) throw new Error(`Research registration path escapes canonical root: ${registration.documentId}`);
    const markdown = readFileSync(target, "utf8");
    const sections = parseResearchMarkdown(markdown);
    return { ...registration, contentHash: `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`, markdown, sections, citations: citations(markdown) };
  }
}

/** Current transition manifest: Dashboard docs are the only extant copies until a reviewed move to wow-stuff/truth. */
export const DASHBOARD_RESEARCH_REGISTRATIONS: readonly ResearchDocumentRegistration[] = [
  { documentId: "midnight-12-1-endgame", title: "Midnight 12.1 Endgame Research", documentClass: "VERSIONED_RESEARCH", canonicalPath: "MIDNIGHT_12_1_ENDGAME_RESEARCH.md", version: "retail", expansion: "Midnight", patch: "12.1.x", season: "Season 2", researchSnapshot: "2026-09-25" },
  { documentId: "midnight-12-1-renown", title: "Midnight 12.1 Renown & Reputation Research", documentClass: "VERSIONED_RESEARCH", canonicalPath: "MIDNIGHT_12_1_RENOWN_REPUTATION_RESEARCH.md", version: "retail", expansion: "Midnight", patch: "12.1.x", season: "Season 2", researchSnapshot: "2026-09-28" },
  { documentId: "midnight-level-90-guide", title: "Midnight Level 90 Endgame Guide", documentClass: "VERSIONED_RESEARCH", canonicalPath: "MIDNIGHT_LEVEL_90_ENDGAME_GUIDE.md", version: "retail", expansion: "Midnight", patch: "12.1.x", season: "Season 2", researchSnapshot: "2026-09-25" },
  { documentId: "midnight-crafters-guide", title: "Midnight Crafter's Guide", documentClass: "VERSIONED_RESEARCH", canonicalPath: "MIDNIGHT_CRAFTERS_GUIDE.md", version: "retail", expansion: "Midnight", patch: "12.1.x", season: "Season 2", researchSnapshot: "2026-09-25" },
];
