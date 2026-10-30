import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { query, closeDb } from '../../../src/db.js';
import { previewFrontdeskChargeRequest, confirmFrontdeskChargeRequest } from '../../../src/mbt/customer-charge-request-service.js';
import { readOverdueBins } from '../../../src/mbt/frontdesk-bin-overdue.js';
import {withdrawAutomaticCollection} from '../../../tools/bin-withdraw-automatic-collection.mjs';
import {addLegacyCollection} from '../support/legacy-bin-collection-fixture.js';
import {withTransaction} from '../../../src/db.js';
import {planningFixture} from '../support/bin-planning-fixtures.js';
import {configureBinOrderWorkflow} from '../../../src/mbt/bin-order-workflow-service.js';
import * as frontdesk from '../../../src/mbt/frontdesk-service.js';
import { createFrontdeskPrerequisites, quoteCommand, frontdeskCommand,
  frontdeskDistanceResolver, frontdeskTaxResolver } from '../support/frontdesk-fixtures.js';

after(closeDb);
const actor = { operatorId: 'explicit-collection-frontdesk', roles: ['mbt_frontdesk'] };
const window = { startAt: '2037-08-20T12:00:00Z', endAt: '2037-08-20T16:00:00Z' };
async function rental(multi = false, content = null, paymentMethod = "cash") {
  const f = await createFrontdeskPrerequisites({ label: `explicit-${crypto.randomUUID()}` });
  const command = quoteCommand(f, { actor, identity: crypto.randomUUID() });
  if (multi) command.serviceLines = [1, 2].map(() => ({ binTypeId: f.binTypeId,
    proposedDeliveryAt: f.proposedDeliveryAt, proposedReturnAt: f.proposedReturnAt }));
  if (content) {
    await query(`INSERT INTO mbt_deposit_rules(deposit_rule_id,rate_card_version_id,rule_code,rule_type,bin_type_id,fixed_amount_minor,currency,liability_account_mapping_key)
      VALUES($1,$2,'bin_deposit_20yd','bin_type','00000000-0000-4000-8000-000000000020',10000,'CAD','local_bin_deposit')`,[crypto.randomUUID(),f.rateCardVersionId]);
    await query("UPDATE mbt_frontdesk_charge_catalog SET active=true WHERE item_kind='fixed_dump' OR item_code='AGG_LOADING'");
    for (const code of ['DUMP_SOIL','DUMP_ASPHALT','DUMP_CONCRETE','AGG_LOADING']) {
      await query(`INSERT INTO mbt_frontdesk_charge_rates(charge_rate_id,rate_card_version_id,item_code,amount_minor,currency,active,created_by,updated_by)
        VALUES ($1,$2,$3,$4,'CAD',true,'test','test')`, [crypto.randomUUID(),f.rateCardVersionId,code,code==='AGG_LOADING' ? 5000 : 30000]);
    }
    Object.assign(command,{paymentMethod,billingAddressText:'100 Billing Road',serviceAddressText:'200 Site Road',contractTelephone:'4165550123',
      dumpItemCode:undefined,estimatedTonnes:undefined,serviceLines:[{binItemCode:f.binItemCode,binTypeId:f.binTypeId,contentCode:content,
        discountMinor:0,proposedDeliveryAt:f.proposedDeliveryAt,proposedReturnAt:f.proposedReturnAt,siteProfileId:f.siteProfileId}]});
  }
  const created = await frontdesk.createFrontdeskQuote(command,
    { resolveDistance: frontdeskDistanceResolver(f), resolveTaxPolicy: frontdeskTaxResolver });
  const quoteId = created.body.quote.quoteId;
  await frontdesk.issueFrontdeskQuote(frontdeskCommand('issue', actor,
    { quoteId, expectedRevision: 1, validUntil: '2037-08-04T12:00:00Z' }));
  await frontdesk.acceptFrontdeskQuote(frontdeskCommand('accept', actor,
    { quoteId, expectedRevision: 2, acceptedAt: '2037-08-03T10:00:00Z' }));
  const converted = await frontdesk.convertFrontdeskQuote(frontdeskCommand('convert', actor,
    { quoteId, expectedRevision: 3 }));
  return { ...f, ...converted.body, contractId: converted.body.contract.contractId,
    line: converted.body.serviceLines[0] };
}
async function collections(f) {
  return (await query("SELECT * FROM mbt_bin_orders WHERE service_line_id=$1 AND order_kind='collection'",
    [f.line.serviceLineId])).rows;
}
async function delivered(f) {
  await query("UPDATE mbt_service_visits SET status='completed',actual_completed_at=now() WHERE service_line_id=$1 AND service_action='delivery'",
    [f.line.serviceLineId]);
  f.line = (await frontdesk.getFrontdeskContractTimeline({ actor, contractId: f.contractId })).serviceLines[0];
}
function collect(f, extra = {}) {
  return frontdeskCommand('collect', actor, { contractId: f.contractId,
    serviceLineId: f.line.serviceLineId, expectedRevision: f.line.revision, collectionWindow: window, ...extra });
}

