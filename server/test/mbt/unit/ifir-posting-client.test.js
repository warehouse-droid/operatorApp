import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { spawnSync } from 'node:child_process';
import { createIfirPostingClient } from '../../../src/netsuite-ifir-posting-client.js';
import { createOperatorNetSuitePostingAdapter } from '../../../src/operator-netsuite-posting-netsuite-adapter.js';
import { isAmbiguousOperatorNetSuiteFailure } from '../../../src/operator-netsuite-posting-service.js';
import { ifirFixture } from '../../support/ifir-restlet-fixture.mjs';

function setup(options = {}) {
  const fixture = ifirFixture(options.fixture);
  const calls = [];
  const settings = { enabled: true, accountId: 'TEST_SB1',
    url: 'https://test-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=507&deploy=1' };
  const post = createIfirPostingClient({
    settings: () => settings,
    getToken: async () => { calls.push('token'); return 'test-only-placeholder'; },
    mutate: work => work(),
    request: async (url, input) => {
      calls.push({ url, input });
      assert.equal(input.method, 'POST');
      assert.equal(input.redirect, 'error');
      assert.equal(input.headers.Authorization, 'Bearer test-only-placeholder');
      const result = fixture.post(JSON.parse(input.body));
      return { response: { ok: true, status: 200 }, text: JSON.stringify(result) };
    }, ...options.boundary
  });
  return { fixture, calls, settings, post };
}

for (const [kind, type, sourceType] of [['PO', 'IR', 'purchaseorder'], ['SO', 'IF', 'salesorder'],
  ['TO', 'IF', 'transferorder'], ['TO', 'IR', 'transferorder']]) {
  test(`IFIR client ${kind}:${type} returns real saved evidence from the script`, async () => {
    const f = setup();
    Object.assign(f.fixture.request, { sourceOrderKind: kind, transactionType: type });
    f.fixture.state.source.type = sourceType;
    const result = await f.post(f.fixture.step());
    assert.equal(result.id, 8001);
    assert.equal(result.record.tranId, type === 'IR' ? 'IR000123' : 'IF000456');
    assert.equal(result.record.item.items[0].custcol_plt, 1);
    assert.equal(f.calls.filter(call => typeof call === 'object').length, 1);
    assert.equal(f.fixture.state.saves.length, 1);
  });
}

test('IFIR client gate off and unsupported requests use no credentials or HTTP calls', async () => {
  const f = setup();
  f.settings.enabled = false;
  assert.equal(await f.post(f.fixture.step()), null);
  f.settings.enabled = true;
  for (const change of [
    step => { step.lineSnapshot[0].kit = { definition: {} }; },
    step => { step.payload.item.items[0].inventoryDetail = {}; },
    step => { step.payload.unrecognizedBodyField = true; },
    step => { step.sourceOrderKind = 'RA'; },
    step => { step.transactionType = 'IF'; step.sourceOrderKind = 'SO';
      step.payload.item.items[1] = { orderLine: 2, quantity: 1, itemReceive: true, location: 20 }; }
  ]) {
    const step = f.fixture.step(); change(step);
    assert.equal(await f.post(step), null);
  }
  assert.deepEqual(f.calls, []);
});

test('IFIR client rejects wrong-account URLs and redirects before exposing credentials', async () => {
  const f = setup();
  for (const url of ['http://test-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=507&deploy=1',
    'https://other.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=507&deploy=1',
    'https://test-sb1.restlets.api.netsuite.com/other?script=507&deploy=1',
    `${f.settings.url}&action=anything`, `${f.settings.url}#fragment`,
    f.settings.url.replace('https://', 'https://user@'),
    f.settings.url.replace('&deploy=1', ''), `${f.settings.url}&script=508`]) {
    f.settings.url = url;
    await assert.rejects(f.post(f.fixture.step()), error => error.postingNotAttempted === true);
  }
  assert.deepEqual(f.calls, []);
});

