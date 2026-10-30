import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { query, closeDb, withTransaction } from '../../../src/db.js';
import { submitReturnBatch } from '../../../src/return-repository.js';
import { fixture, submitInput, actor } from '../../support/return-batch-ra-fixture.js';
import { upsertReturnCustomerDirectoryEntries, searchLocalReturnCustomerDirectory } from '../../../src/return-customer-directory.js';
import { fetchReturnCustomersFromNetSuite } from '../../../src/return-netsuite.js';
after(closeDb);

test('pallet submission accepts absent photos/plate, posts once and retains quota validation', async t => {
  const remote = await fixture(t, { enabled: false });
  const flags = await query("SELECT flag_key,enabled,revision FROM mbt_feature_flags WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'");
  t.after(async () => { for (const f of flags.rows) { await query('UPDATE mbt_feature_flags SET enabled=$2,revision=$3 WHERE flag_key=$1', [f.flag_key, f.enabled, f.revision]); } });
  await query("UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key LIKE 'operator_netsuite_%return_cm_%'");
  const input = await submitInput({ stock: false, pallet: true });
  delete input.palletPhotos; delete input.vehiclePlate;
  const submit = value => submitReturnBatch({ operatorId: actor, input: value, autoSync: true });
  const result = await submit(input);
  assert.equal(result.palletReturn.netSuiteSyncStatus, 'succeeded');
  assert.equal(result.palletReturn.vehiclePlate, '');
  assert.equal((await query('SELECT count(*)::int AS n FROM return_photos WHERE return_record_id=$1', [result.palletReturn.id])).rows[0].n, 0);
  assert.equal((await submit(input)).idempotentReplay, true);
  assert.equal(remote.requests.filter(r => r.method === 'POST' && /\/creditMemo$/.test(r.address)).length, 1);
  const invalid = await submitInput({ stock: false, pallet: true, quantity: 10000 });
  invalid.palletPhotos = [];
  await assert.rejects(submit(invalid), error => error.status >= 400 && /quantity|quota|available|balance/i.test(error.message));
});

test('optional photos still reject invalid uploads; normal stock evidence stays required', async t => {
  await fixture(t);
  const submit = input => submitReturnBatch({ operatorId: actor, input, autoSync: true });
  const pallet = await submitInput({ stock: false, pallet: true });
  pallet.palletPhotos = ['https://untrusted.invalid/image.jpg'];
  await assert.rejects(submit(pallet), /completed application photo upload/);
  const stock = await submitInput({ stock: true, pallet: false });
  stock.photos = [];
  await assert.rejects(submit(stock), /Normal Stock Return requires at least one/);
});

test('customer phone search tolerates separators and an optional North American country code', async t => {
  await fixture(t);
  const forms = ['(416) 555 0123', '416-555-0123', '416-555 0123', '4165550123', '+1 (416) 555-0123', '1 416.555.0123'];
  await withTransaction(async () => {
    await upsertReturnCustomerDirectoryEntries(forms.map((phone, i) => ({ id: 99800100 + i, code: `PHONE-FORMAT-${i}`, companyName: `Phone Format ${i}`, phone })));
    for (const search of forms) {
      const matches = await searchLocalReturnCustomerDirectory(search);
      assert.equal(matches.filter(row => row.id >= 99800100 && row.id < 99800106).length, forms.length, search);
    }
    assert.equal((await searchLocalReturnCustomerDirectory('PHONE-FORMAT-0'))[0].id, 99800100);
    assert.equal((await searchLocalReturnCustomerDirectory('Phone Format 1'))[0].id, 99800101);
    await query('DELETE FROM return_customer_directory WHERE netsuite_customer_id BETWEEN 99800100 AND 99800105');
  });
});

test('NetSuite fallback phone query handles the same separator/country-code forms', async t => {
  const remote = await fixture(t);
  for (const search of ['(416) 555 0123', '416-555-0123', '416-555 0123', '+1 (416) 555-0123']) {
    await fetchReturnCustomersFromNetSuite(search);
    assert.match(remote.requests.filter(r => r.body.q?.includes('FROM customer c')).at(-1).body.q, /LIKE '%4165550123%'/);
  }
});