for (const multi of [false, true]) test(`collection request: ${multi ? 'multiple' : 'single'} bin creation has delivery only`, async () => {
  const f = await rental(multi);
  assert.deepEqual(f.visits.map(v => v.serviceAction), multi ? ['delivery', 'delivery'] : ['delivery']);
  assert.equal((await collections(f)).length, 0);
  assert.equal(f.line.plannedReturnAt, f.proposedReturnAt);
});

test('collection request: extending the expected return date creates no collection', async () => {
  const f = await rental(true);
  const result = await frontdesk.extendFrontdeskServiceLine(frontdeskCommand('extend', actor,
    { contractId: f.contractId, serviceLineId: f.line.serviceLineId,
      expectedRevision: f.line.revision, returnWindow: window }));
  assert.equal(result.body.returnVisit, null);
  assert.equal(result.body.serviceLine.plannedReturnAt, '2037-08-20T12:00:00.000Z');
  assert.equal((await collections(f)).length, 0);
});

test('collection request: explicit command creates C once, replay and stale competitor cannot duplicate it', async () => {
  const f = await rental(true);
  await assert.rejects(frontdesk.collectFrontdeskServiceLine(collect(f)), { code: 'MBT_FRONTDESK_BIN_NOT_DELIVERED' });
  await delivered(f);
  const request = collect(f);
  const result = await frontdesk.collectFrontdeskServiceLine(request);
  const replay = await frontdesk.collectFrontdeskServiceLine(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.body.collectionVisit.visitId, result.body.collectionVisit.visitId);
  await assert.rejects(frontdesk.collectFrontdeskServiceLine(collect(f)), { code: 'MBT_STALE_REVISION' });
  const orders = await collections(f);
  assert.equal(orders.length, 1);
  assert.match(orders[0].display_reference, /^BIN\d{5,}C$/);
  const visit = (await query('SELECT * FROM mbt_service_visits WHERE service_visit_id=$1', [orders[0].order_id])).rows[0];
  assert.equal(visit.service_snapshot.collectionRequestedBy, actor.operatorId);
  assert.equal(visit.predecessor_visit_id, f.visits[0].visitId);
  assert.equal(visit.status, 'ready');
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_contract_service_line_events WHERE service_line_id=$1 AND event_type='collection'", [f.line.serviceLineId])).rows[0].n, 1);
});


