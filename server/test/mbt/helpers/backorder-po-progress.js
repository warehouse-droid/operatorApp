import {fixture} from './backorder-already-ordered.js';

export async function poProgressFixture(sku) {
  const f=await fixture({sku}),poIds=[],planIds=[];let sequence=0;
  async function po({reference=null,status='Pending Receipt',active=true,native}={}) {
    const id=sku*100+(++sequence),ref=native || 'TEST-PO-PROGRESS-'+id;
    await f.query('INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,status_text,netsuite_active) VALUES($1,$2,$3,$4,$5)',[id,ref,reference,status,active]);
    poIds.push(id);return {id,ref};
  }
  async function plan(ref,{alias=ref,assigned=true,group=false,split=false,returnOnly=false,status='draft'}={}) {
    const row=(await f.query(`INSERT INTO dispatch_plans(plan_date,status)
      SELECT day::date,$1 FROM generate_series(DATE '2097-01-01',DATE '2097-12-31',INTERVAL '1 day') day
      WHERE NOT EXISTS(SELECT 1 FROM dispatch_plans p WHERE p.plan_date=day::date) ORDER BY day LIMIT 1 RETURNING id,plan_date::text`,[status])).rows[0];
    planIds.push(row.id);
    const order=split?{id:alias+'-S1',type:'PO',originalOrderId:alias}:{id:alias,type:'PO'};
    const scheduled=group?{id:'GOB-TEST-'+row.id,type:'PO',childOrders:[order.id],childOrderDetails:[order]}:order;
    const trucks=assigned?[{plate:'TEST-TRUCK',loads:[{name:'Load 1',returnOnly,stops:[{type:'pickup',orderId:scheduled.id}]}]}]:[];
    await f.query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')",[row.id,JSON.stringify([scheduled]),JSON.stringify(trucks)]);
    return {...row,trucks};
  }
  const alerts=async d=>(await f.http('sales','/api/sales/stock-requests/alerts')).body.requests.filter(row=>!d || row.id===d.id);
  const ack=(d,keys,role='sales',extra={})=>f.http(role,`/api/sales/stock-requests/${d.id}/decisions/read`,{eventId:d.manualDecisionEventId,poNoticeKeys:keys,...extra});
  const close=async()=>{await f.query('DELETE FROM dispatch_plans WHERE id=ANY($1::bigint[])',[planIds]);await f.query('DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])',[poIds]);await f.close();};
  return {...f,po,plan,alerts,ack,close};
}
