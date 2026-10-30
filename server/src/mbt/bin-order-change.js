// @ts-check
import { query } from '../db.js';
import { binWorkflowError } from './bin-order-workflow-repository.js';
import { assertBinDeliveryUnplanned } from './bin-order-window-service.js';

const binLine = (/** @type {any} */ l) => ['bin_rental','bin_transport','bin_discount','fixed_dump'].includes(l.lineType);
const fields = ['configuredAmountMinor','preTaxAmountMinor','includedHstMinor','addedHstMinor','customerAmountMinor'];

/** Signed, exact-cent difference between immutable accepted and revised prices.
 * @param {any} previous @param {any} revised @param {number} currentTotal
 */
export function calculateBinOrderChange(previous, revised, currentTotal) {
  if (previous.paymentCategory !== revised.paymentCategory) { throw binWorkflowError(400, 'Keep the original payment method when changing a priced bin.'); }
  const oldLines = previous.lines.filter(binLine), newLines = revised.lines.filter(binLine);
  if (!oldLines.length || !newLines.length) { throw binWorkflowError(422, 'The original bin price is incomplete. Review its accepted pricing first.'); }
  const lines = [
    ...oldLines.map((/** @type {any} */ l, /** @type {number} */ i) => ({...l,
      lineCode:`bin_change_credit_${i}`,label:`Credit previous ${l.label}`,paymentTiming:'due_now',
      ...Object.fromEntries(fields.map(k => [k, -Number(l[k] || 0)]))})),
    ...newLines.map((/** @type {any} */ l, /** @type {number} */ i) => ({...l,
      lineCode:`bin_change_revised_${i}`,label:`Revised ${l.label}`,paymentTiming:'due_now'}))
  ];
  const sum = (/** @type {string} */ k) => {
    const n = lines.reduce((/** @type {number} */ total, /** @type {any} */ l) => total + Number(l[k] || 0), 0);
    if (!Number.isSafeInteger(n)) { throw binWorkflowError(422, 'The price change exceeds supported exact cents.'); }
    return n;
  };
  const amount = sum('customerAmountMinor');
  const resulting = currentTotal + amount;
  if (!Number.isSafeInteger(resulting) || resulting < 0) { throw binWorkflowError(422, 'The price credit exceeds the current contract total.'); }
  const depositDelta = revised.requiredDepositMinor - previous.requiredDepositMinor;
  const dueNow = amount + depositDelta;
  if (!Number.isSafeInteger(dueNow)) { throw binWorkflowError(422, 'The deposit change exceeds supported exact cents.'); }
  return {...revised,kind:'change_bin',currentContractTotalMinor:currentTotal,
    preTaxRevenueMinor:sum('preTaxAmountMinor'),includedHstMinor:sum('includedHstMinor'),addedHstMinor:sum('addedHstMinor'),
    newRequestChargeableMinor:amount,resultingContractTotalMinor:resulting,
    requiredDepositMinor:Math.max(0,depositDelta),depositCreditMinor:Math.max(0,-depositDelta),dueNowMinor:dueNow,
    previousBinTotalMinor:oldLines.reduce((/** @type {number} */ n,/** @type {any} */ l)=>n+l.customerAmountMinor,0),
    revisedBinTotalMinor:newLines.reduce((/** @type {number} */ n,/** @type {any} */ l)=>n+l.customerAmountMinor,0),
    revisedCalculation:revised,lines,
    netsuiteReadySnapshot:revised.netsuiteReadySnapshot ? {...revised.netsuiteReadySnapshot,
      operation:'bin_order_price_adjustment',lines:lines.map((/** @type {any} */ l)=>({itemCode:l.itemCode,
        amountMinor:l.preTaxAmountMinor,quantityMilliUnits:l.quantityMilliUnits,unitOfMeasure:l.unitOfMeasure}))} : null};
}

/** @param {string} contractId @param {string} lineId @param {number} revision */
export async function binOrderChangeSubject(contractId, lineId, revision) {
  const line = (await query(`SELECT * FROM mbt_contract_service_lines WHERE contract_id=$1 AND service_line_id=$2 FOR UPDATE`, [contractId,lineId])).rows[0];
  if (!line || Number(line.revision)!==revision) { throw binWorkflowError(409, 'The bin order changed. Recalculate its price.', 'MBT_STALE_REVISION'); }
  const delivery = (await query(`SELECT service_visit_id FROM mbt_service_visits WHERE service_line_id=$1
    AND service_action='delivery' AND status<>'cancelled' ORDER BY visit_number LIMIT 1`, [lineId])).rows[0];
  if (!delivery) { throw binWorkflowError(422, 'The bin order has no initial delivery.'); }
  const context = await assertBinDeliveryUnplanned(delivery.service_visit_id);
  const chargeId = line.pricing_snapshot?.chargeRequestId || line.source_charge_request_id;
  const charge = (await query(`SELECT * FROM mbt_frontdesk_charge_requests WHERE charge_request_id::text=$1
    AND status='confirmed' AND (contract_id=$2 OR source_quote_id=$3)`, [chargeId || '',contractId,line.source_quote_id])).rows[0];
  if (!charge) { throw binWorkflowError(422, 'This order needs its accepted fixed-price evidence before it can be repriced.'); }
  const calculation = charge.pricing_snapshot.calculation;
  return {line,context,previous:calculation.revisedCalculation || calculation,charge};
}

