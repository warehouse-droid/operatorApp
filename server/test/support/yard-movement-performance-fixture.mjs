import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query} from '../../src/db.js';
import {createOperator,loginOperator} from '../../src/auth-repository.js';

export async function yardPerformanceFixture({noise=true}={}) {
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
  const prefix='PERF-'+crypto.randomUUID(), base=9_400_000_000+crypto.randomInt(100_000_000);
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto'}).format(new Date());
  const refs=[`SOB-${prefix}-A`,`SOB-${prefix}-B`], ids=[base,base+1];
  const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8iQAAAAASUVORK5CYII=';
  for(let i=0;i<2;i++) {
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,outbound_location_id,outbound_location,netsuite_active,operator_status)
      VALUES($1,$2,'Performance Customer',1,'3445',true,'loaded')`,[ids[i],refs[i]]);
    await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_description,quantity,loaded_qty,loaded_uom,unit)
      VALUES($1,1,$1,'Performance Product',$2,'Performance item',4,4,'PCS','PCS')`,[ids[i],prefix]);
    await query(`INSERT INTO operator_load_records(order_id,order_ref,order_family,load_type,line_snapshot,photo_data_urls,created_at)
      VALUES($1,$2,'sales_order','sales_order_delivery_load','[]',$3,$4)`,[ids[i],refs[i],JSON.stringify([photo]),day+'T12:00:00Z']);
  }
  await query(`INSERT INTO driver_job_records(job_id,plan_date,driver_login,truck_id,truck_plate,load_id,load_name,stop_id,stop_type,order_refs,photo_data_urls,status,started_at,job_details)
    VALUES($1,$2,'perf-driver','PERF','PERF','PERF','PERF','PERF','dropoff',$3,$4,'in_progress',$5,'{"notes":"Preserved detail"}')`,
  [prefix,day,JSON.stringify(['  '+refs[0].toLowerCase()+'  ']),JSON.stringify([photo]),day+'T12:30:00Z']);
  if(noise) {
    await query(`INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,vendor,destination_location_id,destination_location)
      SELECT $1::bigint+g,$2||'-PO-'||g,$2||'-ALIAS-'||g,'Noise Vendor',28,'2967' FROM generate_series(1,5000) g`,[base+10,prefix]);
    await query(`INSERT INTO driver_job_records(job_id,plan_date,driver_login,truck_id,truck_plate,load_id,load_name,stop_id,stop_type,order_refs,photo_data_urls,status,started_at,job_details)
      SELECT $1||'-driver-'||g,$2::date,'perf-noise','NOISE','NOISE','NOISE','NOISE','NOISE','dropoff',
        jsonb_build_array($1||'-ALIAS-'||g),'[]','in_progress',$3::timestamptz,jsonb_build_object('notes',repeat('noise ',200)) FROM generate_series(1,400) g`,[prefix,day,day+'T10:00:00Z']);
    await query('ANALYZE purchase_orders');await query('ANALYZE driver_job_records');
  }
  const sessions={};
  for(const [surface,role] of [['control','yard_manager'],['sales','sales'],['dispatch','dispatcher']]) {
    const username=crypto.randomUUID(),password=crypto.randomUUID();
    await createOperator({username,password,displayName:'Performance '+surface,role,yardLocationIds:[1],operatorYardLocationIds:[1]});
    sessions[surface]=await loginOperator(username,password);
  }
  async function cleanup(){
    await query('DELETE FROM dispatch_sales_order_if_candidates WHERE operator_load_record_id IN (SELECT id FROM operator_load_records WHERE order_id=ANY($1::bigint[]))',[ids]);
    await query('DELETE FROM operator_load_records WHERE order_id=ANY($1::bigint[])',[ids]);
    await query('DELETE FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[])',[ids]);
    await query('DELETE FROM sales_orders WHERE netsuite_id=ANY($1::bigint[])',[ids]);
    await query("DELETE FROM driver_job_records WHERE job_id=$1 OR job_id LIKE $1||'-driver-%'",[prefix]);
    await query('DELETE FROM purchase_orders WHERE netsuite_id>$1 AND netsuite_id<=$2',[base+10,base+5010]);
    const operators=Object.values(sessions).map(session=>session.operator.id);
    await query('DELETE FROM operator_sessions WHERE operator_id=ANY($1::text[])',[operators]);
    await query('DELETE FROM operators WHERE id=ANY($1::text[])',[operators]);
  }
  return {prefix,ids,refs,day,photo,sessions,cleanup,range:{from:'2000-01-01',to:'2099-12-31'}};
}