test('IFIR client authentication failure is definitively before posting', async () => {
  let requests = 0;
  const f = setup({ boundary: { getToken: async () => { throw Error('No token'); },
    request: async () => { requests += 1; } } });
  await assert.rejects(f.post(f.fixture.step()), error => error.postingNotAttempted === true
    && !isAmbiguousOperatorNetSuiteFailure(error));
  assert.equal(requests, 0);
});

test('IFIR client timeout sends only one POST and is never a native fallback', async () => {
  let requests = 0;
  const f = setup({ boundary: { request: async () => {
    requests += 1; throw Object.assign(Error('timeout'), { code: 'NETSUITE_REQUEST_TIMEOUT' });
  } } });
  await assert.rejects(f.post(f.fixture.step()), error => error.ambiguous === true && !error.postingNotAttempted);
  assert.equal(requests, 1);
});

test('IFIR client non-Error transport rejection still requires reconciliation without reposting', async () => {
  for (const failure of [null, 'connection terminated']) {
    let attempts = 0;
    const f = setup({ boundary: { request: async () => { attempts += 1; throw failure; } } });
    await assert.rejects(f.post(f.fixture.step()), error => error instanceof Error
      && error.code === 'IFIR_RESPONSE_UNVERIFIED' && error.ambiguous === true
      && error.requiresReconciliation === true && error.postingNotAttempted === false);
    assert.equal(attempts, 1);
  }
});

test('IFIR client validates contract and both identities before accepting saved evidence', async () => {
  const valid = ifirFixture().post();
  for (const change of [
    data => { data.contractVersion = 2; }, data => { data.complete = false; },
    data => { data.requiresReconciliation = true; }, data => { data.outcome = 'unknown'; },
    data => { data.id = 8002; }, data => { data.tranId = ''; },
    data => { data.record.id = 8002; }, data => { data.record.tranId = 'DIFFERENT'; },
    data => { data.record.externalId = 'other'; }, data => { data.record.createdFromId = 902; },
    data => { data.record.transactionType = 'IF'; }, data => { data.record.recordType = 'itemfulfillment'; },
    data => { data.source.id = 902; }, data => { data.source.sourceOrderKind = 'SO'; },
    data => { data.record.item.items[0].quantity = 3; }, data => { data.record.item.items[0].item.id = '999'; },
    data => { data.record.item.items[0].location.id = '99'; }, data => { data.record.item.items[0].unitsDisplay = 'TON'; }
  ]) {
    const response = structuredClone(valid); change(response);
    const f = setup({ boundary: { request: async () => ({ response: { ok: true, status: 200 }, text: JSON.stringify(response) }) } });
    await assert.rejects(f.post(f.fixture.step()), error => error.ambiguous === true);
  }
});

test('IFIR client malformed JSON, empty and HTTP errors cannot be accepted or retried', async () => {
  for (const [status, text] of [[200, ''], [200, '{broken'], [200, 'null'], [200, '[]'],
    [401, '{"error":"unauthorized"}'], [500, '{}']]) {
    let attempts = 0;
    const f = setup({ boundary: { request: async () => { attempts += 1;
      return { response: { ok: status === 200, status }, text }; } } });
    await assert.rejects(f.post(f.fixture.step()), error => error.ambiguous === true);
    assert.equal(attempts, 1);
  }
});

test('IFIR client retains known saved ID when the script cannot complete its readback', async () => {
  const f = setup({ fixture: { failRead: true } });
  await assert.rejects(f.post(f.fixture.step()), error => error.ambiguous === true
    && error.id === 8001 && error.requiresReconciliation === true);
  assert.equal(f.fixture.state.saves.length, 1);
});

test('IFIR client disabled deployment rejects without a native fallback or ambiguous write', async () => {
  const f = setup();
  f.fixture.state.params.custscript_mbbs_ifir_writes_enabled = false;
  await assert.rejects(f.post(f.fixture.step()), error => error.postingNotAttempted === true
    && error.code === 'IFIR_WRITES_DISABLED' && !isAmbiguousOperatorNetSuiteFailure(error));
  assert.equal(f.fixture.state.saves.length, 0);
});

