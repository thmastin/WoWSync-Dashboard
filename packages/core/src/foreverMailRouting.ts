export interface MailRoutingRecipient {
  identityKey: string;
  name: string;
  realm: string;
  faction?: string | null;
  professionsState: "OBSERVED" | "LAST_SEEN" | "UNKNOWN" | "DERIVED";
  /** Recipe/reagent uses from current captured rows only. */
  observedReagentIds: number[];
  /** Captured recipe/reagent uses, retaining their own profession and freshness. */
  reagentProfessions?: Array<{ itemId: number; profession: string; evidence: "OBSERVED" | "LAST_SEEN" }>;
  /** True only when this character's profession recipe coverage is complete and current. */
  recipeKnowledgeComplete?: boolean;
  /** Distinguishes an OBSERVED empty profession list from unobserved profession skills. */
  hasObservedProfessions?: boolean;
  observedBagSlots?: number;
}

export interface MailRoutingItem {
  itemId?: number;
  itemRef?: string;
  name?: string;
  quantity?: number;
}

export type MailDisposition =
  | { disposition: "MAIL_TO_CRAFTER" | "POUCH_TO_ALT"; item: MailRoutingItem; recipient: Pick<MailRoutingRecipient, "identityKey" | "name" | "realm">; reason: string; unknownProfessionRecipients?: string[] }
  | { disposition: "SELL_AH" | "VENDOR"; item: MailRoutingItem; ahNetCopper: number; vendorCopper: number; reason: string }
  | { disposition: "KEEP"; item: MailRoutingItem; reason: string; unknownProfessionRecipients?: string[] };

export function orderMailPlanSteps(groups: { gear: unknown[]; materials: unknown[]; pouches?: unknown[]; sale: unknown[]; keep: unknown[] }): Array<{ kind: string; action: unknown }> {
  return [
    ...groups.gear.map((action) => ({ kind: "GEAR_MAIL", action })),
    ...groups.materials.map((action) => ({ kind: "MATERIAL_MAIL", action })),
    ...(groups.pouches ?? []).map((action) => ({ kind: "POUCH_MAIL", action })),
    ...groups.sale.map((action) => ({ kind: "SALE", action })),
    ...groups.keep.map((action) => ({ kind: "KEEP", action })),
  ];
}

export function eligibleMailRecipients<T extends Pick<MailRoutingRecipient, "identityKey" | "realm" | "faction">>(source: Pick<MailRoutingRecipient, "identityKey" | "realm" | "faction">, recipients: T[]): T[] {
  return recipients.filter((row) => row.identityKey !== source.identityKey && row.realm === source.realm && !!source.faction && row.faction === source.faction);
}

export function routePouch(item: MailRoutingItem, recipients: MailRoutingRecipient[]): MailDisposition {
  const withObservedSlots = recipients.filter((row) => Number.isSafeInteger(row.observedBagSlots) && row.observedBagSlots! >= 0);
  if (!withObservedSlots.length) return { disposition: "KEEP", item, reason: "Pouch routing UNKNOWN: no eligible alt has OBSERVED bag slots." };
  const recipient = [...withObservedSlots].sort((a, b) => a.observedBagSlots! - b.observedBagSlots! || a.identityKey.localeCompare(b.identityKey))[0]!;
  return { disposition: "POUCH_TO_ALT", item, recipient, reason: "Sent to the eligible alt with the fewest OBSERVED bag slots (" + recipient.observedBagSlots + ")." };
}

export function routeMaterial(item: MailRoutingItem, recipients: MailRoutingRecipient[], options: {
  holderIdentityKey?: string;
  heldItemIds?: ReadonlySet<number>;
  ahMedianUnitCopper?: number;
  vendorUnitCopper?: number;
  /** 24-hour Classic AH deposit: 10% of vendor value per item. */
  depositRate?: number;
} = {}): MailDisposition[] {
  if (item.itemId !== undefined && options.heldItemIds?.has(item.itemId)) return [{ disposition: "KEEP", item, reason: "on hold list" }];
  if (item.itemId === undefined) return [{ disposition: "KEEP", item, reason: "Item identity UNKNOWN; crafting use and price are UNKNOWN." }];
  const ownUses = recipients.filter((row) => row.identityKey === options.holderIdentityKey)
    .flatMap((row) => (row.reagentProfessions ?? []).filter((use) => use.itemId === item.itemId));
  if (ownUses.length) {
    const profession = ownUses[0]!.profession;
    return [{ disposition: "KEEP", item, reason: `used by your own ${profession}${ownUses[0]!.evidence === "LAST_SEEN" ? " (LAST_SEEN recipe evidence)" : ""}.` }];
  }
  const crafters = recipients.filter((row) => row.identityKey !== options.holderIdentityKey && row.professionsState === "OBSERVED" && row.observedReagentIds.includes(item.itemId!));
  const incomplete = recipients.filter((row) => row.professionsState === "OBSERVED" && row.hasObservedProfessions !== false && row.recipeKnowledgeComplete === false);
  const nonObserved = recipients.filter((row) => row.professionsState !== "OBSERVED");
  const unknown = nonObserved.filter((row) => row.professionsState === "UNKNOWN").map((row) => row.name + " (" + row.realm + ")");
  if (crafters.length) return crafters.map((recipient) => ({
    disposition: "MAIL_TO_CRAFTER" as const, item,
    recipient,
    reason: "Captured OBSERVED recipe/reagent data for an OBSERVED profession uses this material."
      + (nonObserved.length ? " Non-OBSERVED profession recipients were excluded as crafting targets: " + nonObserved.map((row) => row.name + " (" + row.realm + "; " + row.professionsState + ")").join(", ") + "." : ""),
    ...(unknown.length ? { unknownProfessionRecipients: unknown } : {}),
  }));
  if (incomplete.length) return [{ disposition: "KEEP", item, reason: "Profession recipe data is incomplete; this material may be used by an OBSERVED profession: " + incomplete.map((row) => row.name + " (" + row.realm + ")").join(", ") + "." }];
  if (unknown.length) return [{ disposition: "KEEP", item, reason: "Recipient profession is UNKNOWN; do not sell or use as a crafting target.", unknownProfessionRecipients: unknown }];
  if (nonObserved.length) return [{ disposition: "KEEP", item, reason: "Recipient profession evidence is not OBSERVED; do not sell or use as a crafting target. " + nonObserved.map((row) => row.name + " (" + row.realm + "; " + row.professionsState + ")").join(", ") }];
  if (item.quantity === undefined || !Number.isSafeInteger(item.quantity) || item.quantity < 1
    || options.ahMedianUnitCopper === undefined || options.vendorUnitCopper === undefined) {
    return [{ disposition: "KEEP", item, reason: "sell: price UNKNOWN (AH median, vendor value, or quantity is UNKNOWN)." }];
  }
  const vendorCopper = options.vendorUnitCopper * item.quantity;
  const deposit = vendorCopper * (options.depositRate ?? 0.1);
  const ahNetCopper = options.ahMedianUnitCopper * item.quantity * 0.95 - deposit;
  const compare = "AH net " + ahNetCopper + " copper (median " + (options.ahMedianUnitCopper * item.quantity) + " - 5% cut - 24h AH deposit at 10% of vendor value " + deposit + "); vendor " + vendorCopper + " copper.";
  return ahNetCopper > vendorCopper
    ? [{ disposition: "SELL_AH", item, ahNetCopper, vendorCopper, reason: compare }]
    : [{ disposition: "VENDOR", item, ahNetCopper, vendorCopper, reason: compare }];
}
