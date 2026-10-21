import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync('netsuite-pallet-balance-search-restlet.js', 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture({ filters = [], values = [], fault = null, failAt = null } = {}) {
  const columns = [
    { name: 'entity', summary: 'GROUP', label: 'Customer' },
    { name: 'formulanumeric', summary: 'SUM', label: 'Issued', formula: 'issued' },
    { name: 'formulanumeric', summary: 'SUM', label: 'Returned', formula: 'returned' },
    { name: 'formulanumeric', summary: 'SUM', label: 'Balance', formula: 'issued-returned' }
  ];
  const observations = { loads: [], ranges: [], saves: 0 };
  function fail(stage) {
    if (failAt === stage) throw fault;
  }
  const loaded = {
    filterExpression: filters,
    columns,
    save() {
      observations.saves += 1;
      throw new Error('The read-only RESTlet must not save the search.');
    },
    run() {
      fail('run');
      return {
        getRange(options) {
          fail('range');
          observations.ranges.push(plain(options));
          return values.map(row => ({
            getValue(column) {
              fail('value');
              const index = columns.indexOf(column);
              assert.ok(index >= 0, 'Use the original column object, including its formula.');
              return row[index];
            }
          }));
        }
      };
    }
  };
  let api;
  vm.runInNewContext(source, {
    define(dependencies, factory) {
      assert.deepEqual(plain(dependencies), ['N/search', 'N/error']);
      api = factory({
        Operator: { ANYOF: 'anyof' },
        load(options) {
          fail('load');
          observations.loads.push(plain(options));
          return loaded;
        }
      }, {
        create({ name, message }) {
          return Object.assign(new Error(message), { name });
        }
      });
    }
  }, { filename: 'netsuite-pallet-balance-search-restlet.js', timeout: 1000 });
  return { api, loaded, observations };
}

test('S1 keeps original OR criteria grouped, preserves formula columns and returns raw report values', () => {
  const filters = [['location', 'anyof', '26'], 'or', ['location', 'anyof', '1']];
  const original = plain(filters);
  const { api, loaded, observations } = fixture({ filters, values: [['5240', '206', '194', '12']] });
  const result = plain(api.get({ customerId: '5240' }));
  assert.deepEqual(plain(loaded.filterExpression), [original, 'and', ['entity', 'anyof', '5240']]);
  assert.deepEqual(filters, original);
  assert.deepEqual(observations.loads, [{ id: 'customsearch503' }]);
  assert.deepEqual(observations.ranges, [{ start: 0, end: 51 }]);
  assert.equal(observations.saves, 0);
  assert.equal(result.savedSearchId, 'customsearch503');
  assert.equal(result.customerId, '5240');
  assert.equal(result.rowCount, 1);
  assert.equal(result.found, true);
  assert.deepEqual(result.rows, [['5240', '206', '194', '12']]);
  assert.deepEqual(result.columns.map(column => column.formula), ['', 'issued', 'returned', 'issued-returned']);
  assert.deepEqual(result.columns.map(column => column.index), [0, 1, 2, 3]);
  assert.ok(Number.isFinite(Date.parse(result.generatedAt)));
});

test('S2 an empty report is explicit no-result, with customer filtering even when saved criteria are empty', () => {
  for (const filters of [[], null]) {
    const { api, loaded } = fixture({ filters });
    const result = plain(api.get({ customerId: 5240 }));
    assert.deepEqual(plain(loaded.filterExpression), [['entity', 'anyof', '5240']]);
    assert.equal(result.found, false);
    assert.equal(result.rowCount, 0);
    assert.deepEqual(result.rows, []);
    assert.equal(Object.hasOwn(result, 'balance'), false);
    assert.equal(Object.hasOwn(result, 'available'), false);
  }
});

test('S3 invalid identifiers fail before loading the search', () => {
  const { api, observations } = fixture();
  for (const customerId of [undefined, null, '', 0, -1, 1.5, Infinity, NaN, true, [],
    {}, '5240 OR 1=1', ' 5240', '05240', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => api.get({ customerId }), { name: 'INVALID_CUSTOMER_ID' });
  }
  assert.deepEqual(observations.loads, []);
});

test('S4 excess rows are rejected and multiple summary rows remain separate', () => {
  const tooMany = fixture({ values: Array.from({ length: 51 }, () => ['5240', '1', '0', '1']) });
  assert.throws(() => tooMany.api.get({ customerId: 5240 }), { name: 'PALLET_SEARCH_TOO_MANY_ROWS' });
  const grouped = fixture({ values: [['5240', '194', '194', '0'], ['5240', '12', '0', '12']] });
  const result = plain(grouped.api.get({ customerId: 5240 }));
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.rows, [['5240', '194', '194', '0'], ['5240', '12', '0', '12']]);
});

test('S5 search, permission and result-read failures propagate without fabricated balances', () => {
  for (const failAt of ['load', 'run', 'range', 'value']) {
    const fault = new Error(`Simulated NetSuite ${failAt} failure`);
    const { api } = fixture({ values: [['5240', '206', '194', '12']], failAt, fault });
    assert.throws(() => api.get({ customerId: 5240 }), thrown => thrown === fault);
  }
});

test('S6 only GET is exposed and callers cannot select a different saved search', () => {
  const { api, observations } = fixture();
  assert.deepEqual(Object.keys(api), ['get']);
  api.get({ customerId: 5240, searchId: 'customsearch_unrelated' });
  assert.deepEqual(observations.loads, [{ id: 'customsearch503' }]);
  assert.equal(observations.saves, 0);
});
