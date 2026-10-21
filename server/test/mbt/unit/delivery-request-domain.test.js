import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeliveryPricing, normalizeDeliveryWindow, calculateDeliveryQuote, transitionDeliveryRequest,
  assertDeliveryYard, normalizeDeliveryCapacities, normalizeDeliverySettings, normalizeSalesOrderReferences,
  deliveryApprovalDue,calculateConsolidatedDeliveryQuote } from '../../../src/delivery-request-domain.js';
import { sales, colleague, dispatcher, pricing, window, graph, request, clock } from '../support/delivery-request-fixtures.js';

const securedRequest=()=>request({status:'confirmed',salesOrderRefs:['SO123','SO124'],securedAt:clock.now,
  confirmedWindow:window({start:'08:00',end:'09:00'})});
test('time change: requesting and replacing a slot preserves the secured legacy window, links, quote and stopped clock',()=>{
  const row=securedRequest(),pending=window({date:'2028-10-12',start:'13:00',end:'15:00'});
  const next=transitionDeliveryRequest(row,'request-time-change',{expectedRevision:1,window:pending},sales,'sales',clock);
  assert.deepEqual(next,{...row,revision:2,pendingWindow:{...pending,timeZone:'America/Toronto'}});
  assert.equal(deliveryApprovalDue(next,'2099-01-01T00:00:00Z'),null);
  const replaced=transitionDeliveryRequest(next,'request-time-change',{expectedRevision:2,window:window()},colleague,'sales',clock);
  assert.deepEqual(replaced.confirmedWindow,row.confirmedWindow);assert.equal(replaced.pendingWindow.start,'09:00');
  assert.equal(row.pendingWindow,undefined);
});
test('time change: only acceptance replaces the approved slot; decline and withdrawal preserve it',()=>{
  const row={...securedRequest(),pendingWindow:window({start:'13:00',end:'15:00'})};
  const accepted=transitionDeliveryRequest(row,'accept-time-change',{expectedRevision:1},dispatcher,'dispatch',clock);
  assert.deepEqual(accepted,{...row,revision:2,pendingWindow:null,confirmedWindow:{...row.pendingWindow,timeZone:'America/Toronto'}});
  for(const [action,actor,audience] of [['decline-time-change',dispatcher,'dispatch'],['withdraw-time-change',sales,'sales']]) {
    assert.deepEqual(transitionDeliveryRequest(row,action,{expectedRevision:1},actor,audience,clock),{...row,revision:2,pendingWindow:null});
  }
});
test('time change: invalid new windows, wrong state, wrong team, stale and absent proposals are rejected',()=>{
  const row=securedRequest(),input={expectedRevision:1,window:window()};
  for(const bad of [window({end:'10:59'}),window({start:'25:00'}),window({date:'2028-02-30'}),null]) {
    assert.throws(()=>transitionDeliveryRequest(row,'request-time-change',{...input,window:bad},sales,'sales',clock),{code:'DELIVERY_REQUEST_INVALID'});
  }
  for(const action of ['accept-time-change','decline-time-change','withdraw-time-change']) {
    const audience=action==='withdraw-time-change'?'sales':'dispatch',actor=audience==='sales'?sales:dispatcher;
    assert.throws(()=>transitionDeliveryRequest(row,action,input,actor,audience,clock),{code:'DELIVERY_STATE_CONFLICT'});
  }
  for(const status of ['submitted','proposed','preapproved','expired','cancelled']) {
    assert.throws(()=>transitionDeliveryRequest({...row,status},'request-time-change',input,sales,'sales',clock),{code:'DELIVERY_STATE_CONFLICT'});
  }
  for(const action of ['request-time-change','withdraw-time-change']) {
    assert.throws(()=>transitionDeliveryRequest(row,action,input,dispatcher,'dispatch',clock),{status:403});
  }
  for(const action of ['accept-time-change','decline-time-change']) {
    assert.throws(()=>transitionDeliveryRequest({...row,pendingWindow:window()},action,input,sales,'sales',clock),{status:403});
  }
  assert.throws(()=>transitionDeliveryRequest(row,'request-time-change',{...input,expectedRevision:0},sales,'sales',clock),{code:'DELIVERY_STALE_REVISION'});
});
test('time change: cancellation releases all SOs and pending time without erasing the approved time history',()=>{
  const row={...securedRequest(),pendingWindow:window()};
  const cancelled=transitionDeliveryRequest(row,'cancel',{expectedRevision:1},sales,'sales',clock);
  assert.deepEqual(cancelled,{...row,status:'cancelled',revision:2,salesOrderRefs:[],pendingWindow:null});
  assert.deepEqual(row.salesOrderRefs,['SO123','SO124']);
});

