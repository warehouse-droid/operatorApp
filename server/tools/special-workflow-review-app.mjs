// Isolated review application. Directory fixtures only; requests are created by
// the browser. The simulated NetSuite boundary persists transactions and mirrors
// them just as an external NetSuite sync would. No production network access.
import { query, withTransaction } from '../src/db.js';
import { createOperator } from '../src/auth-repository.js';
import { configureSpecialStockReviewBoundary } from '../src/special-stock-request-service.js';
import { synchronizeSpecialDescriptions } from '../src/special-stock-netsuite-adapter.js';
if (process.env.MBT_TEST_ISOLATED !== '1' || process.env.NODE_ENV !== 'test' || !String(process.env.DATABASE_URL).includes('mbbs-special-review-db')) throw new Error('Review database required');
const password = 'SpecialReview-2026!'; // secret-scan: allow -- disposable account in the isolated review database only
for (const [name,role] of [['sales','sales'],['scm','scm'],['dispatch','dispatcher'],['operator','operator']]) {
  if (!(await query('SELECT id FROM operators WHERE username=$1', [`review-${name}`])).rowCount) {
    await createOperator({ username: `review-${name}`, displayName: `TEST Review ${name}`, password, role, yardLocationIds: [1,28,15,26], operatorYardLocationIds: [1,28,15,26] });
  }
}
await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
await query(`INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES
  (2055,'MBBS-Special Order','SQFT','{}',now()),(1784,'PALLET','EACH','{}',now()) ON CONFLICT DO NOTHING`);
await query(`INSERT INTO netsuite_customers(netsuite_id,entity_number,legal_name,display_name,currency,phone,active,source_modified_at,source_version,payload_hash)
  VALUES(8899100,'TEST-REVIEW','TEST Review Customer','TEST Review Customer','CAD','416-555-0100',true,now(),'review',repeat('d',64)) ON CONFLICT DO NOTHING`);
await query(`INSERT INTO dispatch_vendor_mappings(netsuite_vendor_id,netsuite_vendor_name,local_vendor,active)
  SELECT '8899200','TEST Review Vendor','TEST Review Vendor',true WHERE NOT EXISTS(SELECT 1 FROM dispatch_vendor_mappings WHERE netsuite_vendor_id='8899200')`);
