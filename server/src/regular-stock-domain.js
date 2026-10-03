// @ts-check
/**
 * @typedef {{id:number,itemId:number,sourceLocationId:number,salesQty:number,salesUom?:string,itemName?:string,decision?:string,status?:string,destinationLocationId?:number}} RegularLine
 * @typedef {{itemId:number,sourceLocationId:number,availableQuantity:number|null,safetyQuantity:number|null}} StockPolicy
 * @typedef {{remoteLineId:number,restLineId:number,itemId:number,itemType:string,quantity:number,backorderedQuantity:number|null,uom:string|null,locationId:number,remoteLocationId:number,fulfilledQuantity:number,billedQuantity:number,closed:boolean}} KitComponent
 * @typedef {{remoteLineId:number,itemId:number,quantity:number,uom?:string,locationId:number,open:boolean,ancillary?:boolean,itemType?:string,kitComponents?:KitComponent[]}} MaterialLine
 * @typedef {{destinationLocationId:number,lines:RegularLine[],regular?:{customerId?:number}}} RoutingRequest
 * @typedef {{id?:number,ref?:string,locationId:number,customerId?:number,lines:MaterialLine[]}} SalesOrder
 */
import { normalizeRegularLeadHours } from '../public/regular-stock-input.js';
import { groupStockRequestLinesForTransfer } from './stock-request-domain.js';

/** @param {string} message @param {string} [code] @param {number} [status] */
export const regularError = (message, code = 'REGULAR_STOCK_INVALID', status = 409) => Object.assign(new Error(message), { code, status });
/** @param {{itemId:number,sourceLocationId:number}} line */
const key = line => `${Number(line.itemId)}:${Number(line.sourceLocationId)}`;
/** @param {unknown} value */
const valid = value => value !== null && value !== undefined && Number.isFinite(Number(value));
/** @param {unknown} value */
const cleanUom = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/** @param {number} a @param {number} b */
const sameQty = (a, b) => Math.abs(Number(a) - Number(b)) <= 1e-6;

/** @param {{regular?:{deliveryMethod?:string,pickupTransfer?:unknown,handoffStatus?:string}}} request */
export function isRegularStockingRequest(request) {
  return request.regular?.deliveryMethod === 'stocking' || Boolean(request.regular?.pickupTransfer) && !request.regular?.handoffStatus;
}

/** @param {{lines?:RegularLine[],policies?:StockPolicy[],arrivalAt?:string|number|Date|null,deliveryMethod?:string,leadHours?:number,autoApprovalEnabled?:boolean,now?:string|number|Date}} input */
export function evaluateRegularStockApproval({ lines = [], policies = [], arrivalAt, deliveryMethod = 'delivery', leadHours = 5, autoApprovalEnabled = true, now = new Date() }) {
  const hours = normalizeRegularLeadHours(leadHours);
  const leadTimeApplies = deliveryMethod === 'delivery';
  const nowMs = new Date(now).getTime();
  const arrivalMs = leadTimeApplies && arrivalAt != null ? new Date(arrivalAt).getTime() : NaN;
  if (!Number.isFinite(nowMs) || (leadTimeApplies && !Number.isFinite(arrivalMs))) throw regularError('A valid arrival instant is required.', 'REGULAR_ARRIVAL_INVALID', 400);
  const enoughTime = !leadTimeApplies || arrivalMs >= nowMs + hours * 3600000;
  const totals = new Map();
  for (const line of lines) {
    if (!valid(line.salesQty) || Number(line.salesQty) <= 0) throw regularError('Positive quantities are required.');
    totals.set(key(line), (totals.get(key(line)) || 0) + Number(line.salesQty));
  }
  const policiesByKey = new Map(policies.map(policy => [key(policy), policy]));
  const evidence = lines.map(line => {
    const policy = policiesByKey.get(key(line));
    const known = valid(policy?.availableQuantity) && valid(policy?.safetyQuantity) && Number(policy?.safetyQuantity) >= 0;
    const available = known ? Number(policy?.availableQuantity) : null;
    const safety = known ? Number(policy?.safetyQuantity) : null;
    const requested = totals.get(key(line));
    const remaining = known ? Number(available) - Number(requested) : null;
    const safe = known && Number(remaining) + 1e-9 >= Number(safety);
    return { lineId: Number(line.id), itemId: Number(line.itemId), sourceLocationId: Number(line.sourceLocationId),
      requestedQuantity: Number(line.salesQty), groupedRequestedQuantity: requested, availableQuantity: available,
      safetyQuantity: safety, remainingQuantity: remaining, shortfallQuantity: known ? Math.max(0, Number(safety) - Number(remaining)) : null,
      unit: line.salesUom, stockEligible: safe, reasons: [...(deliveryMethod === 'stocking' ? ['stocking_scm_review'] : []), ...(!autoApprovalEnabled ? ['auto_approval_disabled'] : []), ...(!known ? ['policy_unavailable'] : !safe ? ['below_safety'] : []), ...(!enoughTime ? ['short_lead_time'] : [])] };
  });
  return { automatic: deliveryMethod !== 'stocking' && autoApprovalEnabled && evidence.length > 0 && enoughTime && evidence.every(line => line.stockEligible), deliveryMethod, autoApprovalEnabled, leadHours: hours, leadTimeApplies,
    evaluatedAt: new Date(nowMs).toISOString(), arrivalAt: leadTimeApplies ? new Date(arrivalMs).toISOString() : null, enoughTime, lines: evidence };
}

