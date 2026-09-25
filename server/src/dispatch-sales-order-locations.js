// "195" is the location's display code, not its NetSuite internal ID.
export const VOYAGE_DISPATCH_YARD = Object.freeze({
  code: "195",
  name: "195",
  locationId: 4,
  address: "195 Milner Ave Unit 5, Scarborough, ON M1S 4P4"
});
export const SALES_ORDER_SYNC_LOCATIONS = Object.freeze([1, 28, 15, 26, 4, 50]);

export function withVoyageDispatchYard(yards = []) {
  const existing = Array.isArray(yards) ? yards : [];
  if (existing.some(yard => String(yard?.code || "").trim() === VOYAGE_DISPATCH_YARD.code)) {
    return existing;
  }
  return [...existing, { ...VOYAGE_DISPATCH_YARD }];
}
