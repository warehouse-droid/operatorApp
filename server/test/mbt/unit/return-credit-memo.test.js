import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { materializeOperatorNetSuitePostingPolicy } from '../../../src/operator-netsuite-posting-policy.js';
import { MBT_ADMIN_GATE_DEFINITIONS } from '../../../src/mbt/feature-gate-catalog.js';
import { buildReturnBatchPayload, verifyReturnBatchSnapshot } from '../../../src/return-batch-ra-domain.js';

const intent = () => ({ transactionType: 'credit_memo', externalId: 'MBBS-RB-000001', customerId: 30,
  receivingLocationId: 28, sourceSalesOrderId: 40, submittedDate: '2026-10-08', memo: 'SR-000001 | SOA40',
  lines: [{ kind: 'stock', sourceSalesOrderLineId: 401, netSuiteOrderLine: 2, itemId: 60,
    returnedSalesQuantity: 1.25, rate: 12, reasonId: 6, salesUomId: 3 },
  { kind: 'pallet', itemId: 70, returnedSalesQuantity: 2, rate: 40, reasonId: 10, salesUomId: null }] });
const snapshot = data => ({ ...buildReturnBatchPayload(data), id: '901', tranId: 'CM901', status: { refName: 'Open' } });

test('G1 CM catalog exposes eight disabled-by-default independent admin gates', () => {
  const gates = MBT_ADMIN_GATE_DEFINITIONS.filter(gate => /^operator_netsuite_(stock|pallet)_return_cm_/.test(gate.flagKey));
  assert.equal(gates.length, 8);
  assert.equal(new Set(gates.map(gate => gate.flagKey)).size, 8);
  assert.ok(gates.every(gate => gate.transactionType === 'CM' && gate.configuredDefault === false
    && gate.requiresNetSuiteDirectAccess && gate.gateGroup === 'operator_netsuite_posting'));
});

test('G1 generated yard/function policies prefer CM while respecting strict booleans and direct access', () => {
  fc.assert(fc.property(fc.constantFrom(1, 28, 15, 26, '3445', '2967', '12441', '150', '13'),
    fc.constantFrom('stock_return', 'pallet_return'), fc.boolean(), fc.boolean(), fc.boolean(),
    (locationId, functionKey, raEnabled, cmEnabled, directAccessEnabled) => {
      const policy = materializeOperatorNetSuitePostingPolicy({ locationId, functionKey,
        flag: { enabled: raEnabled, revision: 4 }, creditMemoFlag: { enabled: cmEnabled, revision: 7 }, directAccessEnabled });
      assert.equal(policy.transactionType, cmEnabled ? 'CM' : 'RA');
      assert.equal(policy.effective, directAccessEnabled && (cmEnabled || raEnabled));
      assert.equal(policy.revision, cmEnabled ? 7 : 4);
      assert.match(policy.gateKey, cmEnabled ? /_cm_/ : /_ra_/);
    }), { numRuns: 150, seed: 20261008 });
});

test('G1 missing flags and hostile truthy values cannot select direct CM posting', () => {
  for (const creditMemoFlag of [undefined, null, {}, { enabled: 'true' }, { enabled: 1 }, { enabled: {} }]) {
    const policy = materializeOperatorNetSuitePostingPolicy({ functionKey: 'pallet_return', locationId: 1,
      flag: { enabled: false, revision: 3 }, creditMemoFlag, directAccessEnabled: true });
    assert.equal(policy.transactionType, 'RA');
    assert.equal(policy.effective, false);
  }
  assert.equal(materializeOperatorNetSuitePostingPolicy({ functionKey: 'stock_return', locationId: 1,
    creditMemoFlag: { enabled: true, revision: 1 }, directAccessEnabled: 'true' }).effective, false);
});

test('P1 direct CM payload includes customer and explicit source descriptions without transform orderLine keys', () => {
  const payload = buildReturnBatchPayload(intent());
  assert.deepEqual(payload.entity, { id: '30' });
  assert.equal(payload.createdFrom, undefined);
  assert.equal(payload.item.items[0].orderLine, undefined);
  assert.equal(payload.item.items[0].description, 'Return from SO 40; source line 401; reason 6; row 1');
  assert.equal(payload.item.items[0].units, '3');
  assert.equal(payload.item.items[1].rate, 40);
  assert.equal(payload.item.items[1].custcol_atlas_rc_so.id, '10');
});

test('P1 generated CM payload preserves each accepted price and quantity exactly', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 0, max: 100000 }),
    (hundredths, cents) => {
      const data = intent();
      data.lines[0].rate = cents / 100;
      data.lines[0].returnedSalesQuantity = hundredths / 100;
      const payload = buildReturnBatchPayload(data);
      assert.deepEqual(payload.item.items.map(line => [line.quantity, line.rate]),
        data.lines.map(line => [line.returnedSalesQuantity, line.rate]));
      const valid = snapshot(data);
      valid.item.items[0].rate += 0.01;
      assert.throws(() => verifyReturnBatchSnapshot(data, valid), { code: 'RETURN_CM_VERIFICATION_FAILED' });
    }), { numRuns: 100, seed: 20261008 });
});