/** @param {any} row @param {string} actorId */
export async function materializeBinOrderChange(row, actorId) {
  const subject = await binOrderChangeSubject(row.contract_id,row.service_line_id,Number(row.expected_service_line_revision));
  const {line,context} = subject, pricing = row.pricing_snapshot, bin = pricing.bin;
  const binTypeId = bin.itemEvidence.incomingBinTypeId;
  const sizeChanged = String(line.bin_type_id)!==String(binTypeId);
  if (sizeChanged && context.parts.length) {
    const ids = context.parts.map((/** @type {any} */ p)=>p.visit_id);
    const linked = await query(`SELECT 1 FROM mbt_bin_workflow_dependencies WHERE dependent_visit_id=ANY($1::uuid[])
      OR prerequisite_visit_id=ANY($1::uuid[]) UNION ALL SELECT 1 FROM mbt_bin_order_parts WHERE linked_delivery_visit_id=ANY($1::uuid[])
      UNION ALL SELECT 1 FROM mbt_bin_workflow_claims WHERE visit_id=ANY($1::uuid[])`, [ids]);
    if (linked.rowCount) { throw binWorkflowError(409, 'This delivery is linked to another bin route. Resolve that link in Dispatch before changing its size.'); }
    await query(`UPDATE mbt_service_visits SET status='cancelled',cancelled_at=now(),cancellation_reason='Customer changed bin size before planning',revision=revision+1,
      updated_by=$2,updated_at=now() WHERE service_visit_id=ANY($1::uuid[])`, [ids,actorId]);
    await query('DELETE FROM mbt_bin_order_parts WHERE order_id=$1', [context.root.service_visit_id]);
    await query('UPDATE mbt_bin_orders SET configuration=NULL,configured_at=NULL,revision=revision+1 WHERE order_id=$1', [context.root.service_visit_id]);
  }
  const revised = pricing.calculation.revisedCalculation;
  const retainedLines = (line.pricing_snapshot.lines || []).filter((/** @type {any} */ item) => !binLine(item));
  const combinedLines = [...revised.lines,...retainedLines];
  const combinedTotal = (/** @type {string} */ field) => combinedLines.reduce((/** @type {number} */ total,/** @type {any} */ item)=>total+Number(item[field]||0),0);
  const snapshot = {...line.pricing_snapshot,chargeRequestId:row.charge_request_id,
    binTypeId,binItemCode:bin.itemEvidence.binItemCode,contentCode:bin.calculator.incomingContentCode,
    dumpItemCode:bin.itemEvidence.fixedDumpItemCode || null,materialId:null,
    subtotalMinor:combinedTotal('preTaxAmountMinor'),totalMinor:combinedTotal('customerAmountMinor'),
    taxMinor:combinedTotal('addedHstMinor'),depositRequiredMinor:revised.requiredDepositMinor,
    lines:combinedLines,...(line.pricing_snapshot.attachedAggregate ? {attachedAggregate:line.pricing_snapshot.attachedAggregate} : {})};
  await query(`UPDATE mbt_contract_service_lines SET bin_type_id=$2,bin_item_code=$3,material_id=NULL,dump_item_code=NULL,estimated_weight_kg=NULL,
    pricing_snapshot=$4::jsonb,revision=revision+1,updated_by=$5,updated_at=now() WHERE service_line_id=$1`,
  [line.service_line_id,binTypeId,bin.itemEvidence.binItemCode,JSON.stringify(snapshot),actorId]);
  const service = {...context.root.service_snapshot,binTypeId,binItemCode:bin.itemEvidence.binItemCode,
    contentCode:bin.calculator.incomingContentCode,chargeRequestId:row.charge_request_id,materialId:null,
    dumpItemCode:bin.itemEvidence.fixedDumpItemCode || null};
  if (sizeChanged) {
    service.mandatoryStops = (service.mandatoryStops || []).map((/** @type {any} */ stop)=>({...stop,assetId:null}));
    await query('UPDATE mbt_visit_steps SET expected_asset_id=NULL WHERE service_visit_id=$1',[context.root.service_visit_id]);
  }
  await query(`UPDATE mbt_service_visits SET bin_type_id=$2,material_id=NULL,service_snapshot=$3::jsonb,
    expected_asset_id=CASE WHEN $5 THEN NULL ELSE expected_asset_id END,
    outgoing_asset_id=CASE WHEN $5 THEN NULL ELSE outgoing_asset_id END,
    revision=revision+1,updated_by=$4,updated_at=now() WHERE service_visit_id=$1`,
  [context.root.service_visit_id,binTypeId,JSON.stringify(service),actorId,sizeChanged]);
  await query('UPDATE mbt_bin_orders SET revision=revision+1 WHERE order_id=$1', [context.root.service_visit_id]);
  await query('UPDATE mbt_contracts SET revision=revision+1,updated_by=$2,updated_at=now() WHERE contract_id=$1', [row.contract_id,actorId]);
  return {contractId:row.contract_id,serviceLineId:line.service_line_id,deliveryVisitId:context.root.service_visit_id,
    binTypeId,contentCode:bin.calculator.incomingContentCode,priceChangeMinor:pricing.calculation.newRequestChargeableMinor,
    binSelectionRequired:sizeChanged};
}
