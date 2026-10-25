import type { VersionOrUnknown, WowVersion } from "./types.ts";

export interface RecipeLearningRequirement {
  state: "KNOWN";
  version: "classic-era" | "forever";
  recipeItemId: number;
  recipeName: string;
  profession: string;
  requiredSkill: number;
  reagents: Array<{ itemId: number; name: string }>;
  provenance: { state: "EXTERNAL_STATIC"; sources: Array<{ label: string; url: string; clientVersion: string }> };
}

const BEER_BASTED_BOAR_RIBS_REAGENTS = [
  { itemId: 2886, name: "Crag Boar Rib" },
  { itemId: 2894, name: "Rhapsody Malt" },
];

const REQUIREMENTS: RecipeLearningRequirement[] = [
  {
    state: "KNOWN", version: "classic-era", recipeItemId: 2889, recipeName: "Beer Basted Boar Ribs", profession: "Cooking", requiredSkill: 25,
    reagents: BEER_BASTED_BOAR_RIBS_REAGENTS,
    provenance: { state: "EXTERNAL_STATIC", sources: [
      { label: "Wowhead Classic recipe item tooltip", url: "https://www.wowhead.com/classic/item=2889/recipe-beer-basted-boar-ribs", clientVersion: "Classic Era" },
      { label: "Wowhead Classic item records: Crag Boar Rib and Rhapsody Malt", url: "https://www.wowhead.com/classic/item=2886/crag-boar-rib", clientVersion: "Classic Era" },
      { label: "Wowhead Classic Rhapsody Malt record", url: "https://www.wowhead.com/classic/item=2894/rhapsody-malt", clientVersion: "Classic Era" },
    ] },
  },
  {
    state: "KNOWN", version: "forever", recipeItemId: 2889, recipeName: "Beer Basted Boar Ribs", profession: "Cooking", requiredSkill: 25,
    reagents: BEER_BASTED_BOAR_RIBS_REAGENTS,
    provenance: { state: "EXTERNAL_STATIC", sources: [
      { label: "The Forever Era database, client build 1.60.1.70532", url: "https://theforeverera.com/en/items/2888/", clientVersion: "Forever 1.60.1.70532" },
      { label: "Wowhead Classic recipe item identity", url: "https://www.wowhead.com/classic/item=2889/recipe-beer-basted-boar-ribs", clientVersion: "Classic Era reference item ID" },
    ] },
  },
];

export function recipeLearningRequirement(version: VersionOrUnknown, itemId?: number, recipeName?: string): RecipeLearningRequirement | undefined {
  if (version !== "classic-era" && version !== "forever") return undefined;
  return REQUIREMENTS.find((row) => row.version === version && (itemId !== undefined ? row.recipeItemId === itemId : recipeName !== undefined && row.recipeName.toLocaleLowerCase() === recipeName.replace(/^Recipe:\s*/i, "").trim().toLocaleLowerCase()));
}

export function unknownRecipeLearningRequirement(version: VersionOrUnknown) {
  return { state: "UNKNOWN" as const, version: version as WowVersion, reason: "No supported version-scoped recipe item tooltip or static learn-skill evidence is available." };
}
