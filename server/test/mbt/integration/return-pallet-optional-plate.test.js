import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, closeDb } from '../../../src/db.js';
import { submitReturnBatch } from '../../../src/return-repository.js';
import { fixture, submitInput, actor } from '../../support/return-batch-ra-fixture.js';

after(closeDb);
async function cmFixture(t) {
  const remote = await fixture(t, { enabled: false });
  const before = await query("SELECT flag_key,enabled,revision FROM mbt_feature_flags WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'");
  t.after(async () => {
    for (const row of before.rows) {
      await query('UPDATE mbt_feature_flags SET enabled=$2,revision=$3 WHERE flag_key=$1', [row.flag_key, row.enabled, row.revision]);
    }
  });
  await query("UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'");
  return remote;
}
const creates = remote => remote.requests.filter(r => r.method === 'POST' && /\/creditMemo$/.test(r.address));
const submit = input => submitReturnBatch({ operatorId: actor, input, autoSync: true });

for (const [name, plate] of [['omitted', undefined], ['empty', ''], ['whitespace', '   ']]) {
  test(`P1/P5 pallet-only ${name} plate posts a CM and replays without duplicate credit`, async t => {
    const remote = await cmFixture(t);
    const input = await submitInput({ stock: false, pallet: true });
    if (plate === undefined) { delete input.vehiclePlate; } else { input.vehiclePlate = plate; }
    const result = await submit(input);
    assert.equal(result.stockReturn, null);
    assert.equal(result.palletReturn.vehiclePlate, '');
    assert.equal(result.palletReturn.netSuiteStage, 'credit_memo');
    assert.equal(result.palletReturn.netSuiteSyncStatus, 'succeeded');
    assert.equal(creates(remote).length, 1);
    assert.doesNotMatch(creates(remote)[0].body.memo, /\bplate(?:\s*\||\s*$)/i);
    const stored = await query('SELECT vehicle_plate FROM return_records WHERE id=$1', [result.palletReturn.id]);
    assert.equal(stored.rows[0].vehicle_plate, '');
    assert.equal((await submit(input)).idempotentReplay, true);
    assert.equal(creates(remote).length, 1);
  });
}

test('P2 a supplied pallet plate is retained and normalized, and oversized plates remain invalid', async t => {
  const remote = await cmFixture(t);
  const input = await submitInput({ stock: false, pallet: true });
  input.vehiclePlate = '  abcd 123  ';
  const result = await submit(input);
  assert.equal(result.palletReturn.vehiclePlate, 'ABCD 123');
  assert.match(creates(remote)[0].body.memo, /plate ABCD 123/);
  const invalid = await submitInput({ stock: false, pallet: true });
  invalid.vehiclePlate = 'X'.repeat(33);
  await assert.rejects(submit(invalid), error => error.status === 400 && /32 characters/.test(error.message));
  assert.equal(creates(remote).length, 1);
});

test('P3/E1 stock and combined returns accept a blank plate and replay without duplicate CMs', async t => {
  const remote = await cmFixture(t);
  for (const pallet of [false, true]) {
    const input = await submitInput({ stock: true, pallet });
    input.vehiclePlate = '';
    const result = await submit(input);
    assert.equal(result.stockReturn.vehiclePlate, '');
    assert.equal(result.stockReturn.netSuiteSyncStatus, 'succeeded');
    assert.equal((await submit(input)).idempotentReplay, true);
  }
  assert.equal(creates(remote).length, 2);
});
