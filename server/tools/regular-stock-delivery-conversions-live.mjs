import assert from 'node:assert/strict';
import {closeDb} from '../src/db.js';
import {calculateDeliveryStockRequest} from '../src/stock-request-repository.js';
import {fetchTransferOrderByIdFromNetSuite, fetchOperatorNetSuiteSourceItemLinesFromNetSuite} from '../src/netsuite.js';
import {withOperatorNetSuitePriority} from '../src/operator-netsuite-request-pool.js';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (new URL(url).pathname.includes('/record/v1/')) assert.equal(options.method || 'GET', 'GET', 'This check permits no NetSuite record writes');
  return originalFetch(url, options);
};
try {
  const [header, items] = await withOperatorNetSuitePriority(() => Promise.all([
    fetchTransferOrderByIdFromNetSuite(1032550), fetchOperatorNetSuiteSourceItemLinesFromNetSuite('TO', 1032550)
  ]));
  assert.equal(header.tranid, 'TOB01183');
  assert.equal(header.memo, 'SOB121863');
  assert.equal(Number(header.source_location_id), 1);
  assert.equal(Number(header.destination_location_id), 28);
  const material = items.find(line => Number(line.item.id) === 1189);
  assert.equal(items.length, 2);
  assert.equal(material.quantity, 160);
  const actual = ['custcol_plt', 'custcol_lyr', 'custcol_sec', 'custcol_pcs'].map(key => Number(material[key] || 0));
  assert.deepEqual(actual, [2, 0, 0, 40]);
  const calculation = await calculateDeliveryStockRequest({sourceLocationId: 1, destinationLocationId: 28}, [
    {remoteLineId: 5064228, itemId: 1189, quantity: 160, backorderedQuantity: 78, uom: 'PC'}
  ]);
  const line = calculation.lines[0];
  assert([160, 78].includes(line.salesQty));
  assert.equal(line.quantityBasis, line.salesQty === 160 ? 'whole_line' : 'backorder');
  assert.equal(line.toPlt, 60);
  assert.equal(line.toPcs, 1);
  const expected = [Math.floor(line.salesQty / 60), 0, 0, line.salesQty % 60];
  assert.deepEqual([line.pallets, line.layers, line.sections, line.pieces], expected);
  assert.equal(calculation.palletQuantity, Math.ceil(line.salesQty / 60));
  console.log(JSON.stringify({checkedAt: new Date().toISOString(), netSuiteOrderWrites: 0, transferOrderId: 1032550,
    transferOrderRef: header.tranid, salesOrderRef: header.memo, quantity: 160, PLT: 2, LYR: 0, SEC: 0, PCS: 40,
    officialPalletQuantity: 3, netSuiteColumnsManuallyCorrectedByUser: true,
    liveCalculation: {selectedQuantity: line.salesQty, quantityBasis: line.quantityBasis, PLT: line.pallets, LYR: line.layers,
      SEC: line.sections, PCS: line.pieces, officialPalletQuantity: calculation.palletQuantity},
    calculatedConversionMatchesSelectedQuantity: true}));
} finally {
  globalThis.fetch = originalFetch;
  await closeDb();
}
