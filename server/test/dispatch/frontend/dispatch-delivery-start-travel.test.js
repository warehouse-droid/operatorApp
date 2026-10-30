import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { buildDispatchForecast, dispatchTorontoMinuteIso } from '../../../src/dispatch-forecast-service.js';
import { planJobsForDriver } from '../../../src/driver-repository.js';

const source = readFileSync(new URL('../../../public/dispatch.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.slice(start + 1).search(/\n(?:async )?function /);
  assert.ok(start >= 0 && end > 0, name);
  return source.slice(start, start + end + 1);
}
const at = minute => dispatchTorontoMinuteIso('2026-10-22', minute);

function fixture() {
  const orders = [
    { id: 'GOA-9886-9887', type: 'SO', address: '143 Previous Customer Road, Richmond Hill, ON', sourceYard: '2967', pickupLocations: ['2967'], items: [] },
    ...['SOB122739', 'SOB122740'].map((id, index) => ({ id, type: 'SO',
      address: `${27 + index} Next Customer Road, Markham, ON`, sourceYard: '3445', pickupLocations: ['3445'],
      items: [{ sku: 'Delivery Charge', itemType: 'OthCharge', quantity: 1 }] }))
  ];
  const previous = { id: 'load-3', driverLogin: 'li', driverSequence: 0, timing: { start: 800, finish: 900 }, stops: [
    { id: 'p3', orderId: orders[0].id, type: 'pick', location: '2967', timing: { arrival: 800, depart: 830 } },
    { id: 'd3', orderId: orders[0].id, type: 'drop', location: '2967', timing: { arrival: 890, depart: 900 } }
  ] };
  const load = { id: 'load-4', driverLogin: 'li', driverSequence: 1, timing: { start: 900, finish: 990 }, stops: [
    { id: 'd4', orderId: orders[1].id, type: 'drop', location: '3445', timing: { arrival: 930, depart: 940 } },
    { id: 'd5', orderId: orders[2].id, type: 'drop', location: '3445', timing: { arrival: 980, depart: 990 } }
  ] };
  const truck = { id: 'T5', plate: 'TRUCK-1', driverLogin: 'li', driver: 'Li', base: '3445',
    ownYardFixedMinutes: 30, deliveryFixedMinutes: 10, minutesPerPallet: 0, loads: [previous, load] };
  const plan = { id: 999, revision: 1, planDate: '2026-10-22', orders, trucks: [truck] };
  const records = [
    { load_id: previous.id, stop_id: 'd3', stop_type: 'dropoff', driver_login: 'li', status: 'complete', actual_arrival_at: at(890), started_at: at(880), completed_at: at(900) },
    { load_id: load.id, stop_id: 'd4', stop_type: 'dropoff', driver_login: 'li', status: 'complete', actual_arrival_at: at(928), started_at: at(900), completed_at: at(938) },
    { load_id: load.id, stop_id: 'd5', stop_type: 'dropoff', driver_login: 'li', status: 'complete', actual_arrival_at: at(978), started_at: at(938), completed_at: at(988) }
  ];
  return { plan, orders, previous, load, truck, records };
}

function browser(data, { driverMode = true } = {}) {
  const { plan, load, truck, previous, orders } = data;
  const orderFor = stop => orders.find(order => order.id === stop?.orderId);
  const placeFor = (stop, order) => ({ key: stop.type === 'pick' ? stop.location : order.id,
    label: stop.type === 'pick' ? stop.location : order.id,
    address: stop.type === 'pick' ? `${stop.location} Yard Road` : order.address,
    routeLocation: stop.type === 'pick' ? `${stop.location} Yard Road` : order.address, lat: 43, lng: -79 });
  const state = { forecast: null, loadingCalls: 0, timing: [] };
  const c = vm.createContext({
    HUBS: {}, MAP_CENTER: { lat: 43, lng: -79 },
    isMbtPlanningLoad: () => false, effectiveTruckForLoad: value => value,
    driverOrientedPlanningEnabled: () => driverMode,
    previousDriverLoad: () => truck.loads.indexOf(load) > 0 ? { truck, load: previous } : null,
    loadIndexInTruck: (_truck, target) => truck.loads.indexOf(target),
    loadTruckPlate: value => value.plate, loadSwitchYard: () => truck.base,
    stopOrder: orderFor, resolveStopPlace: placeFor,
    pickupStopLabel: (stop, order) => placeFor(stop, order).label,
    dropStopLabel: (_stop, order) => order.id,
    placeForLocation: location => ({ key: location, label: location, address: `${location} Yard Road`, kind: 'own', lat: 43, lng: -79 }),
    placePosition: place => ({ lat: place.lat, lng: place.lng }), hubPosition: () => ({ lat: 43, lng: -79 }),
    hubAddress: location => `${location} Yard Road`,
    samePhysicalAddress: (left, right) => String(left).toLowerCase() === String(right).toLowerCase(),
    yardTravelMinutes: () => 30,
    loadStartInfo: () => ({ start: 900 }), isPlanningLoadReadOnly: () => false,
    routeLegMinutesForLoad: () => [30, 40], adjustedTravelMinutesForTruck: (_truck, value) => value,
    sequenceWarningsForStops: () => [], uniquePickupLocations: () => ['3445'],
    orderRequiresPickupLocation: () => false,
    truckStopMinutes: () => { state.loadingCalls += 1; return 30; },
    isOwnYardCode: () => true, pickupFootprintForLocation: () => 0, orderWeightLbs: () => 0,
    physicalVisitsForLoad: target => target.stops.map((stop, index) => ({ type: stop.type,
      address: orderFor(stop).address, entries: [{ stop, order: orderFor(stop), index }] })),
    physicalVisitOverrideState: () => ({}), physicalVisitStayMinutes: () => 10,
    fallbackTravelMinutesBetweenStops: () => 40, requiredPickupLocations: () => [],
    dropFootprintPallets: () => 0, dropWeightLbs: () => 0, dropPallets: () => 0,
    stopTimeWindow: () => ({}), truckCapacityLbs: () => 50000,
    findLoad: () => ({ truck, load }), switchApproachTravelForLoad: () => null,
    driverRecordForTravel: () => null, travelExecutionStatus: () => 'pending',
    forecastTravelRecordForKind: (_load, kind) => state.forecast?.travelLegs.find(leg => leg.loadId === load.id && leg.kind === kind),
    routePendingForLoad: () => false, escapeHtml: value => String(value ?? ''),
    timingSummaryHtml: value => { state.timing.push(value); return ''; },
    recordStartedAt: () => '', recordCompletedAt: () => ''
  });
  for (const name of ['lastRoutedStop', 'startPointAfterLoad', 'travelMinutesBetweenPoints', 'startTravelForLoad',
    'loadStats', 'mapStopsForLoad', 'renderStartTravelStop', 'renderPreviewStartTravelStop']) {
    vm.runInContext(fn(name), c);
  }
  return { c, state };
}

test('Li Load 4: opening travel runs from previous delivery to first delivery without a pickup', () => {
  const data = fixture();
  const { c } = browser(data);
  const travel = c.startTravelForLoad(data.truck, data.load);
  assert.ok(travel, 'Opening delivery travel must exist');
  assert.equal(travel.from, 'GOA-9886-9887');
  assert.equal(travel.to, 'SOB122739');
  assert.equal(travel.address, data.orders[0].address);
  assert.deepEqual(data.load.stops.map(stop => stop.type), ['drop', 'drop']);
});

test('opening travel also works in legacy truck lanes and on the first load from base', () => {
  for (const driverMode of [true, false]) {
    const data = fixture();
    const { c } = browser(data, { driverMode });
    assert.equal(c.startTravelForLoad(data.truck, data.load)?.from, 'GOA-9886-9887');
    data.truck.loads = [data.load];
    assert.equal(c.startTravelForLoad(data.truck, data.load)?.from, '3445');
  }
});

test('route map includes the previous destination before the first delivery', () => {
  const data = fixture();
  const { c } = browser(data);
  const stops = c.mapStopsForLoad(data.load, data.truck);
  assert.equal(stops.length, 3);
  assert.equal(stops[0].address, data.orders[0].address);
  assert.equal(stops[1].orderId, 'SOB122739');
});

test('fee-only delivery timing counts initial travel once and adds no phantom loading time', () => {
  const data = fixture();
  const { c, state } = browser(data);
  const stats = c.loadStats(data.truck, data.load);
  assert.ok(stats.startTravel);
  assert.equal(state.loadingCalls, 0);
  assert.equal(stats.rows[0].arrival, 930);
  assert.equal(stats.rows[0].depart, 940);
  assert.equal(stats.rows[1].arrival, 980);
  assert.equal(stats.finish, 990);
});

test('forecast exposes the completed opening journey from recorded stop arrivals, without creating Driver tasks', () => {
  const data = fixture();
  const before = structuredClone(data);
  const forecast = buildDispatchForecast(data.plan, data.records);
  const leg = forecast.travelLegs.find(leg => leg.loadId === data.load.id && leg.kind === 'start');
  assert.ok(leg);
  assert.equal(leg.jobId, null);
  assert.equal(leg.plannedLeave, at(900));
  assert.equal(leg.plannedArrival, at(930));
  assert.equal(leg.actualLeave, at(900));
  assert.equal(leg.actualArrival, at(928));
  assert.equal(leg.status, 'complete');
  assert.equal(planJobsForDriver(data.plan, 'li').filter(job => job.loadId === data.load.id && job.stopType === 'travel').length, 0);
  assert.deepEqual(data, before);
});

for (const renderer of ['renderStartTravelStop', 'renderPreviewStartTravelStop']) {
  test(`${renderer}: completed drop-only opening travel displays its order labels and actual times`, () => {
    const data = fixture();
    const { c, state } = browser(data);
    state.forecast = buildDispatchForecast(data.plan, data.records);
    const html = c[renderer](data.truck, data.load, c.startTravelForLoad(data.truck, data.load), 900);
    assert.match(html, /GOA-9886-9887 to SOB122739/);
    assert.match(html, /status-complete/);
    assert.equal(state.timing[0].actualStart, at(900));
    assert.equal(state.timing[0].actualEnd, at(928));
  });
}

test('completed destination with unresolved arrival stays complete without inventing an arrival timestamp', () => {
  const data = fixture();
  data.records[1].actual_arrival_at = null;
  data.records[1].actual_arrival_resolution_status = 'unresolved';
  const leg = buildDispatchForecast(data.plan, data.records).travelLegs.find(leg => leg.loadId === data.load.id && leg.kind === 'start');
  assert.ok(leg);
  assert.equal(leg.status, 'complete');
  assert.equal(leg.actualArrival, null);
});

test('same-location loads do not gain a zero-distance opening journey', () => {
  const data = fixture();
  data.orders[1].address = data.orders[0].address;
  assert.equal(browser(data).c.startTravelForLoad(data.truck, data.load), null);
  assert.equal(buildDispatchForecast(data.plan, data.records).travelLegs.filter(leg => leg.loadId === data.load.id && leg.kind === 'start').length, 0);
});

test('pending drop-only loads gain forecast travel without invented actuals or pickup jobs', () => {
  const data = fixture();
  const leg = buildDispatchForecast(data.plan).travelLegs.find(leg => leg.loadId === data.load.id && leg.kind === 'start');
  assert.ok(leg);
  assert.equal(leg.status, 'pending');
  assert.equal(leg.actualArrival, null);
  assert.equal(leg.actualLeave, null);
  assert.equal(planJobsForDriver(data.plan, 'li').filter(job => job.loadId === data.load.id && job.stopType === 'pickup').length, 0);
});

test('first drop-only load uses the truck base in forecast', () => {
  const data = fixture();
  data.truck.loads = [data.load];
  data.load.driverSequence = 0;
  const leg = buildDispatchForecast(data.plan).travelLegs.find(leg => leg.loadId === data.load.id && leg.kind === 'start');
  assert.ok(leg);
  assert.equal(leg.from, '3445');
});

test('return loads remain dedicated returns and empty loads have no opening journey', () => {
  const data = fixture();
  const { c } = browser(data);
  assert.equal(c.startTravelForLoad(data.truck, { ...data.load, returnOnly: true }), null);
  assert.equal(c.startTravelForLoad(data.truck, { ...data.load, stops: [] }), null);
});

test('bin planning retains its existing initial-travel job identity', () => {
  const data = fixture();
  const { c } = browser(data);
  c.isMbtPlanningLoad = () => true;
  assert.equal(c.startTravelForLoad(data.truck, data.load)?.toPickupLocation, '3445');
});

test('delivery-start forecast uses the return yard or truck-switch yard when applicable', () => {
  for (const switched of [false, true]) {
    const data = fixture();
    if (switched) {
      data.truck.loads = [data.previous];
      data.plan.trucks.push({ ...data.truck, id: 'T6', plate: 'TRUCK-2', base: '12441', loads: [data.load] });
    } else {
      data.previous.returnOnly = true;
      data.previous.returnYard = '2967';
      data.previous.stops = [];
    }
    const leg = buildDispatchForecast(data.plan).travelLegs.find(leg => leg.loadId === data.load.id && leg.kind === 'start');
    assert.ok(leg);
    assert.equal(leg.from, switched ? '12441' : '2967');
    assert.equal(leg.actualLeave, null);
  }
});