test('collection request: overdue reminder is read-only, extension clears it, and completed pickup clears it', async () => {
  const f = await rental(true);
  const now = new Date('2037-09-01T00:00:00Z');
  assert.equal((await readOverdueBins(now)).items.some(i=>i.serviceLineId===f.line.serviceLineId),false);
  assert.equal((await frontdesk.getFrontdeskContractTimeline({actor,contractId:f.contractId})).serviceLines[0].binAvailableForService,false);
  await delivered(f);
  assert.equal((await readOverdueBins(now)).items.find(i=>i.serviceLineId===f.line.serviceLineId).collectionRequested,false);
  assert.equal((await collections(f)).length,0);
  const collected = await frontdesk.collectFrontdeskServiceLine(collect(f));
  assert.equal((await readOverdueBins(now)).items.find(i=>i.serviceLineId===f.line.serviceLineId).collectionRequested,true);
  await query("UPDATE mbt_visit_steps SET status='completed',completed_at=now() WHERE service_visit_id=$1 AND action_code='pickup_bin'",[collected.body.collectionVisit.visitId]);
  assert.equal((await readOverdueBins(now)).items.some(i=>i.serviceLineId===f.line.serviceLineId),false);
  assert.equal((await frontdesk.getFrontdeskContractTimeline({actor,contractId:f.contractId})).serviceLines[0].binAvailableForService,false);
  const other = await rental(); await delivered(other);
  await frontdesk.extendFrontdeskServiceLine(frontdeskCommand('later',actor,{contractId:other.contractId,serviceLineId:other.line.serviceLineId,
    expectedRevision:other.line.revision,returnWindow:{startAt:'2037-10-01T12:00:00Z',endAt:'2037-10-01T16:00:00Z'}}));
  assert.equal((await readOverdueBins(now)).items.some(i=>i.serviceLineId===other.line.serviceLineId),false);
});

test('delivery window: Front Desk reschedules before planning without creating a collection', async () => {
  const f = await rental();
  const input = frontdeskCommand('delivery-time',actor,{contractId:f.contractId,serviceLineId:f.line.serviceLineId,
    expectedRevision:f.line.revision,deliveryWindow:{startAt:'2037-08-05T13:00:00Z',endAt:'2037-08-05T15:00:00Z'}});
  await frontdesk.rescheduleFrontdeskDelivery(input);
  assert.equal((await frontdesk.getFrontdeskContractTimeline({actor,contractId:f.contractId})).visits[0].scheduledStartAt,'2037-08-05T13:00:00.000Z');
  assert.equal((await collections(f)).length,0);
  assert.equal((await frontdesk.rescheduleFrontdeskDelivery(input)).replayed,true);
  await assert.rejects(frontdesk.rescheduleFrontdeskDelivery({...input,idempotencyKey:crypto.randomUUID()}),{code:'MBT_STALE_REVISION'});
});

test('delivery window: a delivery at or after its due date is rejected atomically',async()=>{
  const f=await rental();
  const before=await frontdesk.getFrontdeskContractTimeline({actor,contractId:f.contractId});
  await assert.rejects(frontdesk.rescheduleFrontdeskDelivery(frontdeskCommand('invalid-delivery',actor,{
    contractId:f.contractId,serviceLineId:f.line.serviceLineId,expectedRevision:f.line.revision,
    deliveryWindow:{startAt:f.proposedReturnAt,endAt:'2037-09-01T16:00:00Z'}})),{code:'MBT_FRONTDESK_INPUT_INVALID'});
  assert.deepEqual(await frontdesk.getFrontdeskContractTimeline({actor,contractId:f.contractId}),before);
});

