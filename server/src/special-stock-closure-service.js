import { withSpecialClosureReviewLock, claimSpecialClosureReview, saveSpecialClosurePlan,
  finishSpecialClosureReview, rejectSpecialClosureReview, failSpecialClosureReview,
  requestSpecialCaseClosure, getSpecialStockCase, closeSpecialCaseForClosedOrders } from './special-stock-request-repository.js';
import { resolveSpecialOrderUnitsFromNetSuite, prepareSpecialClosurePlanInNetSuite, applySpecialClosurePlanInNetSuite, suiteqlAll } from './netsuite.js';
import { readSpecialClosedOrders } from './special-stock-closed-orders.js';

export function createSpecialClosureService(dependencies = {}) {
  const deps = { withReviewLock: withSpecialClosureReviewLock, claimReview: claimSpecialClosureReview,
    savePlan: saveSpecialClosurePlan, finishReview: finishSpecialClosureReview, rejectReview: rejectSpecialClosureReview,
    failReview: failSpecialClosureReview, resolveOrderUnits: resolveSpecialOrderUnitsFromNetSuite,
    preparePlan: prepareSpecialClosurePlanInNetSuite, applyPlan: applySpecialClosurePlanInNetSuite,
    requestCaseClosure: requestSpecialCaseClosure, getCase: getSpecialStockCase,
    readClosedOrders: detail=>readSpecialClosedOrders(detail,{queryAll:suiteqlAll}),
    closeLocalCase: closeSpecialCaseForClosedOrders, ...dependencies };
  async function closeAlreadyClosed(caseId,input,context) {
    const detail=await deps.getCase(caseId,{audience:context.salesClosure?'sales':'scm',
      authorizedStoreLocationIds:context.salesClosure?context.authorizedStoreLocationIds:undefined});
    if(!['active','closure_pending'].includes(detail.closeStatus))return null;
    const closedOrders=await deps.readClosedOrders(detail);
    if(!closedOrders)return null;
    const current=await deps.readClosedOrders(detail);
    if(!current || JSON.stringify(current)!==JSON.stringify(closedOrders)) {
      throw Object.assign(Error('NetSuite order status changed before local closure. Refresh and retry.'),{status:409,code:'SPECIAL_CLOSURE_UNVERIFIED'});
    }
    return deps.closeLocalCase(caseId,{...input,closedOrders},context);
  }
  async function applyReview(caseId,input,context) {
      if (input.decision === 'reject') return deps.rejectReview(caseId,input,context);
      let claimed;
      try {
        claimed = await deps.claimReview(caseId,input,context);
        if (claimed.closureReview.status === 'approved') return claimed;
        let plan = claimed.closureReviewPlan;
        if (!plan) {
          const orders=[];
          for (const [kind,id,lines] of [['sales_order',claimed.salesOrderId,claimed.salesOrderLines],['purchase_order',claimed.purchaseOrderId,claimed.purchaseOrderLines]]) {
            if (kind === 'purchase_order' && !id) continue;
            orders.push({kind,id,lines:await deps.resolveOrderUnits(lines),discountCount:lines.filter(line=>line.nativeDiscountPercent>0).length});
          }
          plan = await deps.preparePlan({orders});
        }
        await deps.savePlan(caseId,{reviewId:input.reviewId,plan});
        const result = await deps.applyPlan(plan);
        return await deps.finishReview(caseId,{reviewId:input.reviewId,verifiedOrderIds:result.verifiedOrderIds},context);
      } catch (error) {
        if (claimed) await deps.failReview(caseId,{reviewId:input.reviewId,errorMessage:error.message},context);
        throw error;
      }
  }
  return {
    async reviewClosure(caseId,input={},context={}) {
      if (!['approve','reject'].includes(input.decision)) throw Object.assign(Error('Choose confirm or reject.'),{status:400});
      return deps.withReviewLock(caseId,async()=>{
        if(input.decision==='approve') {
          const closed=await closeAlreadyClosed(caseId,input,context);
          if(closed)return closed;
        }
        return applyReview(caseId,input,context);
      });
    },
    async requestClosure(caseId,input={},context={}) {
      return deps.withReviewLock(caseId,async()=>{
        const closed=await closeAlreadyClosed(caseId,input,{...context,salesClosure:true});
        if(closed)return closed;
        const detail = await deps.requestCaseClosure(caseId,input,context);
        if (!detail.salesOrderId || detail.purchaseOrderId || detail.closeStatus !== 'closure_pending') return detail;
        await applyReview(caseId,{expectedRevision:detail.revision,reviewId:detail.closureReview.id,decision:'approve'},
          {...context,salesClosure:true});
        return deps.getCase(caseId,{audience:'sales',authorizedStoreLocationIds:context.authorizedStoreLocationIds});
      });
    }
  };
}
export const reviewSpecialClosure = (...args) => createSpecialClosureService().reviewClosure(...args);
export const requestSpecialClosure = (...args) => createSpecialClosureService().requestClosure(...args);
