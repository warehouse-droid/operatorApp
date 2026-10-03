// @ts-check
/** @param {Record<string,any>} object @param {string[]} keys */
function firstValue(object,keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== '') {return object[key];}
  }
  return '';
}
/** @param {Record<string,any>} line */
export function isFulfillableNetSuiteLine(line) {
  const type=String(firstValue(line,['item_type','itemType']));
  if (!['InvtPart','NonInvtPart'].includes(type)) {return false;}
  const name=String(firstValue(line,['sku','item_name','itemName'])).trim();
  if (/^(?:DELIVERY CHARGE|SALES CREDIT)/iu.test(name)) {return false;}
  const eligibility=firstValue(line,['is_fulfillable','isfulfillable','isFulfillable']);
  if (eligibility !== '') {
    return eligibility === true || /^(?:t|true|yes|1)$/iu.test(String(eligibility));
  }
  // Local mirrors do not retain this item flag. The established special-order
  // item is fulfillable; the live reader still verifies its current flag.
  return type === 'InvtPart' || /^MBBS-Special Order$/iu.test(name);
}

/** @param {string} kind @param {Record<string,any>} order */
export function isCompletedNetSuitePostingOrder(kind,order) {
  if (!['SO','PO'].includes(kind)) {throw new TypeError('SO or PO source kind is required.');}
  if (order.closed === true || order.fulfillmentComplete === true) {return true;}
  const status=String(order.status || '').trim().toUpperCase().split(':').at(-1);
  if (['C','F','G','H'].includes(status || '')) {return true;}
  const label=String(order.statusText ?? order.status_text ?? '').trim();
  if (/closed|cancelled|canceled|fully billed|fully received|fully fulfilled|complete/iu.test(label)) {return true;}
  return /pending bill(?:ing)?|billed|fulfilled|received/iu.test(label) && !/partial/iu.test(label);
}

/** @param {Record<string,any>} step @param {Record<string,any>|null} live */
export function assertDispatchFulfillmentStepCurrent(step,live) {
  if (!live || isCompletedNetSuitePostingOrder('SO',live)) {refuse('The live Sales Order is complete or unavailable.');}
  for (const item of step.payload?.item?.items || []) {
    if (item.itemReceive === true) {assertDispatchLineCurrent(step,item,live);}
  }
}

/** @param {string} message */
function refuse(message) {
  throw Object.assign(new Error(message),{code:'SALES_ORDER_IF_SOURCE_CHANGED',status:409,postingNotAttempted:true});
}
/** @param {Record<string,any>} line @param {Record<string,any>} item */
function sufficientRemaining(line,item) {
  const remaining=Number(line.remainingQuantity),quantity=Number(item.quantity);
  return !line.lineClosed && Number.isFinite(remaining) && remaining>0 && Number.isFinite(quantity)
    && quantity>0 && quantity<=remaining+0.000001;
}
/** @param {Record<string,any>} step @param {Record<string,any>} item @param {Record<string,any>|null} live */
function assertDispatchLineCurrent(step,item,live) {
  const snapshot=(step.lineSnapshot || []).find((/** @type {Record<string,any>} */ line)=>Number(line.orderLine)===Number(item.orderLine));
  const matches=(live?.lines || []).filter((/** @type {Record<string,any>} */ line)=>Number(line.orderLine)===Number(item.orderLine));
  if (!snapshot || matches.length!==1 || Number(matches[0].itemId)!==Number(snapshot.itemId)) {
    refuse('The current Sales Order line item identity has changed.');
  }
  const line=matches[0];
  if (!sufficientRemaining(line,item)) {refuse('The current Sales Order line has insufficient remaining quantity.');}
  if (Number(line.location)!==Number(item.location)) {refuse('The current Sales Order line location has changed.');}
}
