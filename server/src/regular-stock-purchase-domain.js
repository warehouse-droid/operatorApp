/** @param {string} message @param {number} [status] */
const error = (message,status=400) => Object.assign(new Error(message),{status,code:'REGULAR_PURCHASE_INVALID'});
/** @param {number} value */
const round = value => Number(value.toFixed(6));

/** @param {string} deliveryMethod @param {string} [value] */
export function normalizeStockingType(deliveryMethod, value = 'transfer') {
  if(deliveryMethod==='waitlist')return 'waitlist';
  const type = String(value || 'transfer').trim().toLowerCase();
  if (!['purchase','transfer'].includes(type) || type === 'purchase' && deliveryMethod !== 'stocking') {
    throw error('Choose Purchase or Transfer for a Stocking request.');
  }
  return type;
}

/** @param {{regular?: {deliveryMethod?: string,stockingType?: string}} | null | undefined} request */
export const isPurchaseStocking = request => request?.regular?.deliveryMethod === 'stocking' && request.regular.stockingType === 'purchase';

/** @param {number} requestedQuantity @param {number} toPlt @param {number} [reviewedQuantity] */
export function purchaseReviewQuantity(requestedQuantity, toPlt, reviewedQuantity = requestedQuantity) {
  const requested = Number(requestedQuantity), reviewed = Number(reviewedQuantity), conversion = Number(toPlt);
  if (![requested,reviewed].every(value => Number.isFinite(value) && value > 0 && value <= 1000000000)) {
    throw error('Purchase quantities must be positive numbers within the quantity limit.');
  }
  if (!Number.isFinite(conversion) || conversion <= 0) throw error('A valid pallet conversion is required before adding this item to a PO proposal.',409);
  let approvedPallets = Math.ceil(reviewed / conversion);
  // Decimal sales-unit conversions can produce a floating point quotient just
  // above an integer. Compare the actual rounded quantity before adding a pallet.
  if (approvedPallets > 1 && round((approvedPallets - 1) * conversion) >= reviewed) approvedPallets--;
  const approvedQuantity = round(approvedPallets * conversion);
  if (!(approvedPallets > 0) || !(approvedQuantity > 0) || approvedQuantity > 1000000000) throw error('The rounded purchase quantity exceeds the quantity limit.');
  return {requestedQuantity:requested,reviewedQuantity:reviewed,approvedPallets,approvedQuantity,toPlt:conversion};
}

// Inputs are already sorted by acceptance time. A receipt never belongs to two requests.
/** @param {Array<{id:number,remaining:number}>} demands @param {number} quantity @param {number} [received] */
export function allocatePurchaseQuantity(demands, quantity, received = 0) {
  let capacity = Math.max(0,Number(quantity)||0), receipts = Math.min(capacity,Math.max(0,Number(received)||0));
  const allocations = [];
  for (const demand of demands) {
    const allocated = round(Math.min(capacity,Math.max(0,Number(demand.remaining)||0)));
    if (allocated <= 0) continue;
    const receipt = round(Math.min(allocated,receipts));
    allocations.push({demandId:Number(demand.id),quantity:allocated,received:receipt});
    capacity=round(capacity-allocated); receipts=round(receipts-receipt);
  }
  return allocations;
}
