import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { beginRollbackContext, query, closeDb } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { buildSpecialSalesOrderPayload } from '../../../src/special-stock-request-netsuite.js';
const fields = ['palletQty', 'layerQty', 'sectionQty', 'pieceQty'];
const context = { operatorId: 'test-null-packs', authorizedStoreLocationIds: [1] };
after(closeDb);

test('request, saved SO draft, and outbound JSON retain SQL null packs through a real database workflow', async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const rollback = await beginRollbackContext();
  try { await rollback.run(async () => {
    await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('test-null-packs','test-null-packs','Test','hash','salt','sales',ARRAY['sales'],ARRAY[1]) ON CONFLICT DO NOTHING");
    await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()) ON CONFLICT DO NOTHING");
    await query("INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,active,source_modified_at,source_version,payload_hash) VALUES(8899801,'8899801','Test customer','Test customer','CAD',true,now(),'test',repeat('e',64)) ON CONFLICT DO NOTHING");
    for (const pack of [{}, { palletQty: '', layerQty: null, sectionQty: 0, pieceQty: '0.00' }, { palletQty: 1.5, layerQty: '2', sectionQty: 0, pieceQty: null }]) {
      const expected = fields.map(field => Number(pack[field]) > 0 ? Number(pack[field]) : null);
      let detail = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerId: 8899801, customerName: 'Test customer', vendorId: 8899200, vendorName: 'Test vendor', fulfillmentMethod: 'yard_pickup',
        lines: [{ productName: 'Stone', quantity: 2, uom: 'PCS', rate: 120, requiredDate: '2099-02-01', ...pack }] }, context);
      assert.deepEqual(fields.map(field => detail.lines[0][field]), expected);
      const row = (await query('SELECT pack_pallet_qty,pack_layer_qty,pack_section_qty,pack_piece_qty FROM sales_special_stock_lines WHERE id=$1', [detail.lines[0].id])).rows[0];
      assert.deepEqual(Object.values(row).map(value => value === null ? null : Number(value)), expected);
      detail = await repo.respondSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, supplyStatus: 'in_stock', availabilityMode: 'no_projection', vendorId: 8899200, vendorName: 'Test vendor', vendorYard: 'TEST' }, context);
      detail = await repo.decideSpecialStockLine(detail.id, detail.lines[0].id, { expectedRevision: detail.revision, decision: 'accepted' }, context);
      detail = await repo.saveSpecialSalesOrderDraft(detail.id, { expectedRevision: detail.revision, customerId: 8899801, operationalYardLocationId: 1, fulfillmentMethod: 'yard_pickup', palletTotal: 0,
        materialLines: [{ caseLineId: detail.lines[0].id, itemId: 2055, description: 'Stone', packageQuantity: 2, conversionToPc: 1, quantity: 2, uom: 'PC', rate: 120 }] }, context);
      assert.deepEqual(fields.map(field => detail.salesOrderLines[0][field]), expected);
      const payload = buildSpecialSalesOrderPayload({ caseId: detail.id, netsuiteLocationId: 1, pickupMethodId: 2,
        draft: { customerId: 8899801, fulfillmentMethod: 'yard_pickup', materialLines: detail.salesOrderLines } });
      const [sent] = JSON.parse(JSON.stringify(payload)).item.items;
      assert.deepEqual(['custcol_plt', 'custcol_lyr', 'custcol_sec', 'custcol_pcs'].map(field => sent[field]), expected);
      assert.equal(sent.quantity, 2); assert.equal(sent.rate, 120);
    }
  }); } finally { await rollback.rollback(); }
});
