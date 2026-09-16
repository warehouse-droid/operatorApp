// @ts-check
/** @param {{assertClaims: Function, resolveTargets: Function, getPolicy: Function, preflight: Function, buildDraft: Function, createCommand: Function}} dependencies */
export function createConsolidationPostingPreparation({ assertClaims, resolveTargets, getPolicy, preflight, buildDraft, createCommand }) {
  /** @param {any} operator @param {any} batch @param {any[]} orders */
  return async function prepare(operator, batch, orders) {
    const localOrderKeys = orders.map((order) => `delivery_prep:${order.order_type}:${order.netsuite_id}`);
    await assertClaims({ functionKey: "delivery_prep", localOrderKeys });
    const resolutions = await Promise.all(orders.map((order) => resolveTargets({ functionKey: "delivery_prep",
      orderId: order.netsuite_id, orderType: order.order_type, clientLocationId: batch.locationId, deferTargets: true })));
    const native = resolutions.filter((resolution) => resolution.netSuitePostingOwner !== "driver_completion" && !resolution.localOnly);
    if (!native.length) return null;
    const policy = await getPolicy({ functionKey: "delivery_prep", locationId: batch.locationId, lock: true });
    if (!policy.effective) return null;
    const targets = [];
    for (const resolution of native) targets.push(...(await resolution.materializeTargets()).targets);
    if (!targets.length) return null;
    await preflight(batch.id);
    const draft = buildDraft({ requestId: batch.id, actorOperatorId: operator.id, functionKey: "delivery_prep", transactionType: "IF",
      policy, photoRefs: batch.photoRefs, localOrderKeys,
      localOperation: { kind: "delivery_consolidation_load", orderId: batch.id, orderType: "consolidation_load" }, targets });
    return (await createCommand(draft)).command;
  };
}