/** @param {{regular?:{deliveryMethod?:string,pickupTransfer?:unknown,approvalExpiresAt?:string|null,handoffStatus?:string}}} request @param {Date|string|number} [now] */
export function regularApprovalExpired(request,now=new Date()) {
  return !isRegularStockingRequest(request) && !request.regular?.handoffStatus && !!request.regular?.approvalExpiresAt
    && new Date(now).getTime()>=new Date(request.regular.approvalExpiresAt).getTime();
}

/** @param {{regular?:{deliveryMethod?:string,pickupTransfer?:unknown,approvalExpiresAt?:string|null,approvalValidityMinutes?:number,handoffStatus?:string}}} request @param {Date|string|number} [now] */
export function requireRegularStockApproval(request,now=new Date()) {
  if(request.regular?.handoffStatus)return;
  if(isRegularStockingRequest(request))throw regularError('Stocking requests require SCM to convert directly to TOs. A Sales Order is not required.','REGULAR_PICKUP_SCM_REQUIRED');
  if(regularApprovalExpired(request,now))throw regularError(`Approval expired after ${request.regular?.approvalValidityMinutes || 15} minutes. Re-raise this request to obtain a new approval.`,'REGULAR_APPROVAL_EXPIRED');
  if(!request.regular?.approvalExpiresAt || !Number.isFinite(new Date(request.regular.approvalExpiresAt).getTime()))throw regularError('Finish all SCM decisions before entering the SO.','REGULAR_APPROVAL_REQUIRED');
}

