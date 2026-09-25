import {readFileSync} from 'node:fs';
import {query} from '../src/db.js';
import {upsertSorItemMetadata} from '../src/sor-rental-repository.js';
if(process.env.MBT_TEST_ISOLATED!=='1' || !process.env.DATABASE_URL.endsWith('/mbt_test_file_188188188188_rollout')){
 throw new Error('The rollout rehearsal requires its own disposable database.');
}
const preflight=JSON.parse(readFileSync('test-artifacts/sor-rentals/live-preflight.json'));
await upsertSorItemMetadata(preflight.metadata);
for(const order of preflight.proposed){
 const id=98840000+Number(order.ref.slice(3));
 await query(`INSERT INTO sales_orders(netsuite_id,tranid,sales_order_type,netsuite_active,status_text,outbound_location,outbound_location_id,dispatch_address,customer,is_test_fixture)
 VALUES($1,$2,'Delivery',true,'Pending Fulfillment','Rental',50,$3,'Isolated SOR rollout customer',false) ON CONFLICT(netsuite_id) DO UPDATE SET is_test_fixture=false`,[id,order.ref,order.hasCustomerAddress?'77 Isolated Customer Road':'']);
 for(const [index,item] of order.items.entries()){
  await query('INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,item_type,quantity,netsuite_active) VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT DO NOTHING',[id,index+1,item.itemId,item.name,item.type,item.quantity]);
 }
}
const source=readFileSync('tools/sor-rentals-rollout.mjs','utf8').replace('/* SOR_MODE */ "check"',JSON.stringify('activate')).replaceAll("from '/app/","from 'file:///app/");
await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
