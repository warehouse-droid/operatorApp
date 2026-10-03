/**
 * Only a confirmed, durable quantity plan may explain a webhook arriving before
 * the local review commits. This grants no permission to write or dispatch.
 * @typedef {{caseLineId:number,fromQuantity:number,toQuantity:number,fromPurchaseQuantity:number,toPurchaseQuantity:number,salesUom:string,purchaseUom:string}} Proposal
 * @typedef {{caseLineId:number,remoteLineId:number,line:number,toQuantity:number}} Change
 * @typedef {{id:number,kind:string,changes:Change[],baseline:{line:number,itemId:number,quantity:number,description:string}[]}} Order
 * @typedef {{mode?:string,status?:string,remoteStarted?:boolean,lines?:Proposal[],plan?:{version:number,orders:Order[]}}} Review
 * @typedef {{id:number,caseLineId:number|null,itemId:number,remoteLineId:number|null,quantity:number,uom:string,description:string}} Expected
 */
/** @param {Review} review @param {string} kind @param {number} orderId @param {Expected[]} expected */
export function reviewedQuantityTransitions(review, kind, orderId, expected) {
  if (review?.mode !== 'issued' || !['applying', 'attention'].includes(review.status || '')
    || review.remoteStarted !== true || review.plan?.version !== 1) return [];
  const orders = review.plan.orders.filter(order => order.kind === kind && Number(order.id) === Number(orderId));
  if (orders.length !== 1) return [];
  const order = orders[0], sales = kind === 'sales_order';
  return expected.flatMap(line => {
    const proposals = (review.lines || []).filter(change => change.caseLineId === line.caseLineId);
    const changes = order.changes.filter(change => change.caseLineId === line.caseLineId && change.remoteLineId === line.remoteLineId);
    if (line.itemId !== 2055 || !line.remoteLineId || proposals.length !== 1 || changes.length !== 1) return [];
    const proposal = proposals[0], change = changes[0];
    const baseline = order.baseline.filter(before => before.line === change.line);
    const target = sales ? proposal.toQuantity : proposal.toPurchaseQuantity;
    if (baseline.length !== 1 || baseline[0].itemId !== line.itemId || baseline[0].description !== line.description
      || baseline[0].quantity !== line.quantity || line.quantity !== (sales ? proposal.fromQuantity : proposal.fromPurchaseQuantity)
      || line.uom !== (sales ? proposal.salesUom : proposal.purchaseUom)
      || !Number.isFinite(target) || target <= 0 || target > 1e9 || change.toQuantity !== target) return [];
    return [{ expectedLineId: line.id, remoteLineId: line.remoteLineId, description: line.description, quantity: target, uom: line.uom }];
  });
}
