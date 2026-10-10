/** Browser-safe work-order vocabulary shared by planning UI and domain validation. */
export const ERP_WORK_ORDER_TYPES = ["INVESTIGATE", "GATHER", "CRAFT", "TRANSFER", "RETRIEVE", "EQUIP", "PURCHASE", "SELL_MANUALLY", "PROVISION", "OTHER"] as const;
export type ErpWorkOrderType = typeof ERP_WORK_ORDER_TYPES[number];
