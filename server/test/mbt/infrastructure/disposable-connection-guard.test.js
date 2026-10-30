import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {assertIsolatedTestConnection} from '../../support/test-database-isolation.mjs';

const environment = {MBT_TEST_ISOLATED: '1', NODE_ENV: 'test'};
const base = 'postgres://mbt_test:mbt_test_password@db:5432/mbt_test';
const database = name => { const url = new URL(base); url.pathname = '/' + name; return url.href; };

test('fixture guard accepts only the standard disposable base and per-file databases', () => {
  assert.equal(assertIsolatedTestConnection(base, environment), 'mbt_test');
  const clone = 'mbt_test_file_a0123456789b_12';
  assert.equal(assertIsolatedTestConnection(database(clone), environment), clone);
});

for (const [label, url, env] of [
  ['live host', base.replace('@db:', '@production-db:'), environment],
  ['loopback host', base.replace('@db:', '@127.0.0.1:'), environment],
  ['old unverified alias', base.replace('@db:', '@mbbs-special-review-db:'), environment],
  ['live database', database('operator'), environment],
  ['live account', base.replace('mbt_test:', 'operator:'), environment],
  ['unexpected port', base.replace(':5432/', ':5433/'), environment],
  ['host override query', base + '?host=production-db', environment],
  ['account override query', base + '?user=operator', environment],
  ['non-PostgreSQL protocol', base.replace('postgres:', 'http:'), environment],
  ['malformed clone', database('mbt_test_file_live_0'), environment],
  ['missing isolation flag', base, {NODE_ENV: 'test'}],
  ['production mode', base, {...environment, NODE_ENV: 'production'}],
  ['malformed URL', 'not a database URL', environment]
]) {
  test('fixture guard rejects ' + label, () => {
    assert.throws(() => assertIsolatedTestConnection(url, env), /isolated disposable test database/);
  });
}

test('fixture guard rejects arbitrary database names outside the disposable namespace', () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-z][a-z0-9_]{0,30}$/), name => {
    fc.pre(name !== 'mbt_test' && !/^mbt_test_file_[a-f0-9]{12}_[a-z0-9]+$/.test(name));
    assert.throws(() => assertIsolatedTestConnection(database(name), environment),
      /isolated disposable test database/);
  }), {seed: 20261030, numRuns: 100});
});

test('fixture guard preserves arbitrary valid clone identities and harmless connection labels', () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-f0-9]{12}$/), fc.nat(1000000), (run, index) => {
    const name = 'mbt_test_file_' + run + '_' + index.toString(36);
    assert.equal(assertIsolatedTestConnection(database(name) + '?application_name=fixture', environment), name);
  }), {seed: 20261030, numRuns: 100});
});
