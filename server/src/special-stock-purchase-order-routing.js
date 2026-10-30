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
  // Routing an existing linked PO is available to Backorders; creation and
  // commercial order edits retain their separate remote-action policy.
  assertSpecialStockRemoteOrderAllowed(detail,{manualReference:true});
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
/** @param {{purchaseOrderId:number,purchaseOrderRef:string}} identity */
async function linkedVendor(identity) {
  const row=(await query('SELECT vendor_id FROM purchase_orders WHERE netsuite_id=$1 AND tranid=$2 AND netsuite_active',
    [identity.purchaseOrderId,identity.purchaseOrderRef])).rows[0];
  if (!row?.vendor_id) throw conflict('Sync the linked PO vendor before editing its Note.');
  return Number(row.vendor_id);
}

/** @param {Record<string,any>} dependencies */
export function createSpecialPurchaseOrderRoutingService(dependencies={}) {
  const deps={transaction:withTransaction,lockCase,
    getCase:getSpecialStockCase,getOrder:getScmPurchaseOrderCatalogOrder,updateSchedule:updateScmScheduleEntry,
    readNote:readSpecialPurchaseOrderNoteFromNetSuite,updateNote:updateSpecialPurchaseOrderNoteInNetSuite,
    cacheNote,audit:writeAudit,getVendor:linkedVendor,...dependencies};
  /** @param {any} detail */
  async function identityFor(detail) {
    const identity=linkedPo(detail);
    if (detail.workflowKind==='backorder' && !detail.purchaseOrderSplitId) identity.vendorId=await deps.getVendor(identity);
    return identity;
  }
  return {
    /** @param {string|number} caseId */
    async readNote(caseId) {
      const detail=await deps.getCase(caseId,{audience:'scm'});
      if (detail.purchaseOrderSplitId) {
        const order=await deps.getOrder(detail.purchaseOrderTargetRef,{includeRestricted:true});
        if (!order || Number(order.scmSplitId)!==detail.purchaseOrderSplitId) throw conflict('Reload the attached child PO.');
        return {note:order.scm?.notes || ''};
      }
      const note=await deps.readNote(await identityFor(detail));
      await deps.cacheNote(detail,note);
      return {note};
    },
    /** @param {string|number} caseId @param {Record<string,any>} input @param {{operatorId?:string}} context */
    async save(caseId,input,context={}) {
      if (!Number.isSafeInteger(Number(caseId)) || Number(caseId)<=0) throw conflict('A valid request is required.',400);
      return deps.transaction(async()=>{
        await deps.lockCase(caseId);
        const detail=await deps.getCase(caseId,{audience:'scm'}),identity=await identityFor(detail);
        if (Number(input.expectedRevision)!==Number(detail.revision) || ['closed','completed'].includes(detail.stage)
            || detail.closeStatus==='closure_pending' || detail.quantityReviewPending) throw conflict('This request changed. Reload before saving.');
        const child=Boolean(detail.purchaseOrderSplitId);
        const order=await deps.getOrder(child ? detail.purchaseOrderTargetRef : detail.purchaseOrderReference || detail.purchaseOrderRef,{includeRestricted:true});
        if (!order || (child
          ? !order.isScmSplit || Number(order.scmSplitId)!==detail.purchaseOrderSplitId || order.sourcePoRef!==detail.purchaseOrderRef
          : order.isScmSplit || (order.originalPoRef || order.id)!==detail.purchaseOrderRef)) throw conflict('Load the routing of the linked PO.');
        if (child && Number(input.expectedSplitRevision)!==Number(order.scmSplitRevision)) throw conflict('This child PO changed. Reload before saving.');
        if (child && ['packingSlipRef','packing_slip_ref'].some(field=>Object.hasOwn(input,field))) throw conflict('Rename this child PO in PO Split.');
        const patch={...input};
        for (const field of ['expectedSplitRevision','expectedNote','expectedRevision','expectedUpdatedAt','orderKind']) delete patch[field];
        if (!child) delete patch.notes;
        // Check and write local routing in this transaction before any remote
        // Note write. A failed remote edit rolls these local changes back.
        const schedule=await deps.updateSchedule({orderKind:'PO',orderRef:order.id,patch,
          expectedUpdatedAt:input.expectedUpdatedAt,...(child ? {expectedSplitRevision:input.expectedSplitRevision} : {}),updatedBy:context.operatorId});
        if (child) {
          await deps.audit({source:'scm',action:'special_purchase_order_child_routing_updated',actorOperatorId:context.operatorId,
            orderId:detail.purchaseOrderId,details:{requestId:detail.id,splitId:detail.purchaseOrderSplitId,orderRef:order.id}});
          return {...schedule,note:input.notes};
        }
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