/** @param {{request:RoutingRequest,salesOrder:SalesOrder,selectedLineIds?:Record<string,number>}} input */
export function planRegularStockRouting({ request, salesOrder, selectedLineIds = {} }) {
  /** @param {string} message @returns {never} */
  const mismatch = message => { throw regularError(message, 'REGULAR_SO_MISMATCH'); };
  if (Number(salesOrder.locationId) !== Number(request.destinationLocationId)) mismatch('The SO must be created at your Sales location.');
  if (request.regular?.customerId && Number(request.regular.customerId) !== Number(salesOrder.customerId)) mismatch('The SO customer does not match this request.');
  const approved = request.lines.filter(line => ['stock', 'po'].includes(line.decision||''));
  if (!approved.length || request.lines.some(line => !line.decision && !['rejected', 'cancelled'].includes(line.status||''))) mismatch('Every line needs a decision before linking an SO.');
  const materials = salesOrder.lines.filter(line => !line.ancillary);
  if (materials.some(line => !line.open)) mismatch('All SO material lines must be open and unfulfilled.');
  /** @type {Map<string,RegularLine[]>} */
  const byItem = new Map();
  for (const line of approved) {
    const itemKey = `${line.itemId}:${cleanUom(line.salesUom)}`;
    if (!byItem.has(itemKey)) byItem.set(itemKey, []);
    byItem.get(itemKey)?.push(line);
  }
  const mappings = [];
  const used = new Set();
  for (const lines of byItem.values()) {
    const quantity = lines.reduce((sum, line) => sum + Number(line.salesQty), 0);
    const selected = selectedLineIds[lines[0].itemId];
    const matches = materials.filter(candidate => Number(candidate.itemId) === Number(lines[0].itemId)
      && cleanUom(candidate.uom) === cleanUom(lines[0].salesUom)
      && (!selected || Number(candidate.remoteLineId) === Number(selected)));
    const exact=matches.filter(candidate=>sameQty(candidate.quantity,quantity));
    const matchedQuantity=matches.reduce((sum,line)=>sum+Number(line.quantity),0);
    const candidates=sameQty(matchedQuantity,quantity)?matches:exact.length===1?exact:[];
    if (!candidates.length && matches.length && !exact.length) {
      const unit=lines[0].salesUom ? ` ${lines[0].salesUom}` : '';
      mismatch(`Quantity mismatch for ${lines[0].itemName || lines[0].itemId}: the stock request approves ${quantity}${unit}, but ${salesOrder.ref || 'the SO'} has ${matchedQuantity}${unit}. Quantities must match before linking the SO.`);
    }
    if (!candidates.length) mismatch(`Select the exact open SO line for ${lines[0].itemName || lines[0].itemId} with quantity ${quantity}.`);
    for(const candidate of candidates){
      if (Number(candidate.locationId) !== Number(request.destinationLocationId) || used.has(candidate.remoteLineId)) mismatch('Matched SO lines must still be at your Sales location.');
      used.add(candidate.remoteLineId);
    }
    let index=0,remaining=Number(candidates[0].quantity);
    for (const line of lines) {
      let quantityLeft=Number(line.salesQty);
      while(quantityLeft>1e-6){
        const candidate=candidates[index];
        if(!candidate||!(remaining>0))mismatch('SO quantities could not be allocated exactly.');
        const allocated=Math.min(remaining,quantityLeft);
        mappings.push({requestLineId:Number(line.id),remoteLineId:Number(candidate.remoteLineId),itemId:Number(line.itemId),quantity:allocated});
        quantityLeft-=allocated;remaining-=allocated;
        if(remaining<=1e-6){index++;remaining=Number(candidates[index]?.quantity||0);}
      }
    }
  }
  const sources = new Set(approved.map(line => Number(line.sourceLocationId)));
  const complete = materials.every(line => used.has(line.remoteLineId));
  const mode = complete && sources.size === 1 ? 'location' : 'transfer';
  return { mode, sourceLocationId: mode === 'location' ? [...sources][0] : null,
    materialLineIds: [...used], mappings, salesOrderId: Number(salesOrder.id), salesOrderRef: salesOrder.ref,
    groups: mode === 'transfer' ? groupStockRequestLinesForTransfer(approved.map(line => ({ ...line, destinationLocationId: request.destinationLocationId }))) : [] };
}

/** @param {{preferredQuantity:number,inventoryPositionQuantity:number,purchaseIncrement?:number}} input */
export function regularReplenishmentQuantity({ preferredQuantity, inventoryPositionQuantity, purchaseIncrement = 1 }) {
  if (![preferredQuantity, inventoryPositionQuantity, purchaseIncrement].every(valid) || Number(preferredQuantity) < 0 || Number(purchaseIncrement) <= 0) throw regularError('Replenishment policy or units are unavailable.', 'REGULAR_REPLENISHMENT_POLICY');
  const gap = Math.max(0, Number(preferredQuantity) - Number(inventoryPositionQuantity));
  return Math.max(0, Math.ceil(gap / Number(purchaseIncrement) - 1e-9)) * Number(purchaseIncrement);
}