test('IFIR client returns native fallback only for proven unsupported cases before save', async () => {
  const f = setup();
  f.fixture.state.source.items[0].itemtype = 'Kit';
  assert.equal(await f.post(f.fixture.step()), null);
  assert.equal(f.fixture.state.saves.length, 0);
  const failure = { ok: false, contractVersion: 1, complete: false, code: 'IFIR_UNSUPPORTED_KIT',
    id: 8001, ambiguous: true, requiresReconciliation: true, postingNotAttempted: true, stage: 'readback' };
  const g = setup({ boundary: { request: async () => ({ response: { ok: true, status: 200 }, text: JSON.stringify(failure) }) } });
  await assert.rejects(g.post(g.fixture.step()), error => error.ambiguous === true && error.id === 8001);
});

test('property: IFIR returned evidence retains identity and quantities across saved responses', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 10000 }), async quantity => {
    const f = setup();
    f.fixture.request.payload.item.items[0].quantity = quantity;
    const step = f.fixture.step(); step.lineSnapshot[0].quantity = quantity;
    const result = await f.post(step);
    assert.equal(result.id, result.record.id);
    assert.equal(result.tranId, result.record.tranId);
    assert.equal(result.record.item.items[0].quantity, quantity);
    assert.equal(f.fixture.state.saves.length, 1);
    const again = await f.post(step);
    assert.equal(again.outcome, 'existing');
    assert.equal(f.fixture.state.saves.length, 1);
  }), { numRuns: 100, seed: 20261021 });
});

test('property: IFIR rejects corrupted evidence and gate-off never posts', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 10000 }), async quantity => {
    const f = setup();
    Object.assign(f.fixture.request, { sourceOrderKind: 'SO', transactionType: 'IF' });
    f.fixture.state.source.type = 'salesorder';
    f.fixture.request.payload.item.items[0].quantity = quantity;
    const step = f.fixture.step(); step.lineSnapshot[0].quantity = quantity;
    const valid = await f.post(step);
    for (const fault of ['identity', 'quantity', 'package']) {
      const data = structuredClone(valid);
      if (fault === 'identity') { data.record.id += 1; }
      if (fault === 'quantity') { data.record.item.items[0].quantity += 1; }
      if (fault === 'package') { data.record.item.items[0].custcol_plt += 1; }
      const bad = setup({ boundary: { request: async () => ({ response: { ok: true, status: 200 }, text: JSON.stringify(data) }) } });
      await assert.rejects(bad.post(step), error => error.ambiguous === true);
    }
    f.settings.enabled = false;
    const before = f.calls.length;
    assert.equal(await f.post(step), null);
    assert.equal(f.calls.length, before);
  }), { numRuns: 100, seed: 20261022 });
});

test('IFIR runtime adapter consumes authenticated purchase charge source without extra GET', async () => {
  const f = setup();
  f.fixture.state.source.items.push({ line: 3, lineuniquekey: 7003, item: 503, itemtype: 'OthCharge',
    quantity: 1, rate: 50, units: 'Each', unitstext: 'Each', location: 15 });
  const forbidden = async () => { assert.fail('Unexpected legacy post or extra read'); };
  const adapter = createOperatorNetSuitePostingAdapter({
    findTransactionByExternalId: forbidden, transformSalesOrderToItemFulfillment: forbidden,
    transformTransferOrderToItemFulfillment: forbidden, transformPurchaseOrderToItemReceipt: forbidden,
    transformTransferOrderToItemReceipt: forbidden, fetchItemFulfillment: forbidden, fetchItemReceipt: forbidden,
    fetchPurchaseReceiptSource: forbidden, postIfirRestlet: f.post
  });
  const step = f.fixture.step();
  const result = await adapter.transform(step);
  assert.equal(result.record.tranId, 'IR000123');
  const verified = adapter.verify(step, result.record);
  assert.equal(verified.additionalPurchaseCharges[0].amount, 50);
  assert.equal(f.calls.filter(call => typeof call === 'object').length, 1);
});