test('V1 generated direct CM readback conserves fractional quantities, zero rates, reasons and units', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 50000 }), fc.integer({ min: 0, max: 10000 }),
    fc.constantFrom(1, 3, 7), (units, cents, uom) => {
      const data = intent();
      data.lines[0].returnedSalesQuantity = units / 100;
      data.lines[0].rate = cents / 100;
      data.lines[0].salesUomId = uom;
      const valid = snapshot(data);
      valid.item.items.reverse();
      assert.equal(verifyReturnBatchSnapshot(data, valid), valid);
      valid.item.items[1].quantity += 0.01;
      assert.throws(() => verifyReturnBatchSnapshot(data, valid), { code: 'RETURN_CM_VERIFICATION_FAILED' });
    }), { numRuns: 100, seed: 20261008 });
});

test('V1 hostile CM readback rejects mismatched identities, quantities, money, units and missing source evidence', () => {
  const data = intent();
  const valid = snapshot(data);
  assert.doesNotThrow(() => verifyReturnBatchSnapshot(data, valid));
  for (const mutate of [
    s => { s.id = '0'; }, s => { s.externalId = 'other'; }, s => { s.entity.id = '31'; },
    s => { s.location.id = '1'; }, s => { s.createdFrom = { id: '40' }; }, s => { s.tranId = ''; },
    s => { s.item.items[0].quantity = ''; }, s => { s.item.items[0].rate = null; },
    s => { s.item.items[0].item.id = '61'; }, s => { s.item.items[0].units = '7'; },
    s => { s.item.items[0].custcol_atlas_rc_so.id = '7'; }, s => { s.item.items[0].description = 'wrong SO'; },
    s => { s.item.items[0].location.id = '1'; }, s => { s.item.items.pop(); },
    s => { s.status.refName = 'Voided'; }
  ]) {
    const invalid = structuredClone(valid); mutate(invalid);
    assert.throws(() => verifyReturnBatchSnapshot(data, invalid), { code: 'RETURN_CM_VERIFICATION_FAILED' });
  }
  assert.throws(() => verifyReturnBatchSnapshot({ ...data, netSuiteTransactionId: 902 }, valid), { code: 'RETURN_CM_VERIFICATION_FAILED' });
  valid.status.refName = 'Voided';
  assert.equal(verifyReturnBatchSnapshot(data, valid, { allowInactive: true }), valid);
});

function operatorFunction(name) {
  const source = readFileSync(new URL('../../../public/operator.js', import.meta.url), 'utf8');
  const match = source.match(new RegExp(`(?:async )?function ${name}\\(`));
  const tail = source.slice(match.index + match[0].length).search(/\n(?:async )?function /);
  return source.slice(match.index, tail < 0 ? undefined : match.index + match[0].length + tail);
}
test('U1 Operator review and results identify direct Credit Memos accurately', () => {
  const context = vm.createContext({ returnPostingLoading: false, returnPostingError: '',
    returnPostingReady: () => true, returnPostingFunctions: () => ['stock_return', 'pallet_return'],
    returnPostingPolicies: { stock_return: { effective: true, transactionType: 'CM' }, pallet_return: { effective: true, transactionType: 'CM' } },
    escapeHtml: value => String(value ?? ''), t: (_, fallback) => fallback, localizeMessage: value => value,
    returnResult: { batchReference: 'RB-000001', stockReturn: { workflowVersion: 3, netSuiteStage: 'credit_memo',
      netSuiteSyncStatus: 'succeeded', netSuiteTransactionRef: 'CM901' } } });
  for (const name of ['renderReturnPostingPolicies', 'returnNetSuiteResultLabel', 'renderReturnSuccess']) {
    vm.runInContext(operatorFunction(name), context);
  }
  assert.match(context.renderReturnPostingPolicies(), /Credit Memo/);
  assert.doesNotMatch(context.renderReturnPostingPolicies(), /Creates one RA/);
  assert.match(context.renderReturnSuccess(), /Credit Memo<\/span><strong>CM901/);
  for (const status of ['pending', 'failed', 'cancelled', 'succeeded']) {
    assert.match(context.returnNetSuiteResultLabel({ workflowVersion: 3, netSuiteStage: 'credit_memo',
      netSuiteSyncStatus: status, netSuiteTransactionRef: 'CM901' }), /Credit Memo/);
  }
});

test('U1 Control and Sales label CM pending, created and failed without RA status text', () => {
  for (const [file, names] of [['control', ['returnStatus', 'returnStatusLabel']], ['sales', ['salesReturnStatus', 'salesReturnStatusLabel']]]) {
    const source = readFileSync(new URL(`../../../public/${file}.js`, import.meta.url), 'utf8');
    const first = (record, keys, fallback) => keys.map(key => record[key]).find(value => value !== undefined) ?? fallback;
    const c = vm.createContext({ firstDefined: first, salesFirst: first, returnType: () => 'stock', salesReturnType: () => 'stock' });
    for (const name of names) {
      const start = source.indexOf(`function ${name}(`);
      const end = source.indexOf('\nfunction ', start + 1);
      vm.runInContext(source.slice(start, end), c);
    }
    for (const netSuiteSyncStatus of ['pending', 'succeeded', 'failed']) {
      assert.match(c[names[1]]({ workflowVersion: 3, netSuiteStage: 'credit_memo', netSuiteSyncStatus }), /Credit Memo/);
    }
  }
});