test('linkage: Sales can replace confirmed links while retaining a legacy approved slot and stopped clock',()=>{
  const row=request({status:'confirmed',revision:4,salesOrderRefs:['SO123','SO124'],
    confirmedWindow:window({start:'08:00',end:'09:00'}),securedAt:clock.now});
  const result=transitionDeliveryRequest(row,'relink',{expectedRevision:4,salesOrderRefs:[' so125 ','SO125']},sales,'sales',clock);
  assert.deepEqual(result,{...row,revision:5,salesOrderRefs:['SO125']});
  assert.deepEqual(row.salesOrderRefs,['SO123','SO124']);
});
test('linkage: empty, malformed, over-limit, wrong-state and unauthorized changes fail closed',()=>{
  const row=request({status:'confirmed',salesOrderRefs:['SO123']});
  for(const refs of [[],[''],['PO123'],null,Array(51).fill('SO123')]) {
    assert.throws(()=>transitionDeliveryRequest(row,'relink',{expectedRevision:1,salesOrderRefs:refs},sales,'sales',clock),{code:'DELIVERY_REQUEST_INVALID'});
  }
  for(const status of ['submitted','preapproved','proposed','expired','cancelled']) {
    assert.throws(()=>transitionDeliveryRequest({...row,status},'relink',{expectedRevision:1,salesOrderRefs:['SO124']},sales,'sales',clock),{code:'DELIVERY_STATE_CONFLICT'});
  }
  for(const [actor,audience] of [[dispatcher,'dispatch'],[{...sales,publicSales:true},'sales'],[{...sales,yardLocationIds:[28]},'sales']]) {
    assert.throws(()=>transitionDeliveryRequest(row,'relink',{expectedRevision:1,salesOrderRefs:['SO124']},actor,audience,clock),{status:403});
  }
});

