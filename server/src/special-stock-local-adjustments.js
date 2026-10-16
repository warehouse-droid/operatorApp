import { changedSpecialLineFields, specialLineFieldValues } from '../public/special-stock-line-fields.js';
import { normalizeSpecialDiscount, normalizeSpecialRate, specialNativeLinePricing, specialPalletQuantity, specialQuantity } from '../public/special-stock-pricing.js';
import { specialItemDescription } from '../public/special-stock-line-details.js';

/** @param {string} message @param {string} code */
function invalid(message, code = 'SPECIAL_QUANTITY_LINES_INVALID') {
  return Object.assign(new Error(message), {status:400,code});
}

/** @param {Record<string,any>} before @param {Record<string,any>} input */
function materialChange(before, input) {
  const fromConversion = before.conversionToPc ?? 1;
  const fromQuantity = before.itemResolution?.salesQuantity ?? before.packageQuantity * fromConversion;
  const fromPurchaseQuantity = before.itemResolution?.purchaseQuantity ?? fromQuantity;
  const identity = {caseLineId:before.id,productName:before.productName,packageUom:before.rateUom,
    fromPackageQuantity:before.packageQuantity,fromQuantity,fromPurchaseQuantity};
  if (input.remove === true) {
    return {...identity,remove:true};
  }
  const fields = changedSpecialLineFields(input,before,{sales:true});
  const quantity = specialQuantity(input.quantity ?? before.packageQuantity);
  const discount = normalizeSpecialDiscount(input.discountPercent ?? before.discountPercent);
  delete fields.quantity; delete fields.discountPercent;
  if (quantity === before.packageQuantity && discount === before.discountPercent && !Object.keys(fields).length) {
    return null;
  }
  const conversion = fields.uom ? 1 : fromConversion;
  const price = specialNativeLinePricing({quantity,rate:before.originalRate,discountPercent:discount,conversionToPc:conversion});
  return {...identity,fromConversion,toConversion:conversion,toPackageQuantity:quantity,
    toQuantity:price.quantity,toPurchaseQuantity:specialQuantity(Number((fromPurchaseQuantity * price.quantity / fromQuantity).toFixed(6))),
    fromDiscountPercent:before.discountPercent,toDiscountPercent:discount,
    ...(Object.keys(fields).length ? {fromFields:Object.fromEntries(Object.keys(fields).map(field=>[field,specialLineFieldValues(before)[field]])),toFields:fields} : {})};
}

/** @param {Record<string,any>} detail @param {Record<string,any>} input */
function palletChange(detail, input) {
  const fromQuantity = specialPalletQuantity(detail.palletTotal ?? 0);
  const toQuantity = input.palletTotal === undefined ? fromQuantity : specialPalletQuantity(input.palletTotal);
  if (fromQuantity === toQuantity) {
    return null;
  }
  return {fromQuantity,toQuantity,rate:normalizeSpecialRate(detail.palletRate ?? (toQuantity ? input.palletRate : 0))};
}

/** Plan against the current request, independently of the issued order snapshots.
 * @param {Record<string,any>} detail @param {Record<string,any>} input */
export function planSpecialLocalAdjustment(detail, input) {
  const accepted = /** @type {Array<Record<string,any>>} */ (detail.lines).filter(line=>line.salesDecision==='accepted');
  if (!Array.isArray(input.lines) || input.lines.length !== accepted.length
    || input.lines.some(line=>!line || !Number.isSafeInteger(Number(line.caseLineId))
      || (line.remove !== undefined && typeof line.remove !== 'boolean'))
    || new Set(input.lines.map(line=>Number(line.caseLineId))).size !== accepted.length) {
    throw invalid('Provide each accepted product exactly once with a valid removal choice.');
  }
  const lines = input.lines.flatMap(line=>{
    const before = accepted.find(item=>item.id===Number(line.caseLineId));
    if (!before) {
      throw invalid('This product is not an accepted request line.');
    }
    const change = materialChange(before,line);
    return change ? [change] : [];
  });
  const pallets = palletChange(detail,input);
  if (!lines.length && !pallets) {
    throw invalid('Change or remove an item, or change PALLET quantity before submitting.','SPECIAL_QUANTITY_UNCHANGED');
  }
  return {localOnly:true,lines,...(pallets ? {pallets} : {})};
}

/** @param {Record<string,any>} review */
export function specialAdjustmentIsLocal(review) {
  return review.mode === 'issued' && review.remoteStarted !== true;
}

/** Keep an unissued PO draft aligned with the active local request.
 * @param {Record<string,any>} detail @returns {Array<Record<string,any>>} */
export function specialLocalPurchaseDraft(detail) {
  if (!detail.localAdjustedAt || detail.purchaseOrderId || detail.purchaseOrderSkipped) {
    return detail.purchaseOrderLines;
  }
  const active = new Map(/** @type {Array<Record<string,any>>} */ (detail.lines).map(line=>[line.id,line]));
  return /** @type {Array<Record<string,any>>} */ (detail.purchaseOrderLines).flatMap(line=>{
    if (line.ancillary) {
      return [line];
    }
    const material = active.get(line.caseLineId);
    return material ? [{...line,description:specialItemDescription(material),
      quantity:material.itemResolution?.purchaseQuantity ?? line.quantity}] : [];
  });
}
