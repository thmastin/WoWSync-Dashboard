/** Classic Era / Forever fallback IDs. Prefer version-scoped item metadata whenever
 * available; these IDs are the compatibility list until GearExport captures class,
 * subclass, and required level on bag rows. Required level is unknown without metadata.
 */
export const CLASSIC_CONSUMABLE_FALLBACK_IDS = new Set([
  // Food and cooked meals
  117, 4540, 4604, 4605, 4606, 4607, 4608, 2679, 2680, 2681, 2682, 2683, 2684,
  2685, 2687, 2688, 2689, 2690, 2723, 2888, 2889, 3220, 3221, 3662, 3663, 3664,
  3665, 3666, 3667, 3726, 3727, 3728, 3729, 4536, 4537, 4538, 4539, 8952, 8953,
  8957, 17119,
  // Water and drinks
  159, 1179, 1180, 2288, 2136, 29395,
  // Potions and bandages
  118, 2455, 2456, 2457, 2458, 3385, 3386, 3387, 3388, 3389, 3390, 3391, 5631,
  5633, 5634, 6372, 6373, 6450, 6451, 6452, 6453, 6454, 6455, 6456, 6457, 6458,
  6459, 8544, 8545,
]);

/** Conjured healthstones and mage food/water ranks. */
export const CLASSIC_CONJURED_FALLBACK_IDS = new Set([
  5512, 5511, 5509, 5510, 9421, 19004,
  5350, 5351, 5352, 8075, 8076, 8077, 8078, 8079,
]);