test('collection request: legacy accepted quotes convert to delivery only and failed conversion rolls back',async()=>{
  const f=await createFrontdeskPrerequisites({label:`legacy-${crypto.randomUUID()}`});
  const created=await frontdesk.createFrontdeskQuote(quoteCommand(f,{actor,identity:crypto.randomUUID()}),
    {resolveDistance:frontdeskDistanceResolver(f),resolveTaxPolicy:frontdeskTaxResolver});
  const quoteId=created.body.quote.quoteId;
  await frontdesk.issueFrontdeskQuote(frontdeskCommand('issue-legacy',actor,{quoteId,expectedRevision:1,validUntil:'2037-08-04T12:00:00Z'}));
  await frontdesk.acceptFrontdeskQuote(frontdeskCommand('accept-legacy',actor,{quoteId,expectedRevision:2,acceptedAt:'2037-08-03T10:00:00Z'}));
  await query("UPDATE mbt_quotes SET pricing_snapshot=pricing_snapshot-'serviceLines' WHERE quote_id=$1",[quoteId]);
  const input=frontdeskCommand('convert-legacy',actor,{quoteId,expectedRevision:3});
  await assert.rejects(frontdesk.convertFrontdeskQuote(input,{afterVisitsInsert:()=>{throw new Error('legacy conversion rollback');}}),/legacy conversion rollback/);
  assert.equal((await query('SELECT count(*)::int AS n FROM mbt_contracts WHERE quote_id=$1',[quoteId])).rows[0].n,0);
  const result=await frontdesk.convertFrontdeskQuote(input);
  assert.deepEqual(result.body.visits.map(v=>v.serviceAction),['delivery']);
  assert.equal(result.body.serviceLines[0].plannedReturnAt,f.proposedReturnAt);
});

async function priceChange(f, content, size=14, paymentMethod='cash') {
  const current=await frontdesk.getFrontdeskContractTimeline({actor,contractId:f.contractId});
  const input=frontdeskCommand('reprice',actor,{kind:'change_bin',contractId:f.contractId,serviceLineId:f.line.serviceLineId,
    expectedContractRevision:current.contract.revision,expectedServiceLineRevision:current.serviceLines[0].revision,
    rateCardVersionId:f.rateCardVersionId,paymentMethod,billingAddressText:'100 Billing Road',serviceAddressText:'200 Site Road',
    contractTelephone:'4165550123',distanceMetres:12500,bin:{incomingContentCode:content,incomingBinSizeYards:size,
      incomingBinTypeId:`00000000-0000-4000-8000-${String(size).padStart(12,'0')}`,binItemCode:`${size}YD`,deliveryItemCode:f.deliveryItemCode,
      discountMinor:0,proposedDeliveryAt:f.proposedDeliveryAt,proposedReturnAt:f.proposedReturnAt}});
  return previewFrontdeskChargeRequest(input);
}
async function confirmChange(preview) {
  return confirmFrontdeskChargeRequest(frontdeskCommand('confirm-change',actor,{chargeRequestId:preview.body.request.chargeRequestId,expectedRevision:1}));
}

for (const paymentMethod of ['cash','card']) test(`price change: garbage to soil adds fixed charge, reverse creates credit (${paymentMethod})`, async () => {
  const f=await rental(false,'garbage',paymentMethod);
  const before=(await query('SELECT pricing_snapshot FROM mbt_frontdesk_charge_requests WHERE source_quote_id=$1',[f.contract.quoteId])).rows;
  const added=await priceChange(f,'soil',14,paymentMethod);
  const delta=paymentMethod==='cash' ? 30000 : 33900;
  assert.equal(added.body.request.newRequestChargeableMinor,delta);
  await confirmChange(added);
  const current=await frontdesk.getFrontdeskContractTimeline({actor,contractId:f.contractId});
  assert.equal(current.serviceLines[0].pricing.contentCode,'soil');
  assert.equal(current.visits.filter(v=>!v.parentOrderId).length,1);
  const credit=await priceChange(f,'garbage',14,paymentMethod);
  assert.equal(credit.body.request.newRequestChargeableMinor,-delta);
  const confirmed=await confirmChange(credit);
  assert.equal(confirmed.body.request.resultingContractTotalMinor,f.contract.pricing.totalMinor);
  assert.deepEqual((await query("SELECT pricing_snapshot FROM mbt_frontdesk_charge_requests WHERE source_quote_id=$1 AND request_kind='initial_bin'",[f.contract.quoteId])).rows,before);
});

