import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fetchNetSuiteOrderPdf } from '../../../src/netsuite-order-pdf.js';

const actions = { sales_order: 'salesOrderPdf', purchase_order: 'purchaseOrderPdf' };
const response = (kind, id, buffer) => ({ ok: true, action: actions[kind], entityId: id,
  contentType: 'application/pdf', contentEncoding: 'base64', contentBase64: buffer.toString('base64'), filename: 'Native document.pdf' });

test('property: native PDF retrieval requests exact kind/ID and preserves every byte', async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(...Object.keys(actions)), fc.integer({ min: 1, max: 2147483647 }), fc.uint8Array({ maxLength: 500 }), async (kind, id, bytes) => {
    const buffer = Buffer.concat([Buffer.from('%PDF-1.7\n'), bytes]);
    const document = await fetchNetSuiteOrderPdf(kind, String(id), { restlet: async request => {
      assert.deepEqual(request, { action: actions[kind], entityId: id, includeContent: true });
      return response(kind, id, buffer);
    } });
    assert.deepEqual(document.buffer, buffer); assert.equal(document.contentType, 'application/pdf');
    assert.equal(document.filename, 'Native-document.pdf');
  }), { seed: 260927, numRuns: 60 });
});

test('property: wrong remote action or identity never returns a PDF', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1e8 }), fc.boolean(), async (id, wrongAction) => {
    const payload = response('sales_order', id, Buffer.from('%PDF-VALID'));
    if (wrongAction) payload.action = 'pickingTicket'; else payload.entityId = id + 1;
    await assert.rejects(fetchNetSuiteOrderPdf('sales_order', id, { restlet: async () => payload }), /identity/);
  }), { seed: 260928, numRuns: 40 });
});

test('native PDF boundary rejects unsupported, unsafe, corrupt and oversized responses', async () => {
  const restlet = async () => { throw Error('Must not contact NetSuite'); };
  for (const id of [null, '', 0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, 'x']) await assert.rejects(fetchNetSuiteOrderPdf('sales_order', id, { restlet }), /valid.*ID/);
  await assert.rejects(fetchNetSuiteOrderPdf('invoice', 1, { restlet }), /order kind/);
  const valid = response('sales_order', 1, Buffer.from('%PDF-VALID'));
  for (const patch of [{ ok: false }, { contentType: 'text/html' }, { contentEncoding: 'utf8' },
    { contentBase64: '' }, { contentBase64: '%%%invalid' }, { contentBase64: Buffer.from('html').toString('base64') },
    { contentBase64: Buffer.alloc(15728641, 'X').toString('base64') }]) {
    await assert.rejects(fetchNetSuiteOrderPdf('sales_order', 1, { restlet: async () => ({ ...valid, ...patch }) }), { status: 502 });
  }
  const fallback = await fetchNetSuiteOrderPdf('sales_order', 1, { restlet: async () => ({ ...valid, filename: null }) });
  assert.equal(fallback.filename, 'SO-1.pdf');
  await assert.rejects(fetchNetSuiteOrderPdf('sales_order', 1, { restlet: async () => { throw Error('RESTlet unavailable'); } }), /RESTlet unavailable/);
});

test('native PDF parser accepts a large bounded document without recursive-regex failure',async()=>{
  const bytes=Buffer.alloc(15*1024*1024,65);bytes.write('%PDF-');
  const document=await fetchNetSuiteOrderPdf('purchase_order',7,{restlet:async()=>response('purchase_order',7,bytes)});
  assert.deepEqual(document.buffer,bytes);
});

test('RESTlet prints SO and PO using native transaction forms with record-type verification', () => {
  let api; const calls = []; let failSearch = false, content = Buffer.from('%PDF-NATIVE').toString('base64');
  const modules = { 'N/error': { create: o => Object.assign(Error(o.message), { name: o.name }) }, 'N/log': { audit() {}, error() {} },
    'N/record': { load: () => { throw Error('This record has been locked by a user defined workflow.'); } },
    'N/search': { Type: { SALES_ORDER: 'salesorder', PURCHASE_ORDER: 'purchaseorder' }, create: o => { calls.push(['search',o]); return { run: () => ({getRange: () => failSearch ? [] : [{id:101}]}) }; } },
    'N/render': { PrintMode: { PDF: 'PDF' }, transaction: o => { calls.push(['transaction',o]); return { name: 'NetSuite.pdf', size: 10, getContents: () => content }; }, pickingTicket: () => { throw Error('Not an order PDF'); } },
    'N/runtime': { accountId: 'TEST_SB1', envType: 'SANDBOX', EnvType: { SANDBOX: 'SANDBOX' }, getCurrentUser: () => ({}), getCurrentScript: () => ({ getRemainingUsage: () => 4000 }) } };
  const restletFile = new URL('../../../netsuite-smart-scm-picking-ticket-restlet.js', import.meta.url);
  vm.runInNewContext(readFileSync(restletFile, 'utf8'), { define: (names, factory) => { api = factory(...names.map(n => modules[n])); } }, {filename:restletFile.pathname});
  assert.equal(api.get({ action: 'health' }).capabilities.salesOrderPdf, true);
  for (const [kind, type] of [['sales_order','salesorder'],['purchase_order','purchaseorder']]) {
    calls.length = 0;
    const pdf = api.post({ action: actions[kind], entityId: 101 });
    assert.equal(pdf.action, actions[kind]); assert.equal(pdf.contentBase64, content);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['search',{ type, filters:[['internalid','anyof',101],'and',['mainline','is','T']], columns:['internalid'] }],['transaction',{ entityId: 101, printMode: 'PDF' }]]);
    assert.equal(api.post({ action: actions[kind], entityId: 101, includeContent: false }).contentBase64, '');
  }
  failSearch = true; calls.length = 0;
  assert.throws(() => api.post({ action: 'salesOrderPdf', entityId: 101 })); assert.equal(calls.length, 1);
  failSearch = false; content = '';
  assert.throws(() => api.post({ action: 'salesOrderPdf', entityId: 101 }), { name: 'MBBS_EMPTY_PDF' });
  content = 'a'.repeat(9 * 1024 * 1024 + 1);
  assert.throws(() => api.post({ action: 'salesOrderPdf', entityId: 101 }), { name: 'MBBS_PDF_TOO_LARGE' });
});
