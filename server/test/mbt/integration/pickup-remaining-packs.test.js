import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import { confirmCustomerPickupLine, getDeliveryOrder, recordCustomerPickupLoad } from '../../../src/delivery-repository.js';
import { seedOperatorPickup } from '../../support/operator-ui-enhancements-fixture.mjs';

after(closeDb);

async function scenario(run) {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const f = await seedOperatorPickup({ quantity: 343 });
      await query(`UPDATE sales_order_lines SET pallet_qty=4, piece_qty=55, to_plt=72,
        pack_quantity_source='netsuite_manual' WHERE id=$1`, [f.lineId]);
      await run(f);
    });
  } finally { await rollback.rollback(); }
}

const photos = { photoDataUrls: ['data:image/png;base64,dGVzdA=='] };
const confirm = (f, values) => confirmCustomerPickupLine(f.orderId, f.lineId,
  { ...values, quantityMode: 'absolute' }, f.operator.id);

test('SOB122401 server rejects duplicated loose pieces after the first mixed pickup', async () => scenario(async f => {
  await confirm(f, { pallets: 1, pieces: 55 });
  const first = await recordCustomerPickupLoad(f.orderId, f.operator.id, photos);
  assert.equal(first.loaded.salesQuantity, 127);
  assert.equal(first.pickupStatus, 'partial_loaded');
  // A browser that still has the old calculation must not save 216 extra loose pieces.
  await confirm(f, { pallets: 3, pieces: 216 });
  const draft = (await getDeliveryOrder(f.orderId)).lines.find(row => String(row.id) === f.lineId);
  assert.equal(Number(draft.packed_pallet_qty), 3);
  assert.equal(Number(draft.packed_piece_qty), 0);
  assert.equal(Number(draft.loaded_qty), 127);
  const second = await recordCustomerPickupLoad(f.orderId, f.operator.id, photos);
  assert.equal(second.loaded.pallets, 3);
  assert.equal(second.loaded.pieces, 0);
  assert.equal(second.loaded.salesQuantity, 216);
  assert.equal(second.pickupStatus, 'loaded');
  assert.equal(second.remainingLines, 0);
  const finished = (await getDeliveryOrder(f.orderId)).lines.find(row => String(row.id) === f.lineId);
  assert.equal(Number(finished.loaded_qty), 343);
  assert.equal(Number(finished.quantity), 343);
  assert.equal(Number(finished.pallet_qty), 4);
  assert.equal(Number(finished.piece_qty), 55);
}));

test('exhausted explicit layers and sections stay zero when confirming the remaining pallets', async () => scenario(async f => {
  for (const [field, conversion, unit, packed] of [
    ['layer_qty', 'to_lyr', 'layers', 'packed_layer_qty'],
    ['section_qty', 'to_sec', 'sections', 'packed_section_qty']
  ]) {
    await query(`UPDATE sales_order_lines SET quantity=425, pallet_qty=4, to_plt=100,
      piece_qty=0, layer_qty=0, section_qty=0, to_lyr=0, to_sec=0,
      packed_pallet_qty=0, packed_piece_qty=0, packed_layer_qty=0, packed_section_qty=0,
      loaded_qty=125, confirmed=false WHERE id=$1`, [f.lineId]);
    await query(`UPDATE sales_order_lines SET ${field}=5, ${conversion}=5 WHERE id=$1`, [f.lineId]);
    await confirm(f, { pallets: 3, [unit]: 60 });
    const saved = (await getDeliveryOrder(f.orderId)).lines.find(row => String(row.id) === f.lineId);
    assert.equal(Number(saved.packed_pallet_qty), 3);
    assert.equal(Number(saved[packed]), 0);
  }
}));
