import { createConsolidationPostingPreparation } from "./consolidation-load-posting.js";
// @ts-check
import { query, withTransaction, afterTransactionCommit } from "./db.js";
import { getConsolidatedLoad, revalidateConsolidationLoad, completeConsolidatedLoad } from "./consolidation-load-repository.js";
import { lockConsolidatedLoadOrders, withConsolidatedLoadContext } from "./consolidation-load-locks.js";
import { consolidationError } from "./consolidation-load-domain.js";
import { resolveOperatorNetSuitePostingTargets } from "./operator-netsuite-posting-targets.js";
import { getOperatorNetSuitePostingPolicy } from "./operator-netsuite-posting-policy-repository.js";
import { buildOperatorNetSuitePostingDraft } from "./operator-netsuite-posting-domain.js";
import { assertNoActiveOperatorNetSuitePostingClaims, createOrReplayOperatorNetSuitePostingCommand, getOperatorNetSuitePostingCommand } from "./operator-netsuite-posting-repository.js";
import { resumePublicOperatorNetSuitePostingCommand } from "./operator-netsuite-posting-controller.js";
import { operatorNetSuitePostingRuntime } from "./operator-netsuite-posting-runtime.js";
import { validateConsolidatedDeliveryOrder } from "./delivery-repository.js";
import crypto from "node:crypto";
import { parsePostingPhoto, postingPhotoIdentity, validatePostingPhotos } from "./operator-netsuite-posting-photos.js";
import { operatorPostingTelemetry } from "./operator-netsuite-posting-telemetry.js";

/** @param {unknown} values @param {string} batchId */
export function validatedConsolidationPhotos(values, batchId) {
  if (!Array.isArray(values) || values.length < 2 || new Set(values).size !== values.length
      || values.some((ref) => typeof ref !== "string" || (!ref.startsWith("data:image/")
        && (!/^r2:\/\/operator\/operator-consolidation-load-photo\/\d{4}\/\d{2}\/\d{2}\//.test(ref)
        || ref.split("/")[7] !== batchId || ref.includes(".."))))) {
    throw consolidationError("Take at least two photos for this Consolidation Load.", "CONSOLIDATION_LOAD_PHOTOS_INVALID", 400);
  }
  for (const ref of values) {if (ref.startsWith("data:")) {parsePostingPhoto(ref);}}
  validatePostingPhotos(values);
  return values;
}
const prepareNativePosting = createConsolidationPostingPreparation({
  assertClaims: assertNoActiveOperatorNetSuitePostingClaims,
  resolveTargets: resolveOperatorNetSuitePostingTargets,
  getPolicy: getOperatorNetSuitePostingPolicy,
  preflight: (id) => completeConsolidatedLoad(id, { preflight: true, allowNetSuiteCompleted: true }),
  buildDraft: buildOperatorNetSuitePostingDraft,
  createCommand: createOrReplayOperatorNetSuitePostingCommand
});
/** @param {any} operator @param {string} id */
async function finishLocal(operator, id) {
  try { await completeConsolidatedLoad(id); }
  catch (error) { await query("UPDATE operator_consolidated_loads SET last_error=$2,updated_at=now() WHERE id=$1 AND status='pending'", [id, error instanceof Error ? error.message : String(error)]); }
  return getConsolidatedLoad(operator, id);
}
/** @param {any} operator @param {string} id @param {unknown} photoRefs */
export async function submitConsolidatedLoad(operator, id, photoRefs) {
  return operatorPostingTelemetry.context({ commandId: id, transactionType: "IF", functionKey: "delivery_prep", stage: "admission" },
    () => operatorPostingTelemetry.time({ operation: "posting.admission" }, () => submit(operator, id, photoRefs)));
}
/** @param {any} operator @param {string} id @param {unknown} photoRefs */
async function submit(operator, id, photoRefs) {
  const admitted = await withConsolidatedLoadContext(id, () => withTransaction(async () => {
    const batch = await getConsolidatedLoad(operator, id, { lock: true });
    const photos = validatedConsolidationPhotos(photoRefs, batch.id);
    const photoInputHash = crypto.createHash("sha256").update(JSON.stringify(photos.map(postingPhotoIdentity))).digest("hex");
    if (batch.status !== "draft") {
      if (batch.photoInputHash ? photoInputHash !== batch.photoInputHash : JSON.stringify(photos) !== JSON.stringify(batch.photoRefs)) throw consolidationError("The accepted batch already has its loading photos.");
      return batch;
    }
    await lockConsolidatedLoadOrders(batch.snapshot.orders.map((order) => order.netsuite_id));
    const orders = await revalidateConsolidationLoad(operator, batch);
    for (const order of orders) {
      const validation = validateConsolidatedDeliveryOrder(order);
      if (!validation.ok) throw consolidationError(`${order.tranid}: correct packed quantities before loading.`, "CONSOLIDATION_LOAD_STALE");
    }
    batch.photoRefs = photos;
    await query("UPDATE operator_consolidated_loads SET photo_refs=$2,photo_input_hash=$3,status='pending',submitted_at=now(),updated_at=now() WHERE id=$1", [id, JSON.stringify(photos), photoInputHash]);
    for (const order of batch.snapshot.orders) await query("INSERT INTO operator_consolidated_load_claims(batch_id,order_id) VALUES($1,$2)", [id, order.netsuite_id]);
    const command = await prepareNativePosting(operator, batch, orders);
    if (command) {
      await query("UPDATE operator_consolidated_loads SET command_id=$2 WHERE id=$1", [id, command.id]);
      afterTransactionCommit(() => { void operatorNetSuitePostingRuntime.enqueue(command.id); });
    }
    return getConsolidatedLoad(operator, id);
  }));
  return admitted.status === "completed" || admitted.commandId ? admitted : finishLocal(operator, id);
}
/** @param {any} operator @param {string} id */
export async function resumeConsolidatedLoad(operator, id) {
  const batch = await getConsolidatedLoad(operator, id);
  if (batch.status === "completed") return batch;
  if (batch.status !== "pending") throw consolidationError("Submit the preview before resuming.");
  if (!batch.commandId) return finishLocal(operator, id);
  const command = await getOperatorNetSuitePostingCommand(batch.commandId);
  if (command?.status === "attention") await resumePublicOperatorNetSuitePostingCommand(batch.commandId);
  else void operatorNetSuitePostingRuntime.enqueue(batch.commandId);
  return getConsolidatedLoad(operator, id);
}
