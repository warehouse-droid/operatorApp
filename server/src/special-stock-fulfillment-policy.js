/** @param {unknown} fromMethod @param {unknown} toMethod @param {unknown} savedPlan */
export function isLocalPickupChange(fromMethod, toMethod, savedPlan = null) {
  /** @param {unknown} value */
  const pickup = value => value === 'vendor_pickup' || value === 'yard_pickup';
  // Both locations map to NetSuite Pick-up. An existing remote plan must finish its recovery.
  return !savedPlan && pickup(fromMethod) && pickup(toMethod);
}