test('price change: soil, concrete and asphalt stay equal; size changes reprice only the difference',async()=>{
  const f=await rental(false,'soil');
  for(const material of ['concrete','asphalt']) {const preview=await priceChange(f,material);assert.equal(preview.body.request.newRequestChargeableMinor,0);await confirmChange(preview);}
  const g=await rental(false,'garbage');
  const larger=await priceChange(g,'garbage',20);assert.equal(larger.body.request.revisedBinTotalMinor,40000);
  assert.equal(larger.body.request.newRequestChargeableMinor,40000-47500);
  await confirmChange(larger);
  const timeline=await frontdesk.getFrontdeskContractTimeline({actor,contractId:g.contractId});
  assert.equal(timeline.serviceLines[0].binTypeCode,'20YD');
  assert.equal(timeline.visits[0].visitId,g.visits[0].visitId);
});

test('automatic C repair: guarded, reversible, replayable and retains due date and audit history',async()=>{
  const f=await rental();
  const converted={body:{contract:f.contract,visits:f.visits}};
  const orderId=await addLegacyCollection(converted,actor);
  const order=(await collections(f))[0];
  const input={actor:{operatorId:'test-repair',roles:['admin']},idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),orderId,reference:order.display_reference};
  await withTransaction(async()=>{await withdrawAutomaticCollection(input);assert.equal((await collections(f)).length,0);},{rollback:true});
  assert.equal((await collections(f)).length,1);
  await withdrawAutomaticCollection(input);
  assert.equal((await withdrawAutomaticCollection(input)).replayed,true);
  const timeline=await frontdesk.getFrontdeskContractTimeline({actor,contractId:f.contractId});
  assert.equal(timeline.visits.length,1);assert.equal(timeline.serviceLines[0].plannedReturnAt,f.line.plannedReturnAt);
  assert.equal((await query('SELECT status FROM mbt_service_visits WHERE service_visit_id=$1',[orderId])).rows[0].status,'cancelled');
  await delivered(f);const c=await frontdesk.collectFrontdeskServiceLine(collect(f));
  assert.notEqual(c.body.collectionVisit.visitId,orderId);assert.equal((await collections(f))[0].display_reference,order.display_reference);
  await assert.rejects(withdrawAutomaticCollection({...input,orderId:c.body.collectionVisit.visitId,idempotencyKey:crypto.randomUUID()}),/untouched automatic/);
});

test('price change: resizing clears a prepared incompatible bin, retaining the D identity',async()=>{
  const f=await rental(false,'garbage'),planner=await planningFixture(4950);
  const configured=await configureBinOrderWorkflow({visitId:f.visits[0].visitId,expectedRevision:1,actor:planner.actor,
    idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),deliveryAssetId:planner.assetId,
    deliveryWindow:{startAt:f.proposedDeliveryAt,endAt:'2037-08-03T16:00:00Z'}});
  await confirmChange(await priceChange(f,'garbage',20));
  const order=(await query('SELECT * FROM mbt_bin_orders WHERE order_id=$1',[f.visits[0].visitId])).rows[0];
  assert.equal(order.configuration,null);
  assert.equal((await query('SELECT count(*)::int AS n FROM mbt_bin_order_parts WHERE order_id=$1',[f.visits[0].visitId])).rows[0].n,0);
  assert.equal((await query('SELECT status FROM mbt_service_visits WHERE service_visit_id=$1',[configured.body.parts[0].visitId])).rows[0].status,'cancelled');
  assert.equal((await frontdesk.getFrontdeskContractTimeline({actor,contractId:f.contractId})).visits.filter(v=>!v.parentOrderId).length,1);
});

test('price change: competing confirmations cannot charge twice or overwrite the winner',async()=>{
  const f=await rental(false,'garbage'),a=await priceChange(f,'soil'),b=await priceChange(f,'asphalt');
  const outcomes=await Promise.allSettled([confirmChange(a),confirmChange(b)]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_frontdesk_charge_requests WHERE contract_id=$1 AND request_kind='change_bin' AND status='confirmed'",[f.contractId])).rows[0].n,1);
});