test('IFIR feature gate defaults off and can explicitly enable and disable the deployment', () => {
  for (const [value, expected] of [[undefined, false], ['true', true], ['false', false]]) {
    const env = { ...process.env, NETSUITE_IFIR_POSTING_RESTLET_URL: 'https://example.invalid' };
    if (value === undefined) { delete env.NETSUITE_IFIR_POSTING_ENABLED; }
    else { env.NETSUITE_IFIR_POSTING_ENABLED = value; }
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import {config} from './src/config.js';console.log(JSON.stringify({enabled:config.netsuite.ifirPostingEnabled,url:config.netsuite.ifirPostingRestletUrl}))"],
    { env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { enabled: expected, url: 'https://example.invalid' });
  }
});

test('IFIR package mismatch cannot finalize even when the sales quantity matches', async () => {
  for (const value of [null, undefined, 2, 'not-a-number']) {
    const f = setup({ fixture: { afterSave: saved => { saved.items[0].custcol_plt = value; } } });
    Object.assign(f.fixture.request, { sourceOrderKind: 'SO', transactionType: 'IF' });
    f.fixture.state.source.type = 'salesorder';
    await assert.rejects(f.post(f.fixture.step()), error => error.ambiguous === true && /package/i.test(error.message));
    assert.equal(f.fixture.state.saves.length, 1);
  }
});

test('IFIR receipt package fields remain honestly null when NetSuite does not store them', async () => {
  const f = setup({ fixture: { afterSave: saved => { delete saved.items[0].custcol_plt; } } });
  const result = await f.post(f.fixture.step());
  assert.equal(result.record.item.items[0].custcol_plt, null);
  assert.equal(result.record.item.items[0].quantity, 2);
  assert.equal(result.record.tranId, 'IR000123');
});

test('IFIR discount lines are omitted and the fulfillable special-order item is verified', async () => {
  const f = setup();
  Object.assign(f.fixture.request, { sourceOrderKind: 'SO', transactionType: 'IF' });
  f.fixture.state.source.type = 'salesorder';
  f.fixture.state.source.items[0].itemtype = 'NonInvtPart';
  f.fixture.state.source.items.push({ line: 3, item: 700, itemtype: 'Discount', quantity: 1 });
  const result = await f.post(f.fixture.step());
  assert.equal(result.record.item.items.length, 1);
  assert.equal(result.record.item.items[0].itemType, 'NonInvtPart');
  assert.equal(result.source.lines.find(line => line.restLineId === 3).itemType, 'Discount');
});

test('IFIR native transport is retained and gate changes are read for every attempt', async () => {
  const f = setup();
  const calls = [];
  const native = async () => { calls.push('native'); return { id: 123 }; };
  const adapter = createOperatorNetSuitePostingAdapter({ findTransactionByExternalId: async () => null,
    transformSalesOrderToItemFulfillment: native, transformTransferOrderToItemFulfillment: native,
    transformPurchaseOrderToItemReceipt: native, transformTransferOrderToItemReceipt: native,
    fetchItemFulfillment: async () => null, fetchItemReceipt: async () => null, postIfirRestlet: f.post });
  f.settings.enabled = false;
  assert.deepEqual(await adapter.transform(f.fixture.step()), { id: 123 });
  assert.equal(f.calls.length, 0);
  f.settings.enabled = true;
  assert.equal((await adapter.transform(f.fixture.step())).record.tranId, 'IR000123');
  f.settings.enabled = false;
  assert.deepEqual(await adapter.transform(f.fixture.step()), { id: 123 });
  assert.deepEqual(calls, ['native', 'native']);
});
