import {specialStage,specialPurchaseOrderDispatchReady} from './special-stock-workflow.js';

/** @typedef {Record<string,any>&{id:number,revision:number,requestRef:string,stage:string,status:string,workflowKind:'backorder',requestType:'regular',workflowVersion:2,destinationLocationId:number,destinationName:string,regular:Record<string,any>,lines:Array<Record<string,any>>,transfers:Array<Record<string,any>>,events:Array<Record<string,any>>}} BackorderRequest */
/** @param {Record<string,any>|null|undefined} request */
export const isBackorder = request => request?.workflowKind === 'backorder'
  || request?.regular?.deliveryMethod === 'backorder' || request?.deliveryMethod === 'backorder';
/** @param {Record<string,any>} detail */
export function backorderPurchaseReady(detail) {
  const open = (/** @type {Array<Record<string,any>>} */ (detail.lines || [])).filter(line => line.supplyStatus !== 'already_ordered' && !['declined','closed'].includes(line.salesDecision));
  return open.length > 0 && open.every(line => line.salesDecision === 'accepted'
    && Boolean(line.supplyStatus && line.stockCheckedAt));
}
/** @param {Record<string,any>} detail @param {'sales_order'|'purchase_order'} kind */
export function canLinkBackorderOrder(detail, kind) {
  return kind === 'purchase_order' ? backorderPurchaseReady(detail)
    : Boolean(detail.purchaseOrderId && detail.dispatchPlanning?.purchaseOrder?.planned === true);
}
/** @param {Record<string,any>} detail @param {'sales_order'|'purchase_order'} kind */
export function assertBackorderOrderLink(detail, kind) {
  if (isBackorder(detail) && !canLinkBackorderOrder(detail, kind)) {
    const salesOrder = kind === 'sales_order';
    throw Object.assign(new Error(salesOrder
      ? 'The linked PO must be planned before Sales can link the SO.'
      : 'SCM must review stock and Sales must accept every open material before linking a PO.'),
    {status:409,code:salesOrder ? 'BACKORDER_PO_PLANNING_REQUIRED' : 'BACKORDER_SALES_ACCEPTANCE_REQUIRED'});
  }
}
/** @param {Parameters<typeof specialStage>[0]&Record<string,any>} evidence */
export function backorderStage(evidence = {}) {
  if (evidence.closed || evidence.cancelled) return 'closed';
  if (evidence.linesResolved && evidence.hasAcceptedLines === false) return evidence.hasAlreadyOrderedLines ? 'completed' : 'closed';
  if (evidence.operationallyComplete) return 'completed';
  if (evidence.pendingUpdate) return 'pending_update';
  if (evidence.purchaseOrderId) return specialPurchaseOrderDispatchReady(evidence) ? 'dispatch_arrangement' : 'confirmed';
  if (evidence.salesOrderId) return 'confirmed';
  if (evidence.linesResolved && evidence.hasAcceptedLines) return 'confirmed';
  const stage = specialStage({...evidence, salesOrderSkipped:false, purchaseOrderSkipped:false,
    purchaseOrderId:null, purchaseOrderApproved:true, operationallyComplete:false,waitingForProduction:false});
  return stage;
}
/** @param {string} stage */
export const backorderBucket = stage => ['closed','completed'].includes(stage) ? 'completed' : 'pending';
/** @param {string|null|undefined} supplyStatus */
export function assertBackorderLineOpen(supplyStatus) {
  if (supplyStatus === 'already_ordered') {
    throw Object.assign(new Error('This material is completed because it is Already Ordered.'),
      {code:'BACKORDER_LINE_COMPLETED',status:409});
  }
}
/** @param {Record<string,any>|null|undefined} detail */
export function assertBackorderLocalAction(detail, {manualReference = false} = {}) {
  if (isBackorder(detail) && !manualReference) {
    throw Object.assign(new Error('Backorder uses manual order links. NetSuite order changes are unavailable.'),
      {code:'BACKORDER_REMOTE_BLOCKED',status:409});
  }
}
/** @param {Record<string,any>} input */
export function assertBackorderNoAncillary(input = {}) {
  if (['palletTotal','palletRate','deliveryFeeRate'].some(field => input[field] != null && input[field] !== '')
      || input.ancillaryLines?.length || input.pallet) {
    throw Object.assign(new Error('Backorder has no PALLET ancillary link or delivery fee.'),
      {code:'BACKORDER_ANCILLARY_BLOCKED',status:400});
  }
}