await query(`CREATE TABLE IF NOT EXISTS special_review_remote_orders(id bigint GENERATED ALWAYS AS IDENTITY (START WITH 9900000) PRIMARY KEY, kind text NOT NULL, ref text, payload jsonb NOT NULL, created_at timestamptz DEFAULT now())`);
const units = { PC: 1, SQFT: 2, EACH: 3, BDL: 4, LNFT: 5, RL: 6 };
const unitName = number => Object.keys(units).find(key => units[key] === Number(number));
async function create(kind, payload) {
  return withTransaction(async () => {
    const inserted = await query('INSERT INTO special_review_remote_orders(kind,payload) VALUES($1,$2) RETURNING id',[kind,payload]);
    const id = Number(inserted.rows[0].id), ref = `TEST-${kind === 'sales_order' ? 'SO' : 'PO'}-${id}`;
    const remotePayload = { ...payload, item: { items: payload.item.items.map((line,index) => ({ ...line, line: index + 1, uniqueKey: id * 100 + index + 1 })) } };
    await query('UPDATE special_review_remote_orders SET ref=$2,payload=$3 WHERE id=$1',[id,ref,remotePayload]);
    const sales = kind === 'sales_order', table = sales ? 'sales_orders' : 'purchase_orders';
    if (sales) await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer_id,customer,status,status_text,order_location_id,order_location,outbound_location_id,outbound_location,delivery_method_id,sales_order_type,netsuite_active,synced_at,memo,trandate)
      VALUES($1,$2,$3,'TEST Review Customer','SalesOrd:B','Pending Fulfillment',1,'3445',1,'3445',$4,'SalesOrd',true,now(),$5,current_date)`,[id,ref,payload.entity.id,payload.custbody3?.id,payload.memo]);
    else await query(`INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,vendor,status,status_text,destination_location_id,destination_location,netsuite_active,synced_at,memo,trandate)
      VALUES($1,$2,$3,'TEST Review Vendor','PurchOrd:B','Pending Receipt',1,'3445',true,now(),$4,current_date)`,[id,ref,payload.entity.id,payload.memo]);
    for (const line of remotePayload.item.items) {
      const lineTable = sales ? 'sales_order_lines' : 'purchase_order_lines', fk = sales ? 'sales_order_id' : 'purchase_order_id';
      await query(`INSERT INTO ${lineTable}(${fk},line_id,item_id,item_name,sku,item_description,quantity,unit,netsuite_active,synced_at,location_id,location)
        VALUES($1,$2,$3,$4,$4,$5,$6,$7,true,now(),1,'3445')`, [id,line.uniqueKey,line.item.id,Number(line.item.id)===1784?'PALLET':'MBBS-Special Order',line.description,line.quantity,unitName(line.units?.id)]);
    }
    return { id, ref, table };
  });
}
async function remoteRest(path, options = {}) {
  const id = Number(path.match(/salesOrder\/(\d+)/)?.[1]);
  const rows = await query('SELECT payload FROM special_review_remote_orders WHERE id=$1',[id]);
  const payload = rows.rows[0]?.payload;
  if (!payload) throw new Error('Simulated SO missing');
  if (options.method === 'PATCH') {
    for (const patch of options.body.item.items) {
      const line = payload.item.items.find(line => line.line === patch.line);
      if (!line) throw new Error('Simulated line missing');
      line.description = patch.description;
    }
    await query('UPDATE special_review_remote_orders SET payload=$2 WHERE id=$1',[id,payload]);
  }
  return { data: payload };
}
configureSpecialStockReviewBoundary({
  config: { subsidiaryId: 2, pickupMethodId: 1, deliveryMethodId: 2 },
  resolveLocations: async () => [{ netsuiteLocationId: 1, subsidiaryId: 2 }],
  resolveOrderUnits: async lines => lines.map(line => {
    if (!units[line.uom]) throw new Error(`Unsupported test unit: ${line.uom}`);
    return { ...line, unitId: units[line.uom] };
  }),
  createSalesOrder: payload => create('sales_order',payload),
  createPurchaseOrder: payload => create('purchase_order',payload),
  transformEstimate: () => { throw new Error('Estimate transforms are not simulated in this review.'); },
  findMarkerOrders: async ({caseId,orderKind}) => {
    const marker = `MBBS-SPECIAL-${orderKind === 'sales_order' ? 'SO' : 'PO'}:${caseId}`;
    return (await query("SELECT id,ref AS tranid,payload->'entity'->>'id' AS entity_id,payload->'location'->>'id' AS location_id FROM special_review_remote_orders WHERE kind=$1 AND payload->>'memo' LIKE $2",[orderKind,`%${marker}%`])).rows;
  },
  fetchSalesOrderReference: async id => ({ ...(await query('SELECT ref AS tranid FROM special_review_remote_orders WHERE id=$1',[id])).rows[0], status_text: 'Pending Fulfillment' }),
  fetchPurchaseOrderReference: async id => ({ ...(await query('SELECT ref AS tranid FROM special_review_remote_orders WHERE id=$1',[id])).rows[0], status_text: 'Pending Receipt' }),
  synchronizeSalesDescriptions: input => synchronizeSpecialDescriptions(input, { rest: remoteRest, queryAll: async () => {
    const payload = (await query('SELECT payload FROM special_review_remote_orders WHERE id=$1',[input.salesOrderId])).rows[0].payload;
    return payload.item.items.map(line => ({ uniquekey: line.uniqueKey, rest_line_id: line.line, item: line.item.id }));
  } })
});
const { app } = await import('../src/server.js');
app.listen(3000,'0.0.0.0',() => console.log('Special workflow review listening on 3000. NetSuite is simulated.'));