test('optional customer and distinct requesting/pricing yards are retained', () => {
  assert.deepEqual(normalizeDeliveryPricing(pricing({ requestingYardLocationId: 15 })), pricing({ requestingYardLocationId: 15 }));
  assert.equal(assertDeliveryYard(sales, 15, 'sales'), 15);
  assert.equal(assertDeliveryYard(dispatcher, 26, 'dispatch'), 26);
  assert.equal(normalizeDeliveryWindow(window()).timeZone, 'America/Toronto');
});
for (const [count, trips] of [[1, 1], [26, 1], [27, 2], [52, 2], [53, 3]]) {
  test(`${count} POS quotes ${trips} trip(s) at the MBBS transport rate`, () => {
    const quote = calculateDeliveryQuote(pricing({ totalUnits: count }), graph(), 20000, { pos: 26, bin: 1 });
    assert.equal(quote.trips, trips);
    assert.equal(quote.unitAmountMinor, 23500);
    assert.equal(quote.totalAmountMinor, 23500 * trips);
    assert.equal(quote.capacityPerTrip, 26);
    assert.equal(quote.rateCardVersionId, graph().rateCardVersionId);
  });
}
test('3 BIN use the separate MBT 14YD transport rate, without rental or disposal', () => {
  const quote = calculateDeliveryQuote(pricing({ loadType: 'bin', totalUnits: 3, binTypeCode: '14YD' }), graph('bin'), 20000, { pos: 26, bin: 1 });
  assert.equal(quote.trips, 3);
  assert.equal(quote.unitAmountMinor, 10000);
  assert.equal(quote.totalAmountMinor, 30000);
  assert.equal(quote.currency, 'CAD');
});
test('quote evidence retains the rate calculator explanation for each priced leg',()=>{
  const quote=calculateDeliveryQuote(pricing(),graph(),80000,{pos:26,bin:1});
  assert.ok(quote.outbounds[0].explanation);
  assert.equal(quote.outbounds[0].explanation.rawDistanceMetres,80000);
});
for (const [metres, pos, bin] of [[30000,23500,10000],[30001,28500,15000],[50000,28500,15000],
  [50001,33500,20000],[65000,33500,20000],[65001,38500,25000],[75000,38500,25000],
  [75001,38501,52501],[80000,42000,56000]]) {
  test(`raw ${metres} metre boundary preserves both cards' rules`, () => {
    for (const [type, expected] of [['pos', pos], ['bin', bin]]) {
      const quote = calculateDeliveryQuote(pricing({ loadType: type, totalUnits: 1, binTypeCode: type === 'bin' ? '14YD' : null }), graph(type), metres, { pos: 26, bin: 1 });
      assert.equal(quote.totalAmountMinor, expected);
    }
  });
}
test('editable capacity rounds trips up and never silently substitutes an invalid value', () => {
  assert.deepEqual(normalizeDeliveryCapacities({ pos: 20, bin: 2 }), { pos: 20, bin: 2 });
  assert.equal(calculateDeliveryQuote(pricing(), graph(), 20000, { pos: 20, bin: 1 }).trips, 2);
  for (const pos of [0, -1, 1.5, '26', Infinity]) {
    assert.throws(() => normalizeDeliveryCapacities({ pos, bin: 1 }), { code: 'DELIVERY_REQUEST_INVALID' });
  }
});
test('invalid quantity, origin, BIN size, currency and unsafe multiplication fail closed', () => {
  for (const totalUnits of [0, -1, 1.2, NaN, Infinity, '27', 1000000001]) {
    assert.throws(() => normalizeDeliveryPricing(pricing({ totalUnits })), { code: 'DELIVERY_REQUEST_INVALID' });
  }
  assert.throws(()=>normalizeDeliveryPricing(pricing({originYardCode:'9999'})),{code:'DELIVERY_REQUEST_INVALID'});
  for (const input of [pricing({ loadType: 'bin', binTypeCode: '40YD' })]) {
    assert.throws(() => calculateDeliveryQuote(input, graph(input.loadType), 20000, { pos: 26, bin: 1 }), { code: 'DELIVERY_QUOTE_UNAVAILABLE' });
  }
  assert.throws(() => calculateDeliveryQuote(pricing(), { ...graph(), currency: 'USD' }, 20000, { pos: 26, bin: 1 }));
  const expensive = graph(); expensive.bands = expensive.bands.map(b => ({ ...b, amountMinor: Number.MAX_SAFE_INTEGER }));
  assert.throws(() => calculateDeliveryQuote(pricing(), expensive, 20000, { pos: 26, bin: 1 }), { code: 'DELIVERY_QUOTE_OVERFLOW' });
});
test('invalid provider distance and calculator overflow fail with delivery-specific error codes',()=>{
  assert.throws(()=>calculateDeliveryQuote(pricing(),graph(),-1,{pos:26,bin:1}),{code:'DELIVERY_QUOTE_UNAVAILABLE'});
  const overflow=graph();overflow.bands.at(-1).amountMinor=Number.MAX_SAFE_INTEGER;
  assert.throws(()=>calculateDeliveryQuote(pricing({totalUnits:1}),overflow,1000000,{pos:26,bin:1}),{code:'DELIVERY_QUOTE_OVERFLOW'});
});
test('Sales may edit a submitted request while keeping the reference and requiring a fresh revision',()=>{
  const row=request(),edited=transitionDeliveryRequest(row,'edit',{expectedRevision:1},colleague,'sales',clock);
  assert.equal(edited.id,row.id);assert.equal(edited.revision,2);assert.equal(edited.status,'submitted');
  assert.equal(edited.approvalExpiresAt,null);assert.deepEqual(edited.quote,row.quote);
});
test('the same standard transport card prices all configured consolidation yards', () => {
  for (const originYardCode of ['3445','2967','12441','150']) {
    const result=calculateDeliveryQuote(pricing({originYardCode,totalUnits:1}),graph(),20000,{pos:26,bin:1});
    assert.equal(result.totalAmountMinor,23500);assert.equal(result.outbounds[0].originYardCode,originYardCode);
  }
});
test('private same-yard access excludes wrong yards, public users and inappropriate audiences', () => {
  for (const actor of [{ ...sales, yardLocationIds: [28] }, { ...sales, publicSales: true }, { id: 'scm', role: 'scm' }]) {
    assert.throws(() => assertDeliveryYard(actor, 1, 'sales'), { status: 403 });
  }
  assert.throws(() => assertDeliveryYard(sales, 1, 'dispatch'), { status: 403 });
  assert.throws(() => assertDeliveryYard(dispatcher, 1, 'sales'), { status: 403 });
});
test('windows reject invalid dates, inverted ranges and ambiguous wire shapes', () => {
  for (const input of [window({ date: '2027-02-29' }), window({ start: '12:00' }), window({ end: '08:00' }),
    window({ start: '24:00' }), window({ timeZone: 'UTC' })]) {
    assert.throws(() => normalizeDeliveryWindow(input), { code: 'DELIVERY_REQUEST_INVALID' });
  }
});
test('updates: delivery windows require at least 120 minutes, including late-day boundaries', () => {
  for (const [start,end] of [['09:00','09:01'],['09:00','10:59'],['22:00','23:59']]) {
    assert.throws(() => normalizeDeliveryWindow(window({start,end})), {code:'DELIVERY_REQUEST_INVALID',message:/at least 2 hours/});
  }
  for (const [start,end] of [['09:00','11:00'],['09:00','11:01'],['21:59','23:59']]) {
    assert.equal(normalizeDeliveryWindow(window({start,end})).end,end);
  }
});
test('updates: proposals, counters and approval of old short windows enforce the same minimum', () => {
  const short=window({start:'09:00',end:'10:59'}),input={expectedRevision:1,window:short};
  for (const [row,action,actor,audience] of [
    [request(),'propose',dispatcher,'dispatch'],
    [request({status:'preapproved'}),'counter',sales,'sales'],
    [request({requestedWindow:short}),'confirm',dispatcher,'dispatch'],
    [request({status:'proposed',proposedWindow:short}),'accept',sales,'sales']
  ]) {
    assert.throws(() => transitionDeliveryRequest(row,action,input,actor,audience,clock),{code:'DELIVERY_REQUEST_INVALID',message:/at least 2 hours/});
  }
});
test('Dispatch OK preapproves for 3 hours with a reminder 1 hour before expiry', () => {
  const row = request();
  const result = transitionDeliveryRequest(row, 'confirm', { expectedRevision: 1 }, dispatcher, 'dispatch', clock);
  assert.equal(result.status, 'preapproved'); assert.deepEqual(result.confirmedWindow, {...row.requestedWindow,timeZone:'America/Toronto'});
  assert.equal(result.approvalExpiresAt, '2028-10-01T15:00:00.000Z');
  assert.equal(result.reminderAt, '2028-10-01T14:00:00.000Z');
  assert.deepEqual(result.quote, row.quote); assert.equal(result.revision, 2); assert.equal(row.revision, 1);
});
test('propose, counter and accept retain independent windows, shared Sales rights and quote history', () => {
  const proposedWindow = window({ date: '2028-10-11', start: '13:00', end: '15:00' });
  const proposed = transitionDeliveryRequest(request(), 'propose', { expectedRevision: 1, window: proposedWindow }, dispatcher, 'dispatch', clock);
  assert.equal(proposed.status, 'proposed'); assert.equal(proposed.requestedWindow.date, '2028-10-10');
  const accepted = transitionDeliveryRequest(proposed, 'accept', { expectedRevision: 2 }, colleague, 'sales', { ...clock, now: '2028-10-01T13:00:00.000Z' });
  assert.equal(accepted.status, 'preapproved'); assert.equal(accepted.confirmedWindow.date, '2028-10-11');
  assert.equal(accepted.approvalExpiresAt, proposed.approvalExpiresAt);
  const counter = transitionDeliveryRequest(proposed, 'counter', { expectedRevision: 2, window: window({ start: '10:00' }) }, colleague, 'sales');
  assert.equal(counter.status, 'submitted'); assert.equal(counter.proposedWindow, null);
  assert.deepEqual(counter.quote, proposed.quote);
});
test('3445 and 2967 share one billing yard and combine quantities before rounding trips', () => {
  const input = pricing({ outbounds: [{ originYardCode: '3445', totalUnits: 27 }, { originYardCode: '2967', totalUnits: 1 }] });
  const result = calculateDeliveryQuote(input, graph(), 20000, { pos: 26, bin: 1 });
  assert.equal(result.trips, 2); assert.equal(result.totalAmountMinor, 47000);
  assert.equal(result.outbounds.length,1); assert.equal(result.outbounds[0].totalUnits,28);
  assert.deepEqual(result.outbounds[0].sourceYardCodes,['3445','2967']);
  for (const outbounds of [[], [{ originYardCode: '3445', totalUnits: 1 }, { originYardCode: '3445', totalUnits: 2 }],
    [{ originYardCode: '3445', totalUnits: 1, loadType: 'bin' }]]) {
    assert.throws(() => normalizeDeliveryPricing(pricing({ outbounds })), { code: 'DELIVERY_REQUEST_INVALID' });
  }
});
test('changing the pricing origin changes distance evidence but never adds a second yard fee', () => {
  const input = pricing({ outbounds:[{originYardCode:'3445',totalUnits:1},{originYardCode:'2967',totalUnits:1}],pricingOriginYardCode:'2967' });
  const result = calculateDeliveryQuote(input,graph(),50001,{pos:26,bin:1});
  assert.equal(result.trips,1); assert.equal(result.totalAmountMinor,33500);
  assert.equal(result.outbounds[0].originYardCode,'2967');
});
test('other yards transfer to one consolidation yard and apply the lowest combined charge', () => {
  const input = pricing({outbounds:[{originYardCode:'12441',totalUnits:1},{originYardCode:'3445',totalUnits:26}]});
  const routes = { '12441>3445':{providerMetres:20000},'3445>12441':{providerMetres:20000},
    '12441>customer':{providerMetres:80000},'3445>customer':{providerMetres:20000} };
  const result = calculateConsolidatedDeliveryQuote(input,graph(),routes,{pos:26,bin:1});
  assert.equal(result.consolidationYardCode,'3445');
  assert.equal(result.transferAmountMinor,23500); assert.equal(result.deliveryAmountMinor,47000);
  assert.equal(result.totalAmountMinor,70500); assert.equal(result.transferTrips,1); assert.equal(result.deliveryTrips,2);
  assert.deepEqual(result.alternatives.map(option=>option.totalAmountMinor).sort((a,b)=>a-b),[70500,107500]);
  assert.equal(result.transferLegs[0].originYardCode,'12441'); assert.equal(result.transferLegs[0].destinationYardCode,'3445');
  assert.equal(result.transferLegs[0].totalUnits,1);
  assert.throws(()=>calculateConsolidatedDeliveryQuote(input,graph(),{...routes,'12441>customer':null},{pos:26,bin:1}), {code:'DELIVERY_QUOTE_UNAVAILABLE'});
});
test('BIN consolidation uses the MBT card for both transfer and whole-order delivery',()=>{
  const input=pricing({loadType:'bin',binTypeCode:'14YD',outbounds:[{originYardCode:'12441',totalUnits:1},{originYardCode:'3445',totalUnits:2}]});
  const routes={'12441>3445':{providerMetres:20000},'3445>12441':{providerMetres:20000},
    '12441>customer':{providerMetres:80000},'3445>customer':{providerMetres:20000}};
  const result=calculateConsolidatedDeliveryQuote(input,graph('bin'),routes,{pos:26,bin:1});
  assert.equal(result.consolidationYardCode,'3445');assert.equal(result.transferAmountMinor,10000);
  assert.equal(result.deliveryAmountMinor,30000);assert.equal(result.totalAmountMinor,40000);
  assert.equal(result.transferTrips,1);assert.equal(result.deliveryTrips,3);
  assert.ok(result.outbounds.every(leg=>leg.rateCardCode==='DELIVERY_CHARGE_MBT_2026_RATE'));
});
test('three-yard consolidation moves each other billing group once and the paired yards incur no transfer fee', () => {
  const input = pricing({outbounds:[{originYardCode:'3445',totalUnits:13},{originYardCode:'2967',totalUnits:13},{originYardCode:'150',totalUnits:1}]});
  const result = calculateConsolidatedDeliveryQuote(input,graph(),{'3445>150':{providerMetres:20000},'150>3445':{providerMetres:20000},
    '3445>customer':{providerMetres:20000},'150>customer':{providerMetres:20000}},{pos:26,bin:1});
  assert.equal(result.totalAmountMinor,70500); assert.equal(result.transferLegs.length,1);
  assert.equal(result.deliveryLeg.totalUnits,27);
});
test('settings require positive capacities and a reminder strictly before expiry', () => {
  assert.deepEqual(normalizeDeliverySettings({ pos: 26, bin: 1, approvalHours: 3, reminderHours: 1 }), clock.settings);
  for (const patch of [{ approvalHours: 0 }, { approvalHours: 1, reminderHours: 1 }, { reminderHours: -1 }, { approvalHours: '3' }]) {
    assert.throws(() => normalizeDeliverySettings({ ...clock.settings, ...patch }), { code: 'DELIVERY_REQUEST_INVALID' });
  }
});
test('Sales secures approval with unique SOs before the deadline and permanently stops its clock', () => {
  const row = transitionDeliveryRequest(request(), 'confirm', { expectedRevision: 1 }, dispatcher, 'dispatch', clock);
  const secured = transitionDeliveryRequest(row, 'secure', { expectedRevision: 2, salesOrderRefs: [' SO123 ', 'so124', 'SO123'] }, sales, 'sales', { ...clock, now: '2028-10-01T14:59:59.999Z' });
  assert.equal(secured.status, 'confirmed'); assert.deepEqual(secured.salesOrderRefs, ['SO123', 'SO124']);
  assert.equal(secured.approvalExpiresAt, null); assert.equal(secured.reminderAt, null);
  assert.equal(secured.securedAt, '2028-10-01T14:59:59.999Z');
  assert.equal(deliveryApprovalDue(secured, '2030-01-01T00:00:00Z'), null);
  assert.throws(() => transitionDeliveryRequest(row, 'secure', { expectedRevision: 2, salesOrderRefs: ['SO123'] }, sales, 'sales', { ...clock, now: row.approvalExpiresAt }), { code: 'DELIVERY_APPROVAL_EXPIRED' });
  assert.throws(() => normalizeSalesOrderReferences([]), { code: 'DELIVERY_REQUEST_INVALID' });
  assert.throws(() => normalizeSalesOrderReferences(['<script>']), { code: 'DELIVERY_REQUEST_INVALID' });
});
test('reminder fires once, expiry wins at the boundary, and re-raise requires reapproval', () => {
  const row = transitionDeliveryRequest(request(), 'confirm', { expectedRevision: 1 }, dispatcher, 'dispatch', clock);
  assert.equal(deliveryApprovalDue(row, '2028-10-01T13:59:59.999Z'), null);
  assert.equal(deliveryApprovalDue(row, row.reminderAt), 'remind');
  assert.equal(deliveryApprovalDue({ ...row, reminderSentAt: row.reminderAt }, '2028-10-01T14:30:00Z'), null);
  assert.equal(deliveryApprovalDue(row, row.approvalExpiresAt), 'expire');
  const raised = transitionDeliveryRequest({ ...row, status: 'expired' }, 'reraise', { expectedRevision: 2 }, sales, 'sales', clock);
  assert.equal(raised.id, row.id); assert.equal(raised.status, 'submitted'); assert.equal(raised.approvalExpiresAt, null);
  assert.throws(() => transitionDeliveryRequest(raised, 'secure', { expectedRevision: 3, salesOrderRefs: ['SO123'] }, sales, 'sales', clock), { code: 'DELIVERY_STATE_CONFLICT' });
});
test('state and revision guards prevent stale replies, unauthorized replies and confirmed edits', () => {
  assert.throws(() => transitionDeliveryRequest(request(), 'confirm', { expectedRevision: 2 }, dispatcher, 'dispatch'), { code: 'DELIVERY_STALE_REVISION' });
  assert.throws(() => transitionDeliveryRequest(request(), 'confirm', { expectedRevision: 1 }, sales, 'sales'), { status: 403 });
  assert.throws(() => transitionDeliveryRequest(request(), 'accept', { expectedRevision: 1 }, sales, 'sales'), { code: 'DELIVERY_STATE_CONFLICT' });
  assert.throws(() => transitionDeliveryRequest(request({ status: 'confirmed' }), 'edit', { expectedRevision: 1 }, colleague, 'sales'), { code: 'DELIVERY_STATE_CONFLICT' });
  assert.equal(transitionDeliveryRequest(request({ status: 'confirmed' }), 'cancel', { expectedRevision: 1 }, colleague, 'sales').status, 'cancelled');
});
