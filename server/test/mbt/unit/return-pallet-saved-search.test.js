import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { execFileSync } from 'node:child_process';
import { parsePalletSavedSearch } from '../../../src/return-pallet-saved-search.js';
import { returnBalance } from '../../../src/return-policy.js';
import { palletSearchResult } from '../../support/pallet-saved-search-fixture.js';

test('S1 reads the actual customer-specific net balance and source identity', () => {
  for (const [id, balance] of [[5240, 13], [1959, 2]]) {
    const input = palletSearchResult(id, balance);
    const result = parsePalletSavedSearch(input, id);
    assert.equal(result.netBalance, balance);
    assert.equal(result.savedSearchId, 'customsearch503');
    assert.equal(result.source, 'netsuite_saved_search');
    assert.equal(result.balanceFound, true);
    assert.equal(result.lookedUpAt, input.generatedAt);
    assert.equal(Object.hasOwn(result, 'rows'), false, 'Do not expose unrelated report fields.');
  }
});

const malformed = {
  'wrong search': value => { value.savedSearchId = 'customsearch504'; },
  'wrong envelope customer': value => { value.customerId = '1959'; },
  'wrong row customer': value => { value.rows[0][0] = '1959'; },
  'wrong version': value => { value.version = 2; },
  'inconsistent count': value => { value.rowCount = 0; },
  'inconsistent found': value => { value.found = false; },
  'multiple customer rows': value => { value.rows.push([...value.rows[0]]); value.rowCount = 2; },
  'missing quantity column': value => { value.columns[2].name = 'amount'; },
  'changed quantity summary': value => { value.columns[2].summary = 'MAX'; },
  'changed quantity label': value => { value.columns[2].label = 'Another quantity'; },
  'changed formula': value => { value.columns[2].formula = '{amount}'; },
  'changed grouping': value => { value.columns[1].name = 'location'; },
  'extra column': value => { value.columns.push({ ...value.columns[1], index: 5 }); value.rows[0].push('26'); },
  'bad column index': value => { value.columns[2].index = 0; },
  'row width mismatch': value => { value.rows[0].pop(); },
  'old timestamp': value => { value.generatedAt = new Date(Date.now() - 180000).toISOString(); },
  'future timestamp': value => { value.generatedAt = new Date(Date.now() + 60000).toISOString(); },
  'invalid timestamp': value => { value.generatedAt = 'not-a-date'; }
};
for (const [name, mutate] of Object.entries(malformed)) {
  test(`S2 rejects ${name}`, () => {
    const value = palletSearchResult(5240);
    mutate(value);
    assert.throws(() => parsePalletSavedSearch(value, 5240), { code: 'PALLET_SEARCH_INVALID' });
  });
}

test('S2 rejects invalid quantity representations instead of coercing them to zero', () => {
  for (const quantity of ['', ' ', null, undefined, true, false, {}, [], 'NaN', 'Infinity',
    '0x10', '1e2', '1,234', '12 pallets', NaN, Infinity, -Infinity,
    '99999999999999999', '9'.repeat(400)]) {
    const value = palletSearchResult(5240);
    value.rows[0][2] = quantity;
    assert.throws(() => parsePalletSavedSearch(value, 5240), { code: 'PALLET_SEARCH_INVALID' });
  }
  for (const payload of [null, undefined, [], {}, 'invalid']) {
    assert.throws(() => parsePalletSavedSearch(payload, 5240), { code: 'PALLET_SEARCH_INVALID' });
  }
});

test('S2 rejects a reported row that is null or is not a result array', () => {
  for (const row of [null, undefined, false, 0, '', {}, '5240']) {
    const value = palletSearchResult(5240);
    value.rows = [row];
    assert.throws(() => parsePalletSavedSearch(value, 5240), { code: 'PALLET_SEARCH_INVALID' });
  }
});

test('S1 configuration selects the verified deployment only for its account and supports explicit override', () => {
  const read = (account, override) => {
    const env = { ...process.env, NETSUITE_ACCOUNT_ID: account };
    if (override === undefined) { delete env.NETSUITE_PALLET_BALANCE_RESTLET_URL; }
    else { env.NETSUITE_PALLET_BALANCE_RESTLET_URL = override; }
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      "import {config} from './src/config.js';console.log(JSON.stringify(config.netsuite.palletBalanceRestletUrl));"],
    { env, encoding: 'utf8', cwd: new URL('../../../', import.meta.url) }).trim());
  };
  assert.equal(read('6518947'), 'https://6518947.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=505&deploy=1');
  assert.equal(read('another-account'), '');
  assert.equal(read('6518947', ''), '');
  assert.equal(read('6518947', '  https://configured.example/  '), 'https://configured.example/');
});

test('S3 a valid empty report grants zero availability and retains the no-result distinction', () => {
  const value = palletSearchResult(5240);
  Object.assign(value, { found: false, rowCount: 0, rows: [] });
  const parsed = parsePalletSavedSearch(value, 5240);
  assert.equal(parsed.balanceFound, false);
  assert.equal(parsed.netBalance, 0);
  assert.equal(returnBalance({ ...parsed, localReserved: 3 }).available, 0);
});

test('S4 net balance subtracts reservations without fabricating issued/returned totals', () => {
  assert.deepEqual(returnBalance({ netBalance: 13, localReserved: 3 }), {
    netBalance: 13, fulfilled: null, netsuiteReturned: null, localReserved: 3, available: 10
  });
  assert.equal(returnBalance({ netBalance: -2, localReserved: 1 }).available, 0);
  assert.equal(returnBalance({ netBalance: 2.75, localReserved: 1.25 }).available, 1.5);
  for (const netBalance of [null, NaN, Infinity, -Infinity, true, '']) {
    assert.throws(() => returnBalance({ netBalance }));
  }
});

test('S4 legacy return arithmetic and response remain compatible', () => {
  assert.deepEqual(returnBalance({ fulfilled: 10, netsuiteReturned: 3, localReserved: 2 }), {
    fulfilled: 10, netsuiteReturned: 3, localReserved: 2, available: 5
  });
});

test('property: report quantities and local reservations conserve the exact allowed balance', () => {
  fc.assert(fc.property(fc.integer({ min: -100000, max: 100000 }),
    fc.integer({ min: 0, max: 100000 }), (signed, pending) => {
      const netBalance = signed / 8, localReserved = pending / 8;
      const value = palletSearchResult(5240, netBalance);
      const parsed = parsePalletSavedSearch(value, 5240);
      assert.equal(parsed.netBalance, netBalance);
      assert.equal(returnBalance({ ...parsed, localReserved }).available, Math.max(netBalance - localReserved, 0));
    }), { numRuns: 100, seed: 800909 });
});

test('property: foreign identities, ambiguous groups and malformed quantities always fail', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }).filter(id => id !== 5240),
    fc.constantFrom('customer', 'grouping', 'quantity'), (id, fault) => {
      const value = palletSearchResult(5240);
      if (fault === 'customer') { value.rows[0][0] = String(id); }
      if (fault === 'grouping') { value.rows.push([...value.rows[0]]); value.rowCount = 2; }
      if (fault === 'quantity') { value.rows[0][2] = `invalid-${id}`; }
      assert.throws(() => parsePalletSavedSearch(value, 5240), { code: 'PALLET_SEARCH_INVALID' });
    }), { numRuns: 100, seed: 800809 });
});
