import "../public/dispatch-address-guard.js";

export const preserveDispatchOrderAddress = globalThis.DispatchAddressGuard.preserve;

export function assertDispatchAddressPatch(orderRef, patch) {
  const issue = globalThis.DispatchAddressGuard.validate(orderRef, patch);
  if (issue) {throw Object.assign(new Error(issue.message), { status: 400, code: issue.code, conflicts: [issue] });}
}

export function preserveDispatchPlanAddresses(previousPlan = {}, nextPlan = {}) {
  const previous = new Map((previousPlan.orders || []).map(order => [String(order.id).toUpperCase(), order]));
  const warnings = [];
  const orders = (nextPlan.orders || []).map(order => {
    const result = preserveDispatchOrderAddress(previous.get(String(order.id).toUpperCase()) || {}, order);
    warnings.push(...result.warnings);
    return result.order;
  });
  return { ...nextPlan, orders, summary: { ...nextPlan.summary,
    ...(warnings.length ? { addressWarnings: warnings } : {}) } };
}
