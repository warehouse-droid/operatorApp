import {createHash} from 'node:crypto';
import {STOCK_REQUEST_YARDS} from './stock-request-domain.js';
import {regularError} from './regular-stock-domain.js';

const yardName=id=>STOCK_REQUEST_YARDS.find(yard=>yard.locationId===Number(id))?.yardCode || String(id);
// Canonical keys keep a saved JSON plan and a fresh preview comparable.
const canonical=value=>value instanceof Date?value.toISOString():Array.isArray(value)?value.map(canonical):value && typeof value==='object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])) : value;
export function regularStockConfirmationToken(requestId,plan) {
  return createHash('sha256').update(JSON.stringify(canonical({requestId:Number(requestId),plan}))).digest('hex');
}
export function requireRegularStockConfirmation(requestId,plan,token) {
  if(!token)throw regularError('Review and confirm the SO routing before proceeding.','REGULAR_CONFIRMATION_REQUIRED');
  if(token!==regularStockConfirmationToken(requestId,plan))throw regularError('The SO or routing changed. Review the updated action and confirm again.','REGULAR_CONFIRMATION_CHANGED');
}
export function describeRegularStockAction(plan) {
  return {mode:plan.mode,salesOrderRef:plan.salesOrderRef,sourceLocationId:plan.sourceLocationId,
    sourceName:plan.mode==='location'?yardName(plan.sourceLocationId):null,
    destinationLocationId:plan.order.locationId,destinationName:yardName(plan.order.locationId),
    lineCount:plan.order.lines.length,
    routes:plan.groups.map(group=>({sourceLocationId:group.sourceLocationId,sourceName:yardName(group.sourceLocationId),
      destinationLocationId:group.destinationLocationId,destinationName:yardName(group.destinationLocationId)}))};
}
