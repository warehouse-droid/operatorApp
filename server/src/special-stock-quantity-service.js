import {
  withSpecialQuantityReviewLock, claimSpecialQuantityReview, rejectSpecialQuantityReview,
  saveSpecialQuantityReviewPlan, finishSpecialQuantityReview, failSpecialQuantityReview
} from './special-stock-request-repository.js';
import {
  resolveSpecialOrderUnitsFromNetSuite, prepareSpecialQuantityPlanInNetSuite, applySpecialQuantityPlanInNetSuite
} from './netsuite.js';

function error(message, code) { return Object.assign(new Error(message), { status: 409, code }); }

export function createSpecialQuantityService(dependencies = {}) {
  const deps = { withReviewLock: withSpecialQuantityReviewLock, claimReview: claimSpecialQuantityReview,
    rejectReview: rejectSpecialQuantityReview, savePlan: saveSpecialQuantityReviewPlan,
    finishReview: finishSpecialQuantityReview, failReview: failSpecialQuantityReview,
    resolveOrderUnits: resolveSpecialOrderUnitsFromNetSuite,
    preparePlan: prepareSpecialQuantityPlanInNetSuite, applyPlan: applySpecialQuantityPlanInNetSuite, ...dependencies };

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
          toQuantity: sales ? change.toQuantity : change.toPurchaseQuantity };
      });
      orders.push({ id, kind, lines: await deps.resolveOrderUnits(lines) });
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
        if (remote) {
          const plan = claimed.quantityReviewPlan || await deps.preparePlan({ orders: await orderTargets(claimed) });
          await deps.savePlan(caseId, { reviewId: input.reviewId, plan, remoteStarted: true });
          ({ verifiedOrderIds } = await deps.applyPlan(plan));
        }
        return await deps.finishReview(caseId, { reviewId: input.reviewId, verifiedOrderIds }, context);
      } catch (failure) {
        if (claimed) await deps.failReview(caseId, { reviewId: input.reviewId, errorMessage: failure.message }, context);
        throw failure;
      }
    });
  }
  return { reviewQuantityChange };
}
export const reviewSpecialQuantityChange = (...args) => createSpecialQuantityService().reviewQuantityChange(...args);
