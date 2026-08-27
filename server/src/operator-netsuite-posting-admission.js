// @ts-check

import { buildOperatorNetSuitePostingDraft } from "./operator-netsuite-posting-domain.js";
import { assertExpectedOperatorNetSuitePostingPolicy } from "./operator-netsuite-posting-policy.js";

/**
 * @param {object} dependencies
 * @param {Function} dependencies.resolveTargets
 * @param {Function} dependencies.getPolicy
 * @param {Function} dependencies.createCommand
 * @param {Function} dependencies.onAccepted
 * @param {Function} [dependencies.preflight]
 * @param {Function} [dependencies.assertLocalCompletionAllowed]
 */
export function createOperatorNetSuitePostingAdmission({
  resolveTargets,
  getPolicy,
  createCommand,
  onAccepted,
  preflight = async () => {},
  assertLocalCompletionAllowed = async () => {}
}) {
  return async function admitOperatorNetSuitePosting(/** @type {Record<string, any>} */ input = {}) {
    const resolution = await resolveTargets({
      functionKey: input.functionKey,
      orderId: input.orderId,
      orderType: input.orderType,
      clientLocationId: input.clientLocationId,
      deferTargets: true
    });
    if (resolution.netSuitePostingOwner === "driver_completion") {
      await assertLocalCompletionAllowed(resolution);
      return {
        mode: "local_only",
        reason: "driver_completion_owned",
        policy: null,
        resolution
      };
    }
    if (resolution.localOnly) {
      await assertLocalCompletionAllowed(resolution);
      return {
        mode: "local_only",
        reason: "local_order_type",
        policy: null,
        resolution
      };
    }
    const policy = await getPolicy({
      functionKey: resolution.functionKey,
      locationId: resolution.canonicalLocationId,
      lock: true
    });
    if (!policy.effective) {
      await assertLocalCompletionAllowed(resolution);
      return {
        mode: "local_only",
        reason: policy.configured ? "deployment_ceiling_closed" : "gate_off",
        policy,
        resolution
      };
    }
    assertExpectedOperatorNetSuitePostingPolicy({
      expected: input.expectedPolicy,
      actual: policy
    });
    const actionableResolution = typeof resolution.materializeTargets === "function"
      ? await resolution.materializeTargets()
      : resolution;
    if (actionableResolution.localOnly) {
      await assertLocalCompletionAllowed(actionableResolution);
      return {
        mode: "local_only",
        reason: "local_order_type",
        policy: null,
        resolution: actionableResolution
      };
    }
    await preflight(input, actionableResolution);
    const draft = buildOperatorNetSuitePostingDraft({
      requestId: input.requestId,
      actorOperatorId: input.actorOperatorId,
      functionKey: actionableResolution.functionKey,
      transactionType: actionableResolution.transactionType,
      policy,
      photoRefs: input.photoRefs,
      localOrderKeys: actionableResolution.localOrderKeys,
      localOperation: actionableResolution.localOperation,
      targets: actionableResolution.targets
    });
    const created = await createCommand(draft);
    await onAccepted(created.command);
    return {
      mode: "netsuite",
      policy,
      replayed: created.replayed,
      command: created.command
    };
  };
}
