// @ts-check
import {mapOperatorKitSelections,operatorKitError} from './operator-netsuite-posting-kits.js';

/** @param {Record<string,any>} candidate @param {Record<string,any>} snapshot */
function savedPhysicalLine(candidate,snapshot) {
  const matches=(candidate.operatorLoadSnapshot || []).filter((/** @type {any} */ line)=>
    String(line.sourceLineId)===String(snapshot.sourceLineId)
      && Number(line.orderLine)===Number(snapshot.orderLine)
      && Number(line.itemId)===Number(snapshot.itemId)
      && Number(line.locationId)===Number(snapshot.location));
  if(matches.length!==1 || !/^[1-9][0-9]*$/u.test(String(matches[0].lineId))) {
    throw operatorKitError('The delivery load has no unique retained physical line identity.');
  }
  return matches[0];
}

/** @param {Record<string,any>} candidate @param {Record<string,any>} kitSource */
function assertLoadedKitIdentities(candidate,kitSource) {
  const members=kitSource.kitGroups.flatMap((/** @type {any} */ group)=>group.members);
  for(const snapshot of candidate.lineSnapshot || []) {
    const saved=savedPhysicalLine(candidate,snapshot);
    const matches=[...kitSource.availableLines,...members].filter(line=>line.orderLine===Number(snapshot.orderLine)
      && line.itemId===Number(snapshot.itemId) && line.location===Number(snapshot.location)
      && line.sourceLineKey===String(saved.lineId));
    if(matches.length!==1) {throw operatorKitError('The loaded delivery line no longer matches its exact source.');}
  }
}

/** Keep comparison/selection in physical units; only the posting plan uses kit parents.
 * @param {Record<string,any>} candidate
 * @param {{readSource:Function,readKitSource:Function}} dependencies */
export async function readDeliveryFulfillmentSource(candidate,{readSource,readKitSource}) {
  const source=await readSource(candidate.sourceSalesOrderId,{includeAllSourceLines:true});
  if(!source || source.fulfillmentComplete) {return source;}
  const lines=source.lines.filter((/** @type {any} */ line)=>line.canFulfill!==false);
  const missing=(candidate.lineSnapshot || []).some((/** @type {any} */ snapshot)=>
    !lines.some((/** @type {any} */ line)=>Number(line.orderLine)===Number(snapshot.orderLine)));
  if(!missing && !lines.some((/** @type {any} */ line)=>line.kitParent)) {return {...source,lines};}
  const kitSource=await readKitSource(candidate.sourceSalesOrderId);
  assertLoadedKitIdentities(candidate,kitSource);
  const parents=new Set(kitSource.kitGroups.map((/** @type {any} */ group)=>group.parent.orderLine));
  const physical=lines.filter((/** @type {any} */ line)=>!parents.has(line.orderLine));
  for(const group of kitSource.kitGroups) {
    const parent=kitSource.availableLines.find((/** @type {any} */ line)=>line.orderLine===group.parent.orderLine);
    for(const member of group.members) {
      const remainingQuantity=Number((parent.remainingQuantity*member.quantityPerKit).toFixed(6));
      physical.push({...member,quantity:member.orderedQuantity,remainingQuantity,
        fulfilledQuantity:Number((member.orderedQuantity-remainingQuantity).toFixed(6))});
    }
  }
  return {...source,lines:physical.sort((/** @type {any} */ a,/** @type {any} */ b)=>a.orderLine-b.orderLine),kitSource};
}

/** @param {Record<string,any>} candidate @param {Record<string,any>[]} selectedLines @param {Record<string,any>} liveOrder */
export function deliveryFulfillmentPostingPlan(candidate,selectedLines,liveOrder) {
  if(!liveOrder.kitSource) {return {selectedLines,availableLines:liveOrder.lines || [],liveOrder};}
  const physical=selectedLines.map(line=>{
    const snapshots=(candidate.lineSnapshot || []).filter((/** @type {any} */ snapshot)=>Number(snapshot.orderLine)===line.orderLine);
    if(snapshots.length!==1) {throw operatorKitError('A kit delivery selection has no unique loaded line.');}
    const saved=savedPhysicalLine(candidate,snapshots[0]);
    return {...line,sourceLineKey:String(saved.lineId),localLineId:String(snapshots[0].localLineId),
      localOrderKey:`delivery:sales_order:${candidate.sourceSalesOrderId}`};
  });
  const mapped=mapOperatorKitSelections(liveOrder.kitSource,physical).map(line=>({...line,
    itemId:line.kit ? line.kit.definition.parent.itemId : line.itemId}));
  return {selectedLines:mapped,availableLines:liveOrder.kitSource.availableLines,
    liveOrder:{...liveOrder,kitPostingLines:mapped}};
}
