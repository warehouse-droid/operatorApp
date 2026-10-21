import assert from 'node:assert/strict';
import {query, withTransaction, closeDb} from '../src/db.js';
import {recordStockRequestEvent, getScmStockRequest} from '../src/stock-request-repository.js';
import {dependencyQuantityConversionDisplay} from '../src/order-dependency-quantity.js';
import {fetchTransferOrderByIdFromNetSuite, fetchOperatorNetSuiteSourceItemLinesFromNetSuite} from '../src/netsuite.js';

try {
  const [header, remoteLines] = await Promise.all([
    fetchTransferOrderByIdFromNetSuite(1032550), fetchOperatorNetSuiteSourceItemLinesFromNetSuite('TO', 1032550)
  ]);
  assert.equal(header.tranid, 'TOB01183');
  assert.equal(header.memo, 'SOB121863');
  assert.equal(Number(header.source_location_id), 1);
  assert.equal(Number(header.destination_location_id), 28);
  assert.equal(remoteLines.length, 2);
  const material = remoteLines.find(line => Number(line.item.id) === 1189);
  const pallet = remoteLines.find(line => Number(line.item.id) === 1784);
  assert.equal(material.quantity, 160);
  assert.equal(pallet.quantity, 3);
  const actual = ['custcol_plt', 'custcol_lyr', 'custcol_sec', 'custcol_pcs'].map(key => Number(material[key] || 0));
  assert.deepEqual(actual, [2, 0, 0, 40]);
  const result = await withTransaction(async () => {
    const operator = (await query("SELECT id FROM operators WHERE username='admin' AND active AND role='admin'")).rows[0];
    assert(operator);
    const request = (await query('SELECT * FROM sales_stock_requests WHERE id=93 FOR UPDATE')).rows[0];
    const transfer = (await query('SELECT * FROM sales_stock_transfers WHERE id=31 FOR UPDATE')).rows[0];
    assert.equal(Number(transfer.request_id), 93);
    assert.equal(Number(transfer.netsuite_transfer_order_id), 1032550);
    assert.equal(transfer.netsuite_transfer_order_ref, 'TOB01183');
    assert.equal(transfer.confirmation_status, 'complete');
    const requestLine = (await query('SELECT * FROM sales_stock_request_lines WHERE request_id=93 AND id=152 FOR UPDATE')).rows[0];
    const transferLines = (await query('SELECT * FROM sales_stock_transfer_lines WHERE transfer_id=31 FOR UPDATE')).rows;
    assert.equal(transferLines.length, 1);
    const transferLine = transferLines[0];
    assert.equal(Number(transferLine.request_line_id), 152);
    for (const line of [requestLine, transferLine]) {
      assert.equal(Number(line.item_id), 1189);
      assert.equal(Number(line.sales_qty), 160);
      assert.equal(line.sales_uom, 'PC');
      const calculated = dependencyQuantityConversionDisplay(Number(line.sales_qty), line);
      assert.deepEqual([calculated.palletQty, calculated.layerQty, calculated.sectionQty, calculated.pieceQty], actual);
      const before = ['pallet_qty', 'layer_qty', 'section_qty', 'piece_qty'].map(key => line[key] === null ? null : Number(line[key]));
      assert(before.every(value => value === null) || before.every((value, index) => value === actual[index]), 'Existing packing values conflict; stop for reconciliation');
    }
    const before = {request: [requestLine.pallet_qty, requestLine.layer_qty, requestLine.section_qty, requestLine.piece_qty],
      transfer: [transferLine.pallet_qty, transferLine.layer_qty, transferLine.section_qty, transferLine.piece_qty]};
    const changed = [...before.request, ...before.transfer].some(value => value === null);
    if (changed) {
      await query('UPDATE sales_stock_request_lines SET pallet_qty=$2,layer_qty=$3,section_qty=$4,piece_qty=$5,updated_at=now() WHERE id=$1', [152, ...actual]);
      await query('UPDATE sales_stock_transfer_lines SET pallet_qty=$2,layer_qty=$3,section_qty=$4,piece_qty=$5,updated_at=now() WHERE id=$1', [transferLine.id, ...actual]);
      await recordStockRequestEvent({requestId: 93, requestLineId: 152, transferId: 31, eventType: 'support_conversion_reconciled', actorId: operator.id,
        details: {source: 'User-authorized correction of missing TOB packing conversion fields', transferOrderId: 1032550,
          transferOrderRef: 'TOB01183', salesOrderRef: 'SOB121863', before, after: {PLT: 2, LYR: 0, SEC: 0, PCS: 40},
          netSuiteRecordWrites: 0, quantitiesAndExecutionStatePreserved: true}});
    }
    assert.equal((await query('SELECT status FROM sales_stock_request_lines WHERE id=152')).rows[0].status, requestLine.status);
    assert.deepEqual((await query('SELECT status,confirmation_status,revision,pallet_quantity FROM sales_stock_transfers WHERE id=31')).rows[0],
      {status: transfer.status, confirmation_status: transfer.confirmation_status, revision: transfer.revision, pallet_quantity: transfer.pallet_quantity});
    assert.equal((await query('SELECT revision FROM sales_stock_requests WHERE id=93')).rows[0].revision, request.revision);
    return {changed, before};
  });
  const saved = await getScmStockRequest(93);
  for (const line of [saved.lines.find(line => line.id === 152), saved.transfers.find(transfer => transfer.id === 31).lines[0]]) {
    assert.deepEqual([line.pallets, line.layers, line.sections, line.pieces], actual);
  }
  console.log(JSON.stringify({checkedAt: new Date().toISOString(), ...result, transferOrderId: 1032550, transferOrderRef: 'TOB01183',
    requestId: 93, transferId: 31, PLT: 2, LYR: 0, SEC: 0, PCS: 40, quantity: 160, officialPalletQuantity: 3,
    localAndNetSuiteMatch: true, netSuiteRecordWrites: 0, quantitiesAndExecutionStatePreserved: true}));
} finally {
  await closeDb();
}
