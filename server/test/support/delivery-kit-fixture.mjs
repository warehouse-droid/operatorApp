import {normalizeOperatorKitSource} from '../../src/operator-netsuite-posting-kits.js';
import {createOperatorNetSuitePostingAdapter} from '../../src/operator-netsuite-posting-netsuite-adapter.js';
import {createSalesOrderAutoFulfillmentNetSuiteAdapter,fetchLiveSalesOrderAutoFulfillmentState} from '../../src/sales-order-auto-fulfillment-netsuite-adapter.js';
import {createSalesOrderAutoFulfillmentProcessor} from '../../src/sales-order-auto-fulfillment-service.js';
import {sobFixture} from './operator-kit-fixture.mjs';

export function deliveryKitFixture(raw=sobFixture()) {
  const kitSource=normalizeOperatorKitSource(raw.evidence),id='cfb2eed5-3618-400c-a814-53d6cdf02661';
  const candidate={id,externalId:`MBBS-SOIF-${id}`,status:'queued',resolutionAction:'automatic',
    sourceSalesOrderId:997764,operatorLoadRecordId:'42',canonicalLocationId:1,
    lineSnapshot:raw.selected.map(line=>({localLineId:line.localLineId,sourceLineId:line.localLineId,
      orderLine:Number(raw.evidence.sourceRows.find(row=>row.uniquekey===line.sourceLineKey).id),itemId:line.itemId,
      deliveredQuantity:line.quantity,location:line.location})),
    operatorLoadSnapshot:raw.selected.map(line=>({sourceLineId:line.localLineId,lineId:line.sourceLineKey,
      orderLine:Number(raw.evidence.sourceRows.find(row=>row.uniquekey===line.sourceLineKey).id),
      itemId:line.itemId,quantity:line.quantity,locationId:line.location}))};
  const source={id:997764,status:'B',lines:kitSource.availableLines.map(line=>({...line,quantity:line.orderedQuantity,
    fulfilledQuantity:line.completedQuantity,canFulfill:true,
    ...(kitSource.kitGroups.some(g=>g.parent.orderLine===line.orderLine)?{kitParent:true}:{})}))};
  return {raw,kitSource,candidate,source};
}

export function memoryDeliveryRepository(candidate) {
  return {prepare:async()=>candidate,get:async()=>candidate,
    claim:async input=>{if(candidate.status!=='queued' && candidate.status!=='uncertain')return null;
      Object.assign(candidate,{status:'posting',leaseToken:'test-lease',payload:input.payload,liveSnapshot:{...input.liveOrder,selectedLines:input.selectedLines}});return candidate;},
    renew:async()=>true,startAttempt:async()=>({attemptNumber:1}),
    complete:async input=>{Object.assign(candidate,{status:'completed',result:input});return candidate;},
    reconciled:async()=>{candidate.status='reconciled';return candidate;},
    closed:async()=>{candidate.status='closed';return candidate;},
    attention:async input=>{candidate.status='attention';candidate.error=input.error;return candidate;},
    failure:async input=>{candidate.status=input.uncertain?'uncertain':'failed';candidate.error=input.error.message;return candidate;}};
}

export function deliveryKitProcessor(f,repository=memoryDeliveryRepository(f.candidate),options={}) {
  let posts=0,remote=null,kitReads=0;
  const native=createOperatorNetSuitePostingAdapter({
    findTransactionByExternalId:async()=>remote?{id:remote.id,record:remote}:null,
    fetchKitSource:async()=>options.preflightSource?options.preflightSource(f.kitSource):f.kitSource,
    fetchDispatchFulfillmentSource:async()=>f.source,
    transformSalesOrderToItemFulfillment:async(id,payload)=>{
      posts++;remote={id:8800656,tranId:'IF-TEST-KIT',transactionType:'IF',externalId:payload.externalId,createdFromId:id,
        item:{items:payload.item.items.filter(line=>line.itemReceive).map(line=>({...line,
          item:{id:String(f.kitSource.availableLines.find(source=>source.orderLine===line.orderLine).itemId)}}))}};
      if(options.timeout)throw Object.assign(new Error('timed out'),{code:'NETSUITE_REQUEST_TIMEOUT'});
      return options.fetchAfterPost?{id:remote.id}:{id:remote.id,record:remote};
    },fetchItemFulfillment:async()=>remote});
  const processor=createSalesOrderAutoFulfillmentProcessor({repository,workerId:'delivery-kit-test',
    adapter:createSalesOrderAutoFulfillmentNetSuiteAdapter({...native,hasSplitPlan:async()=>Boolean(options.splitPlan)}),
    fetchLiveOrder:candidate=>fetchLiveSalesOrderAutoFulfillmentState(candidate,{readSource:async()=>f.source,
      readKitSource:async()=>{kitReads++;return options.readKitSource?options.readKitSource():f.kitSource;}})});
  return {processor,posts:()=>posts,kitReads:()=>kitReads,remote:()=>remote};
}
