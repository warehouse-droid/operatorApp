import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'espree';
import fc from 'fast-check';
import { calculateCustomerCharge } from '../../../src/mbt/customer-charge-calculator.js';

function functions(file, names, values) {
  const source = readFileSync(file, 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true });
  const nodes = file.endsWith('mbt-planning.js') ? ast.body[0].expression.callee.body.body : ast.body;
  const context = vm.createContext(values);
  for (const node of nodes) {
    if (node.type === 'FunctionDeclaration' && names.includes(node.id.name)) {
      vm.runInContext(source.slice(...node.range), context);
    }
  }
  return context;
}

function chargeDialog(kind, priorContract = null) {
  const values = {
    state: { selectedCustomer: { phone: '4165550100', sites: [] }, contract: priorContract,
      configuration: { deliveryItems: [{ itemCode: 'DELIVERY_CHARGE_MBBS' }, { itemCode: 'DELIVERY_CHARGE_MBT' }] }, serviceLines: [] },
    selectableServices: () => [{ rateCardVersionId: 'rate' }], contractRateCardVersionId: () => 'rate',
    populateChargeServiceOptions() {}, loadChargeConfiguration: async () => ({}),
    populateContentAndBins() {}, localDateTimeValue: () => '2037-08-03T08:00', fullAddress: () => 'Test site',
    contractLineContent: () => 'garbage', setMessage: message => assert.fail(message),
    customerChargeForm: { reset() {} }, chargeBinFields: { querySelectorAll: () => [] },
    newContractDialog: { close() {} }, customerChargeDialog: { showModal() {} }, addAggregateRow() {},
    Option: function(label, value) { this.text = label; this.value = value; }
  };
  for (const id of ['chargeServiceCode', 'aggregateLineEditor', 'customerChargeSummary', 'confirmCustomerCharge',
    'paymentMethod', 'contractTelephone', 'serviceAddressText', 'billingAddressText', 'chargeDeliveryItemCode',
    'chargeDeliveryAt', 'chargeReturnAt', 'customerChargeReason', 'chargeWorkflowFields', 'chargeOrderFrom150',
    'customerChargeTitle', 'chargeDeliveryLabel', 'customerChargeHelp']) {
    values[id] = { value: '', replaceChildren(...items) { this.options = items; },
      options: [], append(item) { this.options.push(item); } };
  }
  return { api: functions('public/mbt-frontdesk.js', ['openCustomerChargeDialog', 'populateDeliverySelect'], values), values, kind };
}

test('new BIN pricing chooses DELIVERY_CHARGE_MBT even when MBBS sorts first or another contract was open', async () => {
  for (const prior of [null, { pricing: { deliveryItemCode: 'DELIVERY_CHARGE_MBBS' } }]) {
    const { api, values } = chargeDialog('initial_bin', prior);
    await api.openCustomerChargeDialog(null, 'initial_bin');
    assert.equal(values.chargeDeliveryItemCode.value, 'DELIVERY_CHARGE_MBT');
  }
});

test('standalone aggregate origin starts unchecked and remains selectable', async () => {
  const { api, values } = chargeDialog('aggregate_order');
  await api.openCustomerChargeDialog(null, 'aggregate_order');
  assert.equal(values.chargeOrderFrom150.checked, false);
  assert.equal(values.chargeOrderFrom150.disabled, false);
});

test('aggregate form accepts material with the standard pricing origin', () => {
  const api = functions('public/mbt-frontdesk.js', ['chargeCommonBody'], {
    requestedAggregateLines: () => [{ itemCode: 'AGG_HPB', quantityYards: '1' }],
    chargeOrderFrom150: { checked: false }, paymentMethod: { value: 'cash' },
    billingAddressText: { value: 'Billing' }, serviceAddressText: { value: 'Site' },
    contractTelephone: { value: '4165550100' }, customerChargeReason: { value: 'Customer request' }
  });
  const body = api.chargeCommonBody();
  assert.equal(body.orderFrom150, false);
  assert.equal(body.aggregateLines.length, 1);
});

