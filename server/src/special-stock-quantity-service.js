import {
  withSpecialQuantityReviewLock, claimSpecialQuantityReview, rejectSpecialQuantityReview,
  saveSpecialQuantityReviewPlan, finishSpecialQuantityReview, failSpecialQuantityReview
} from './special-stock-request-repository.js';
import {
  resolveSpecialOrderUnitsFromNetSuite, prepareSpecialQuantityPlanInNetSuite, applySpecialQuantityPlanInNetSuite,
  prepareSpecialAdjustmentPlanInNetSuite, applySpecialAdjustmentPlanInNetSuite
} from './netsuite.js';
import { refreshSpecialVendorDiscountReview } from '../public/special-stock-purchase-pricing.js';

function error(message, code) { return Object.assign(new Error(message), { status: 409, code }); }

export function createSpecialQuantityService(dependencies = {}) {
  const deps = { withReviewLock: withSpecialQuantityReviewLock, claimReview: claimSpecialQuantityReview,
    rejectReview: rejectSpecialQuantityReview, savePlan: saveSpecialQuantityReviewPlan,
    finishReview: finishSpecialQuantityReview, failReview: failSpecialQuantityReview,
    resolveOrderUnits: resolveSpecialOrderUnitsFromNetSuite,
    preparePlan: prepareSpecialQuantityPlanInNetSuite, applyPlan: applySpecialQuantityPlanInNetSuite,
    prepareAdjustmentPlan:prepareSpecialAdjustmentPlanInNetSuite,applyAdjustmentPlan:applySpecialAdjustmentPlanInNetSuite, ...dependencies };

  async function orderTargets(detail) {
    const orders = [];
    for (const kind of ['sales_order', 'purchase_order']) {
      const sales = kind === 'sales_order';
      const id = sales ? detail.salesOrderId : detail.purchaseOrderId;
      if (!id) continue;
      const lines = detail.quantityReview.lines.map(change => {
        const line = (sales ? detail.salesOrderLines : detail.purchaseOrderLines)
          .find(line => !line.ancillary && line.caseLineId === change.caseLineId);
        if (!line?.remoteLineId) throw error('Wait for the exact issued order lines to synchronize before confirming quantities.', 'SPECIAL_QUANTITY_LINES_INVALID');
        return { ...line, rate: sales ? line.rate : line.unitPurchaseCost ?? line.rate ?? 0,
          quantity: sales ? change.fromQuantity : change.fromPurchaseQuantity,
          ...(sales ? {toRate:change.toRate,toNativeDiscountPercent:change.toNativeDiscountPercent} : {}),
          toQuantity: sales ? change.toQuantity : change.toPurchaseQuantity };
      });
      let pallets;
      if(sales && detail.quantityReview.pallets){
        const units=await deps.resolveOrderUnits([{itemId:1784,uom:'EACH',quantity:1}]);
        pallets={...detail.quantityReview.pallets,unitId:units[0].unitId};
      }
      let vendorDiscountTotal;
      if (!sales && detail.vendorDiscountReview?.mode === 'per_line' && detail.vendorDiscountReview.lines.some(line=>line.vendorDiscountPercent>0)) {
        const total = target => refreshSpecialVendorDiscountReview(detail.purchaseOrderLines.map(line=>{
          const change=detail.quantityReview.lines.find(change=>change.caseLineId===line.caseLineId);
          return {...line,quantity:change ? change[target ? 'toPurchaseQuantity' : 'fromPurchaseQuantity'] : line.quantity};
        }),detail.vendorDiscountReview).amount;
        vendorDiscountTotal={before:total(false),after:total(true)};
      }
      orders.push({ id, kind, discountMode: detail.salesDiscountMode || 'line', lines: await deps.resolveOrderUnits(lines),
        ...(pallets?{pallets}:{}),...(vendorDiscountTotal?{vendorDiscountTotal}:{}) });
    }
    return orders;
  }

  async function reviewQuantityChange(caseId, input = {}, context = {}) {
    if (!['approve', 'reject'].includes(input.decision)) throw error('Choose approve or reject.', 'SPECIAL_QUANTITY_DECISION_INVALID');
    return deps.withReviewLock(caseId, async () => {
      if (input.decision === 'reject') return deps.rejectReview(caseId, input, context);
      let claimed;
      try {
        claimed = await deps.claimReview(caseId, { reviewId: input.reviewId, expectedRevision: input.expectedRevision }, context);
        if (claimed.quantityReview.status === 'approved') return claimed;
        const remote = claimed.salesOrderId || claimed.purchaseOrderId;
        if (remote && (claimed.salesOrderSkipped || claimed.purchaseOrderSkipped)) throw error('A mixed real/test order pair cannot update live orders.', 'SPECIAL_TEST_ORDER_REMOTE_BLOCKED');
        let verifiedOrderIds = [];
        let verifiedOrders = [];
        if (remote) {
          const orders = claimed.quantityReviewPlan ? null : await orderTargets(claimed);
          const prepare=claimed.quantityReview.adjustmentVersion===2 || orders?.some(order=>order.vendorDiscountTotal) ? deps.prepareAdjustmentPlan : deps.preparePlan;
          const plan = claimed.quantityReviewPlan || await prepare({ orders });
          await deps.savePlan(caseId, { reviewId: input.reviewId, plan, remoteStarted: true });
          ({ verifiedOrderIds,verifiedOrders=[] } = await (plan.version===2 ? deps.applyAdjustmentPlan : deps.applyPlan)(plan));
        }
        return await deps.finishReview(caseId, { reviewId: input.reviewId, verifiedOrderIds,verifiedOrders }, context);
      } catch (failure) {
        if (claimed) await deps.failReview(caseId, { reviewId: input.reviewId, errorMessage: failure.message }, context);
        throw failure;
      }
    });
  }
  return { reviewQuantityChange };
}
export const reviewSpecialQuantityChange = (...args) => createSpecialQuantityService().reviewQuantityChange(...args);
