import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DASHBOARD_RESEARCH_REGISTRATIONS, ResearchRegistry, parseResearchMarkdown } from "../src/researchRegistry.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const registry = new ResearchRegistry(path.join(repoRoot, "docs"), DASHBOARD_RESEARCH_REGISTRATIONS);

test("registered research has stable IDs, deterministic hashes, and explicit versioned class", () => {
  const first = registry.listDocuments();
  const second = registry.listDocuments();
  assert.deepEqual(first.map((document) => [document.documentId, document.contentHash]), second.map((document) => [document.documentId, document.contentHash]));
  assert.equal(first.length, 4);
  assert.ok(first.every((document) => document.documentClass === "VERSIONED_RESEARCH" && document.version === "retail" && document.patch === "12.1.x"));
});

test("heading sections are deterministic and retain citations", () => {
  const first = parseResearchMarkdown("# Root\n\n[One](https://example.com/a)\n\n## Child\n\nhttps://example.com/b\n");
  const second = parseResearchMarkdown("# Root\n\n[One](https://example.com/a)\n\n## Child\n\nhttps://example.com/b\n");
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((section) => section.sectionId), ["root", "child"]);
  assert.equal(first[1].parentSectionId, "root");
  assert.equal(first[1].citations[0]?.url, "https://example.com/b");
});

test("research search finds the Renown corpus, returns compact citations, and honors filters", () => {
  const matches = registry.search({ query: "Ritual Sites", documentClass: "VERSIONED_RESEARCH", version: "retail", patch: "12.1.x" });
  assert.ok(matches.length > 0);
  assert.equal(matches[0].document.documentId, "midnight-12-1-renown");
  assert.ok(matches[0].snippet.length <= 243);
  assert.ok(matches.some((match) => match.citations.some((citation) => citation.url.startsWith("http"))));
  assert.deepEqual(registry.search({ query: "Ritual Sites", documentClass: "OPERATIONAL_TRUTH" }), []);
  assert.deepEqual(registry.search({ query: "Ritual Sites", patch: "12.0" }), []);
});

test("section retrieval returns the document context and only the selected section body", () => {
  const match = registry.search({ query: "How to Earn Renown", documentId: "midnight-12-1-renown" })[0];
  assert.ok(match);
  const found = registry.getSection(match.document.documentId, match.section.sectionId);
  assert.ok(found);
  assert.equal(found?.document.documentId, "midnight-12-1-renown");
  assert.equal(found?.section.sectionId, match.section.sectionId);
  assert.ok(found?.section.markdown.length && found.section.markdown.length < found.document.markdown.length);
});
