import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { query, withTransaction, closeDb } from './src/db.js';
import { getSpecialStockCase } from './src/special-stock-request-repository.js';
import { buildSpecialSalesOrderPayload } from './src/special-stock-request-netsuite.js';
import { readSpecialRestOrder, verifySpecialRestSalesOrder } from './src/special-stock-rest-orders.js';
import { config } from './src/config.js';
import { withOperatorNetSuitePriority } from './src/operator-netsuite-request-pool.js';

// Execute through stdin in /app. This diagnostic only reads application and NetSuite records.
const temporary = `/tmp/special-so-000030-readonly-${process.pid}.mjs`;
const source = readFileSync('/app/src/netsuite.js', 'utf8').replace(
  /((?:from\s+|import\s*\()\s*)(['"])(\.\.?\/[^'"]+)\2/g,
  (_, prefix, quote, relative) => `${prefix}${quote}${pathToFileURL(resolve('/app/src', relative)).href}${quote}`
);
writeFileSync(temporary, `${source}\nexport { netsuiteRest as diagnosticRest };\n`, { mode: 0o600 });
try {
  const ns = await import(pathToFileURL(temporary).href);
  const detail = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const result = await getSpecialStockCase(106, { audience: 'scm' });
    assert.equal(result.requestRef, 'SPREQ-000030');
    return result;
  });
  await withOperatorNetSuitePriority(async () => {
    const locations = await ns.resolveNetSuiteYardLocations([{ locationId: detail.operationalYardLocationId, code: detail.storeName }]);
    const resolved = await ns.resolveSpecialOrderUnitsFromNetSuite(detail.salesOrderLines);
    const payload = buildSpecialSalesOrderPayload({ caseId: detail.id, discountMode: detail.salesDiscountMode,
      netsuiteLocationId: locations[0].netsuiteLocationId, subsidiaryId: locations[0].subsidiaryId || config.specialStock.subsidiaryId,
      deliveryMethodId: config.specialStock.deliveryMethodId, pickupMethodId: config.specialStock.pickupMethodId,
      draft: { ...detail, customerId: detail.netsuiteCustomerId || detail.customerId, salesRepId: detail.netsuiteSalesRepId,
        materialLines: resolved.filter(line => !line.ancillary), ancillaryLines: resolved.filter(line => line.ancillary) } });
    let markers = await ns.findSpecialStockOrdersByMarkerFromNetSuite({ caseId: detail.id, orderKind: 'sales_order', entityId: detail.netsuiteCustomerId || detail.customerId });
    if (!markers.length) {
      markers = await ns.suiteqlAll("SELECT t.id,t.tranid,t.entity AS entity_id,t.location AS location_id,t.memo,t.externalid FROM transaction t WHERE t.type='SalesOrd' AND t.externalid='MBBS-SPECIAL-SO:106' ORDER BY t.id DESC");
    }
    if (!markers.length) {
      const recent = await ns.suiteqlAll("SELECT t.id,t.tranid,t.entity AS entity_id,t.memo,t.externalid FROM transaction t WHERE t.type='SalesOrd' AND t.entity=5409 AND t.trandate>=TO_DATE('2026-10-06','YYYY-MM-DD') ORDER BY t.id DESC");
      console.log(JSON.stringify({ foundMarkers: markers, recent, resolved: resolved.map(line => ({itemId:line.itemId,unitId:line.unitId ?? null,uom:line.uom})), entityId: detail.netsuiteCustomerId || detail.customerId }));
    }
    assert.equal(markers.length, 1, 'Expected one existing SO; do not create or change any order');
    const orderId = Number(markers[0].id);
    const transport = { rest: ns.diagnosticRest, queryAll: ns.suiteqlAll };
    const { snapshot, record } = await readSpecialRestOrder({ id: orderId, kind: 'sales_order' }, transport);
    const fields = (await import('./public/special-stock-line-details.js')).SPECIAL_PACK_FIELDS;
    const lines = payload.item.items.map((line, index) => {
      const actual = snapshot.lines[index];
      const expected = { itemId: Number(line.item.id), quantity: line.quantity, unitId: line.units == null ? null : Number(line.units),
        rate: String(line.rate), description: line.description, pack: Object.fromEntries(Object.entries(fields).map(([key, native]) => [key, Number(line[native] ?? 0)])) };
      const mismatch = Object.entries(expected).filter(([key, value]) => JSON.stringify(actual?.[key]) !== JSON.stringify(value)).map(([key]) => key);
      return { expected, actual, mismatch, originalUnitComparison: actual.unitId !== Number(line.units), rawUnits: record.item.items[index].units ?? null };
    });
    let verification;
    try { await verifySpecialRestSalesOrder(orderId, payload, transport); verification = { passed: true }; }
    catch (error) { verification = { passed: false, code: error.code, message: error.message }; }
    console.log(JSON.stringify({ at: new Date().toISOString(), requestRef: detail.requestRef, revision: detail.revision,
      operationId: detail.salesOrderOperationId, submissionStartedAt: detail.salesOrderSubmissionStartedAt,
      linkedOrderId: detail.salesOrderId, orderId, orderRef: record.tranId || markers[0].tranid,
      markerCount: markers.length, expectedHeader: { entity: payload.entity.id, location: payload.location.id,
        discountItem: payload.discountItem?.id || '', discountRate: payload.discountRate ?? '' },
      actualHeader: Object.fromEntries(['entity', 'location', 'discountItem', 'discountRate'].map(key => [key, snapshot.header[key]])),
      lineCount: snapshot.lines.length, lines, verification, applicationWrites: 0, netSuiteWrites: 0 }));
  });
} finally {
  unlinkSync(temporary);
  await closeDb();
}