test('aggregate is independent of Order from 150 for every request kind and payment method', () => {
  fc.assert(fc.property(fc.constantFrom('initial_bin', 'add_bin', 'exchange_bin', 'aggregate_order'),
    fc.constantFrom('cash', 'card', 'debit', 'e_transfer'), fc.integer({ min: 1, max: 20000 }),
    (kind, paymentMethod, quantityMilliYards) => {
      const input = { kind, paymentMethod, currentContractTotalMinor: 0, currency: 'CAD', taxRateBasisPoints: 1300,
        bin: { incomingContentCode: 'garbage', incomingBinSizeYards: 14, rentalMinor: 10000,
          transportMinor: 2500, fixedDumpMinor: 0, depositMinor: 5000, discountMinor: 0,
          outgoingContentCode: 'garbage', outgoingBinSizeYards: 14 },
        aggregateLines: [{ itemCode: 'AGG_HPB', displayName: 'HPB', quantityMilliYards,
          unitAmountMinor: 6500, densityLbsPerYard: 2600 }], loadingFeeMinor: 5000,
        distanceMetres: 12000, aggregateDistanceBands: [{ bandCode: 'AGG_0_30', minimumMetres: 0,
          maximumMetres: 30000, amountMinor: 15000 }] };
      const standard = calculateCustomerCharge({ ...input, orderFrom150: false });
      const from150 = calculateCustomerCharge({ ...input, orderFrom150: true });
      assert.equal(standard.newRequestChargeableMinor, from150.newRequestChargeableMinor);
      assert.equal(standard.orderFrom150, false);
      assert.equal(standard.lines.filter(line => line.lineCode === 'aggregate_loading_fee').length, kind === 'aggregate_order' ? 0 : 1);
    }), { seed: 20261015, numRuns: 200 });
});

test('BIN planning imports a newly registered truck with its canonical ID and preserves ordinary loads', async () => {
  const ordinary = { id: 'flatbed', plate: 'FLAT', loads: [{ id: 'ordinary', stops: [{ id: 'saved-stop' }] }] };
  const bin = { id: 'T2', plate: 'BINtest', loads: [{ id: 'bin-load', mbtPlanning: true, stops: [] }] };
  const values = { state: { request: 0, truckIds: new Set(), cards: new Map(), pool: [] },
    currentPlanDate: '2037-08-03', searchText: '', mbtBinDispatchLoading: false, mbtBinDispatchError: '',
    dispatchAuthHeaders: () => ({}), fleet: [], trucks: [ordinary, bin],
    normalizedTruckPlate: value => value.toUpperCase(), makeTruckFromFleet: (vehicle, _index, saved) => ({ ...vehicle, ...saved }),
    URLSearchParams, decoratePlan() {}, render() {},
    fetch: async () => ({ ok: true, json: async () => ({ trucks: [
      { id: '99', plate: 'BINtest', truckType: 'bin', base: '3445', binSlotCapacity: 1 },
      { id: '100', plate: 'BINnew', truckType: 'bin', base: '2967', binSlotCapacity: 1 }],
    pool: { items: [], total: 0, nextOffset: null }, assigned: [] }) }) };
  const before = JSON.stringify(ordinary);
  const api = functions('public/mbt-planning.js', ['refreshFeed', 'mergePlanningFleet'], values);
  assert.equal(await api.refreshFeed(), true);
  assert.equal(bin.id, '99');
  assert.equal(values.trucks.find(truck => truck.plate === 'BINnew')?.id, '100');
  assert.equal(values.fleet.find(truck => truck.plate === 'BINtest')?.baseYard, '3445');
  assert.equal(JSON.stringify(ordinary), before);
  assert.equal(bin.loads[0].id, 'bin-load');
});

test('BIN planning explains missing truck registration with a setup link', () => {
  const api = functions('public/mbt-planning.js', ['orderList'], {
    state: { truckIds: new Set(), nextOffset: null }, poolCards: () => [],
    mbtBinDispatchLoading: false, mbtBinDispatchError: '', escapeHtml: value => value
  });
  assert.match(api.orderList(), /BIN truck[\s\S]*href="\/dispatch\/setup"/i);
});

test('bin actions depend on the latest completed placement for that service line', () => {
  const values = { state: { visits: [
    { serviceLineId: 'delivered', serviceAction: 'delivery', visitNumber: 1, status: 'completed' },
    { serviceLineId: 'new', serviceAction: 'delivery', visitNumber: 2, status: 'ready' },
    { serviceLineId: 'delivered', serviceAction: 'exchange_bin', visitNumber: 3, status: 'cancelled' }
  ] } };
  const api = functions('public/mbt-frontdesk.js', ['binAvailableForService'], values);
  assert.equal(api.binAvailableForService({ serviceLineId: 'delivered' }), true);
  assert.equal(api.binAvailableForService({ serviceLineId: 'new' }), false);
  values.state.visits.push({ serviceLineId: 'delivered', serviceAction: 'exchange_bin', visitNumber: 4, status: 'ready' });
  assert.equal(api.binAvailableForService({ serviceLineId: 'delivered' }), false);
  values.state.visits.at(-1).status = 'completed';
  assert.equal(api.binAvailableForService({ serviceLineId: 'delivered' }), true);
});
