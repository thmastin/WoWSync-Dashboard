/** Maximum replacement quantity that preserves every other existing reservation. */
export function maxAdjustedReservationQuantity(currentQuantity: number, remainingObservedLowerBound?: number): number {
  if (!Number.isSafeInteger(currentQuantity) || currentQuantity < 1) return 0;
  if (!Number.isSafeInteger(remainingObservedLowerBound) || remainingObservedLowerBound! < 0) return currentQuantity;
  const maximum = currentQuantity + remainingObservedLowerBound!;
  return Number.isSafeInteger(maximum) ? maximum : currentQuantity;
}

export function isValidAdjustedReservationQuantity(nextQuantity: number, currentQuantity: number, maximumQuantity: number): boolean {
  return Number.isSafeInteger(nextQuantity) && nextQuantity >= 1 && nextQuantity <= maximumQuantity && Number.isSafeInteger(currentQuantity) && currentQuantity >= 1;
}
