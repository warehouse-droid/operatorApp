// @ts-check
import { buildOperatorNetSuitePostingDraft } from './operator-netsuite-posting-domain.js';
import { isFulfillableNetSuiteLine, isCompletedNetSuitePostingOrder } from './netsuite-fulfillable-items.js';

/** @param {string} message */
function invalid(message) {return Object.assign(new Error(message),{code:'DIRECT_PO_IR_SOURCE_INVALID',status:409,postingNotAttempted:true});}
/** @param {unknown} value */
function positive(value) {const n=Number(value);if(!Number.isFinite(n)||n<=0){throw invalid('A positive finite receipt quantity is required.');}return n;}
/** @param {unknown} value */
function sourceId(value) {const id=Number(value);if(!Number.isSafeInteger(id)||id<=0){throw invalid('A positive NetSuite PO parent identity is required.');}return id;}

/** @param {Record<string,any>} input */
export function buildDirectPoReceiptDraft(input) {
  const {order,source,policy,evidence}=input;
  const parent=sourceId(order.source_po_id ?? order.netsuite_id);
  if (source.sourceOrderKind !== 'PO' || Number(source.sourceNetSuiteId) !== parent) {throw invalid('The live PO parent identity does not match.');}
  if (isCompletedNetSuitePostingOrder('PO',source)) {throw invalid('The live NetSuite PO is already complete.');}
  const key=`receiving:purchase_order:${order.netsuite_id}`;
  const selectedLines=(input.lines || []).filter(isFulfillableNetSuiteLine).map((/** @type {Record<string,any>} */ line)=>{
    const stable=String(line.source_line_key ?? line.line_id);
    const matches=(source.lines || []).filter((/** @type {Record<string,any>} */ live)=>live.sourceLineKey===stable || (live.sourceLineAliases || []).includes(stable));
    if(matches.length!==1 || matches[0].identityStatus!=='exact'){throw invalid('The direct PO line mapping is not unique and exact.');}
    const live=matches[0];
    if(Number(live.itemId)!==Number(line.item_id)){throw invalid('The direct PO item identity changed.');}
    const quantity=positive(line.quantity);
    if(quantity>Number(live.orderedQuantity ?? live.quantity)+0.000001){throw invalid('The delivered quantity exceeds the live PO line quantity.');}
    if(Number(line.location_id)!==Number(live.location)){throw invalid('The direct PO line location changed.');}
    return {orderLine:sourceId(live.restOrderLine),quantity,location:Number(live.location),sourceLineKey:stable,
      itemId:Number(line.item_id),localOrderKey:key,localLineId:String(line.id),directCompletionEventId:sourceId(evidence.completionEventId)};
  });
  if(!selectedLines.length){throw invalid('No receivable direct PO lines are available.');}
  const availableLines=(source.lines || []).filter((/** @type {Record<string,any>} */ line)=>Number.isSafeInteger(Number(line.restOrderLine)) && Number(line.restOrderLine)>0).map((/** @type {Record<string,any>} */ line)=>({
    orderLine:Number(line.restOrderLine),sourceLineKey:line.sourceLineKey,sourceLineAliases:line.sourceLineAliases,
    location:line.location,orderedQuantity:Number(line.orderedQuantity ?? line.quantity),completedQuantity:Number(line.completedQuantity),
    remainingQuantity:Number(line.remainingQuantity),linkedTransactions:line.linkedTransactions || []}));
  const localPayload={item:{items:selectedLines.map((/** @type {Record<string,any>} */ selected)=>{
    const local=input.lines.find((/** @type {Record<string,any>} */ line)=>String(line.id)===selected.localLineId);
    const live=availableLines.find((/** @type {Record<string,any>} */ line)=>line.orderLine===selected.orderLine);
    return {orderLine:Number(local.line_id),quantity:Number(Math.min(selected.quantity,live.remainingQuantity).toFixed(6)),itemReceive:true,location:selected.location};
  }).filter((/** @type {Record<string,any>} */ line)=>line.quantity>0)}};
  return buildOperatorNetSuitePostingDraft({requestId:input.requestId,actorOperatorId:null,functionKey:'receiving',transactionType:'IR',policy,
    photoRefs:input.photoRefs || [],localOrderKeys:[key,`source:IR:PO:${parent}`],
    localOperation:{kind:'direct_po_receipt',orderId:String(order.netsuite_id),orderType:'purchase_order'},
    directDeliveryEvidence:evidence,localPayload,
    targets:[{sourceOrderKind:'PO',sourceNetSuiteId:parent,sourceOrderRef:order.source_po_ref || order.tranid,
      memo:order.dispatch_ref || order.tranid,selectedLines,availableLines}]});
}

/** @param {Record<string,any>} step @param {Record<string,any>} live */
export function assertDirectPoReceiptStepCurrent(step,live) {
  if(!live || isCompletedNetSuitePostingOrder('PO',live)){throw invalid('The live NetSuite PO is already complete.');}
  for(const item of step.payload.item.items.filter((/** @type {Record<string,any>} */ line)=>line.itemReceive && Number(line.quantity)>0)) {
    assertDirectPoReceiptLineCurrent(step,item,live);
  }
}
/** @param {Record<string,any>} step @param {Record<string,any>} item @param {Record<string,any>} live */
function assertDirectPoReceiptLineCurrent(step,item,live) {
    const matches=(live.lines || []).filter((/** @type {Record<string,any>} */ line)=>Number(line.restLineId)===Number(item.orderLine));
    const identity=(step.lineSnapshot || []).find((/** @type {Record<string,any>} */ line)=>Number(line.orderLine)===Number(item.orderLine));
    if(matches.length!==1 || Number(matches[0].itemId)!==Number(identity?.itemId)){throw invalid('The live PO item identity changed.');}
    const line=matches[0],remaining=line.closed ? 0 : Math.max(Number(line.quantity)-Number(line.receivedQuantity),0);
    if(!Number.isFinite(remaining)||remaining<=0||Number(item.quantity)>remaining+0.000001){throw invalid('The PO line has insufficient live remaining quantity.');}
    if(Number(line.locationId)!==Number(item.location)){throw invalid('The live PO receipt location changed.');}
}
