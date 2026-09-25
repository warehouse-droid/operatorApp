import { normalizeSpecialRate, normalizeSpecialDiscount, specialNativePricing, specialQuantity } from '../public/special-stock-pricing.js';

function invalid(message, code) { return Object.assign(new Error(message), { status: 409, code }); }
export const quantityReviewPending = review => ['pending','applying','attention'].includes(review?.status);
export function assertNoSpecialQuantityReview(special) {
  if (quantityReviewPending(special.quantity_review || special.quantityReview)) throw invalid('SCM must finish the quantity review before releasing this request.', 'SPECIAL_QUANTITY_REVIEW_REQUIRED');
}

export function prepareSpecialMaterial(line, accepted) {
  const originalRate = normalizeSpecialRate(accepted.originalRate ?? line.rate);
  if (Number(line.rate) !== originalRate) throw invalid('The original rate is locked. Use Discount % to offer a lower price.', 'SPECIAL_RATE_LOCKED');
  const legacy = accepted.pricingSource !== 'enquiry';
  const basisUom = accepted.rateUom || (legacy ? line.uom : accepted.uom);
  const packageQuantity = line.packageQuantity ?? (legacy ? line.quantity : null);
  const conversionToPc = line.conversionToPc ?? (legacy && basisUom === line.uom ? 1 : null);
  const discountPercent = normalizeSpecialDiscount(line.discountPercent ?? accepted.discountPercent);
  const native = specialNativePricing({ quantity: packageQuantity, rate: originalRate, discountPercent, conversionToPc });
  if (Number(line.quantity) !== native.quantity || (!legacy && line.uom !== 'PC')) {
    throw invalid('SO quantity and unit must match the explicit PC conversion.', 'SPECIAL_CONVERSION_MISMATCH');
  }
  return { ...line, ...native, uom: legacy && native.conversionToPc === 1 ? line.uom : 'PC', originalRate, basisUom, discountPercent };
}

export function draftQuantityChanges(lines, acceptedById) {
  return lines.flatMap(line => {
    const before = acceptedById.get(line.caseLineId);
    const fromPackageQuantity = before.reviewedPackageQuantity ?? before.packageQuantity ?? before.quantity;
    const fromConversion = before.reviewedConversionToPc ?? line.conversionToPc;
    if (line.packageQuantity === fromPackageQuantity && line.conversionToPc === fromConversion) return [];
    const fromQuantity = specialQuantity(Number((fromPackageQuantity * fromConversion).toFixed(6)));
    return [{ caseLineId: line.caseLineId, productName: before.productName, packageUom: line.basisUom,
      fromPackageQuantity, toPackageQuantity: line.packageQuantity, fromConversion, toConversion: line.conversionToPc,
      fromQuantity, toQuantity: line.quantity, fromPurchaseQuantity: fromQuantity, toPurchaseQuantity: line.quantity,
      salesUom: line.uom, purchaseUom: line.uom }];
  });
}
