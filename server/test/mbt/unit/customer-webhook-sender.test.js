import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../../netsuite-customer-webhook-user-event.js', import.meta.url), 'utf8');
function harness({ fields = {}, parameters = {}, responseCode = 200, transportError = false } = {}) {
  const requests = [], logs = [], loads = [];
  const values = { entityid: 'C123', companyname: 'Example Customer', firstname: '', middlename: '', lastname: '',
    stage: 'CUSTOMER', currency: '1', lastmodifieddate: new Date('2026-10-01T12:00:00.000Z'),
    isinactive: false, email: 'fixture@example.invalid', phone: '5550101234', terms: '3',
    taxitem: '', creditholdoverride: 'AUTO', subsidiary: '1', ...fields };
  const customer = { id: 123, getValue: ({ fieldId }) => values[fieldId] ?? '',
    getText: ({ fieldId }) => ({ subsidiary: 'Test Subsidiary', terms: 'Net 30' }[fieldId] || ''),
    getLineCount: () => 1,
    getSublistValue: ({ fieldId }) => ({ internalid: '4', label: 'Main', defaultshipping: true, defaultbilling: true }[fieldId] || ''),
    getSublistSubrecord: () => ({ getValue: ({ fieldId }) => ({ addr1: '1 Test Street', city: 'Testville', country: 'CA' }[fieldId] || '') })
  };
  const params = { custscript_mbbs_customer_webhook_url: 'https://app.example.invalid/api/webhooks/netsuite/customer',
    custscript_mbbs_customer_webhook_secret: 'sender-fixture-secret', ...parameters };
  const modules = {
    'N/record': { Type: { CUSTOMER: 'customer', CURRENCY: 'currency' }, load: options => {
      loads.push(options);
      return options.type === 'currency' ? { getValue: () => 'CAD' } : customer;
    } },
    'N/runtime': { accountId: 'CUSTOMER_WEBHOOK_TEST', getCurrentScript: () => ({ getParameter: ({ name }) => params[name] || '' }) },
    'N/https': { post: options => { requests.push(options); if (transportError) { throw new Error('sensitive body sender-fixture-secret'); } return { code: responseCode, body: 'sensitive body sender-fixture-secret' }; } },
    'N/log': { error: value => logs.push(value), audit: value => logs.push(value) }
  };
  let script;
  vm.runInNewContext(source, { define: (names, factory) => { script = factory(...names.map(name => modules[name])); }, Date });
  return { requests, logs, loads, run: (type = 'create') => script.afterSubmit({ type, newRecord: { id: 123, type: 'customer' } }) };
}
for (const eventType of ['create', 'edit', 'xedit']) {
  test(`sender loads full customer and sends authenticated snapshot for ${eventType}`, () => {
    const h = harness();
    h.run(eventType);
    assert.equal(h.loads[0].type, 'customer');
    assert.equal(h.loads[0].id, 123);
    assert.equal(h.requests.length, 1);
    const request = h.requests[0], body = JSON.parse(request.body);
    assert.equal(request.headers['x-mbbs-webhook-secret'], 'sender-fixture-secret');
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.equal(body.schemaVersion, 'netsuite-customer/v1');
    assert.equal(body.accountId, 'CUSTOMER_WEBHOOK_TEST');
    assert.equal(body.eventType, eventType);
    assert.equal(body.customer.currency, 'CAD');
    assert.equal(body.customer.entityNumber, 'C123');
    assert.equal(body.customer.legalName, 'Example Customer');
    assert.equal(body.customer.sourceModifiedAt, '2026-10-01T12:00:00.000Z');
    assert.equal(body.customer.addresses[0].addressLine1, '1 Test Street');
    assert.equal(body.customer.subsidiaries[0].netsuiteId, '1');
    assert.equal(JSON.stringify(h.logs).includes('sender-fixture-secret'), false);
  });
}
test('sender handles individuals and inactive records', () => {
  const h = harness({ fields: { companyname: '', firstname: 'Ada', lastname: 'Customer', isinactive: 'T' } });
  h.run();
  const body = JSON.parse(h.requests[0].body);
  assert.equal(body.customer.legalName, 'Ada Customer');
  assert.equal(body.customer.active, false);
});
test('sender ignores deletes, leads and prospects', () => {
  for (const type of ['delete', 'view', 'approve']) {
    const h = harness(); h.run(type); assert.equal(h.requests.length, 0);
  }
  for (const stage of ['LEAD', 'PROSPECT']) {
    const h = harness({ fields: { stage } }); h.run(); assert.equal(h.requests.length, 0);
  }
});
test('missing or insecure configuration prevents transmission and is visible in logs', () => {
  for (const parameters of [
    { custscript_mbbs_customer_webhook_url: '' },
    { custscript_mbbs_customer_webhook_secret: '' },
    { custscript_mbbs_customer_webhook_url: 'http://app.example.invalid/hook' }
  ]) {
    const h = harness({ parameters });
    assert.doesNotThrow(() => h.run());
    assert.equal(h.requests.length, 0);
    assert.equal(h.logs.length, 1);
  }
});
test('response and transport failures log sanitized errors without blocking a saved customer', () => {
  for (const options of [{ responseCode: 401 }, { responseCode: 409 }, { responseCode: 503 }, { transportError: true }]) {
    const h = harness(options);
    assert.doesNotThrow(() => h.run());
    assert.equal(h.requests.length, 1);
    assert.equal(h.logs.length, 1);
    assert.match(h.logs[0].title, /failed|exception/i);
    assert.equal(JSON.stringify(h.logs).includes('sensitive body'), false);
    assert.equal(JSON.stringify(h.logs).includes('sender-fixture-secret'), false);
  }
});
