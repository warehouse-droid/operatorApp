import {query,withTransaction} from './db.js';
import {writeAudit} from './auth-repository.js';
import {getSpecialStockCase} from './special-stock-request-repository.js';
import {assertSpecialStockRemoteOrderAllowed} from './special-stock-request-policy.js';
import {getScmPurchaseOrderCatalogOrder} from './scm-purchase-order-catalog-repository.js';
import {updateScmScheduleEntry} from './dispatch-repository.js';
import {readSpecialPurchaseOrderNoteFromNetSuite,updateSpecialPurchaseOrderNoteInNetSuite} from './netsuite.js';

/** @param {string} message @param {number} [status] */
const conflict=(message,status=409)=>Object.assign(Error(message),{status,code:'SPECIAL_PO_ROUTING_CONFLICT'});
/** @param {any} detail */
function linkedPo(detail) {
  assertSpecialStockRemoteOrderAllowed(detail);
  if (!detail?.purchaseOrderId || !detail.purchaseOrderRef) throw conflict('Create or link the real PO before editing its Note.');
  return {purchaseOrderId:detail.purchaseOrderId,purchaseOrderRef:detail.purchaseOrderRef,vendorId:detail.vendorId};
}
/** @param {any} detail @param {string} note */
async function cacheNote(detail,note) {
  const result=await query('UPDATE purchase_orders SET netsuite_note=$1 WHERE netsuite_id=$2 AND tranid=$3',
    [note,detail.purchaseOrderId,detail.purchaseOrderRef]);
  if (!result.rowCount) throw conflict('Sync this PO before saving its routing.');
}
/** @param {string|number} id */
async function lockCase(id) {
  await query('SELECT request_id FROM sales_special_stock_cases WHERE request_id=$1 FOR UPDATE',[id]);
}

/** @param {Record<string,any>} dependencies */
export function createSpecialPurchaseOrderRoutingService(dependencies={}) {
  const deps={transaction:withTransaction,lockCase,
    getCase:getSpecialStockCase,getOrder:getScmPurchaseOrderCatalogOrder,updateSchedule:updateScmScheduleEntry,
    readNote:readSpecialPurchaseOrderNoteFromNetSuite,updateNote:updateSpecialPurchaseOrderNoteInNetSuite,
    cacheNote,audit:writeAudit,...dependencies};
  return {
    /** @param {string|number} caseId */
    async readNote(caseId) {
      const detail=await deps.getCase(caseId,{audience:'scm'});
      const note=await deps.readNote(linkedPo(detail));
      await deps.cacheNote(detail,note);
      return {note};
    },
    /** @param {string|number} caseId @param {Record<string,any>} input @param {{operatorId?:string}} context */
    async save(caseId,input,context={}) {
      if (!Number.isSafeInteger(Number(caseId)) || Number(caseId)<=0) throw conflict('A valid request is required.',400);
      return deps.transaction(async()=>{
        await deps.lockCase(caseId);
        const detail=await deps.getCase(caseId,{audience:'scm'}),identity=linkedPo(detail);
        if (Number(input.expectedRevision)!==Number(detail.revision) || ['closed','completed'].includes(detail.stage)
            || detail.closeStatus==='closure_pending' || detail.quantityReviewPending) throw conflict('This request changed. Reload before saving.');
        const order=await deps.getOrder(detail.purchaseOrderReference || detail.purchaseOrderRef,{includeRestricted:true});
        if (!order || order.isScmSplit || (order.originalPoRef || order.id)!==detail.purchaseOrderRef) throw conflict('Load the routing of the linked real PO.');
        const patch={...input};
        for (const field of ['notes','expectedNote','expectedRevision','expectedUpdatedAt','orderKind']) delete patch[field];
        // Check and write local routing in this transaction before any remote
        // Note write. A failed remote edit rolls these local changes back.
        const schedule=await deps.updateSchedule({orderKind:'PO',orderRef:order.id,patch,
          expectedUpdatedAt:input.expectedUpdatedAt,updatedBy:context.operatorId});
        const note=await deps.updateNote({...identity,note:input.notes,expectedNote:input.expectedNote});
        await deps.cacheNote(detail,note);
        await deps.audit({source:'scm',action:'special_purchase_order_note_updated',actorOperatorId:/** @type {any} */ (context.operatorId),
          orderId:detail.purchaseOrderId,details:{requestId:detail.id,purchaseOrderRef:detail.purchaseOrderRef,note}});
        return {...schedule,note};
      });
    }
  };
}

/** @param {string|number} caseId */
export const readSpecialPurchaseOrderNote=caseId=>createSpecialPurchaseOrderRoutingService().readNote(caseId);
/** @param {string|number} caseId @param {Record<string,any>} input @param {{operatorId?:string}} context */
export const saveSpecialPurchaseOrderRouting=(caseId,input,context)=>createSpecialPurchaseOrderRoutingService().save(caseId,input,context);
