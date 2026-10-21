import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture} from '../helpers/backorder-already-ordered.js';
import {createSalesStockRequest, cancelSalesStockRequest} from '../../../src/stock-request-repository.js';
import {createSpecialStockCase} from '../../../src/special-stock-request-repository.js';

test('all-status search includes completed requests, retains request type and Sales yard scope, and restores filtering when empty', async () => {
  const f = await fixture({sku: 88999121}), ids = [];
  try {
    await f.query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_on_hand,quantity_available,synced_at) VALUES(88999121,28,'2967',100,100,now()),(88999121,1,'3445',100,100,now())");
    const create = async yard => {
      const d = await createSalesStockRequest({destinationLocationId: yard, lines: [{itemId: 88999121, sourceLocationId: yard === 1 ? 28 : 1, salesQty: 2}]}, {operatorId: f.users.sales.id, authorizedDestinationLocationIds: [yard]});
      ids.push(d.id);
      await f.query('UPDATE sales_stock_requests SET request_ref=$2 WHERE id=$1', [d.id, `STREQ-SEARCH21-${d.id}`]);
      return d;
    };
    const active = await create(1), completed = await create(1), foreign = await create(28);
    await cancelSalesStockRequest(completed.id, {expectedRevision: completed.revision}, {operatorId: f.users.sales.id, authorizedDestinationLocationIds: [1]});
    const backorder = await f.create(1);
    await f.query('UPDATE sales_stock_requests SET request_ref=$2 WHERE id=$1', [backorder.id, `STREQ-SEARCH21-${backorder.id}`]);
    const special = await createSpecialStockCase({storeLocationId: 1, fulfillmentMethod: 'yard_pickup', inquiryDate: '2099-01-01', customerName: 'SEARCH21 Test customer', vendorName: 'SEARCH21 Test vendor', lines: [{productName: 'SEARCH21 Special material', quantity: 2, uom: 'SQFT', rate: 2, requiredDate: '2099-02-01'}]}, {operatorId: f.users.sales.id, authorizedStoreLocationIds: [1]});
    ids.push(special.id);
    const list = async (role, suffix) => {
      const r = await f.http(role, `/api/${role}/stock-requests?${suffix}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.requests.map(d => d.id);
    };
    const sales = await list('sales', 'search=SEARCH21&allStatuses=1&bucket=pending&status=pending&stage=new_enquiry');
    assert(sales.includes(active.id));
    assert(sales.includes(completed.id));
    assert(sales.includes(backorder.id));
    assert(!sales.includes(foreign.id));
    assert(!sales.includes(special.id));
    assert.deepEqual(await list('sales', 'search=SEARCH21&allStatuses=1&type=backorder&stage=completed'), [backorder.id]);
    const scoped = await list('sales', 'search=SEARCH21&bucket=pending');
    assert(scoped.includes(active.id));
    assert(!scoped.includes(completed.id));
    const blank = await list('sales', 'search=%20%20&allStatuses=1&bucket=pending');
    assert(blank.includes(active.id));
    assert(!blank.includes(completed.id));
    const scm = await list('scm', 'search=SEARCH21&allStatuses=1&queue=pending_to&stage=completed');
    for (const d of [active, completed, foreign, backorder]) assert(scm.includes(d.id));
    assert(!scm.includes(special.id));
    assert.deepEqual(await list('scm', 'search=SEARCH21&allStatuses=1&queue=closed&type=backorder&stage=completed'), [backorder.id]);
    assert(!(await list('scm', 'search=%20%20&allStatuses=1&queue=pending_to')).includes(active.id));
    const specialOnly = await f.http('sales', '/api/sales/special-stock-requests?search=SEARCH21&stages=');
    assert.equal(specialOnly.status, 200);
    assert.deepEqual(specialOnly.body.requests.map(d => d.id), [special.id]);
  } finally {
    try { await f.query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [ids]); }
    finally { await f.close(); }
  }
});
