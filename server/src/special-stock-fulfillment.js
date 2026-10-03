import {
  withSpecialQuantityReviewLock, claimSpecialFulfillmentChange, saveSpecialFulfillmentPlan,
  failSpecialFulfillmentChange, finishSpecialFulfillmentChange, getSpecialStockCase
} from './special-stock-request-repository.js';
import { prepareSpecialFulfillmentInNetSuite, applySpecialFulfillmentInNetSuite } from './netsuite.js';
import { isLocalPickupChange } from './special-stock-fulfillment-policy.js';

export function createSpecialFulfillmentService(dependencies={}) {
  const deps={withLock:withSpecialQuantityReviewLock,claim:claimSpecialFulfillmentChange,savePlan:saveSpecialFulfillmentPlan,
    fail:failSpecialFulfillmentChange,finish:finishSpecialFulfillmentChange,get:getSpecialStockCase,
    prepare:prepareSpecialFulfillmentInNetSuite,apply:applySpecialFulfillmentInNetSuite,...dependencies};
  return async (id,input,context)=>deps.withLock(id,async()=>{
    let detail;
    try {
      detail=await deps.claim(id,input,context);
      if(detail.fulfillmentChange.status==='complete') return deps.get(id,{audience:'sales',authorizedStoreLocationIds:context.authorizedStoreLocationIds});
      const change=detail.fulfillmentChange;
      let verified={};
      if(detail.salesOrderId && !isLocalPickupChange(detail.fulfillmentMethod,change.target.fulfillmentMethod,detail.fulfillmentChangePlan)){
        const plan=detail.fulfillmentChangePlan || await deps.prepare({salesOrderId:detail.salesOrderId,...change.target});
        await deps.savePlan(id,change.id,plan);
        verified=await deps.apply(plan);
      }
      return await deps.finish(id,change.id,verified,context);
    } catch(error){
      if(detail && detail.fulfillmentChange.status!=='complete') await deps.fail(id,detail.fulfillmentChange.id,error.message,context);
      throw error;
    }
  });
}
export const updateSpecialFulfillment=(...args)=>createSpecialFulfillmentService()(...args);
