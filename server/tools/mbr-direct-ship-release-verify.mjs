// Run through stdin in the deployed application; every database read is read-only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access,readFile,stat} from 'node:fs/promises';
import {constants} from 'node:fs';

const {config}=await import('./src/config.js');
const {pool,query,withTransaction,closeDb}=await import('./src/db.js');
pool.options.options='-c default_transaction_read_only=on -c statement_timeout=15000 -c jit=off';
pool.options.max=1;
try {
  for(const [file,expected] of Object.entries(globalThis.expectedReleaseSourceHashes)) {
    assert.equal(createHash('sha256').update(await readFile('/app/'+file)).digest('hex'),expected,file);
  }
  assert.equal(config.mbr.enabled,true);
  assert.equal(new URL(config.appBaseUrl).protocol,'https:');
  await access('/app/data',constants.W_OK);
  let signingKeyPresent=false;
  try {
    const key=await stat('/app/data/.mbr-signing-link-key');
    assert.equal(key.mode&0o777,0o600);signingKeyPresent=true;
  } catch(error) {if(error.code!=='ENOENT') {throw error;}}
  const {getDeliveryOrder}=await import('./src/delivery-repository.js');
  const {reconcileLinkedDirectShipQuantities}=await import('./src/linked-direct-ship-sync-repository.js');
  const database=await withTransaction(async()=>{
    await query('SET TRANSACTION READ ONLY');
    const migrations=(await query("SELECT filename FROM schema_migrations WHERE filename=ANY($1::text[]) ORDER BY filename",
      [['285_mbr_contracts.sql','286_linked_direct_ship_quantity_sync.sql']])).rows.map(row=>row.filename);
    assert.deepEqual(migrations,['285_mbr_contracts.sql','286_linked_direct_ship_quantity_sync.sql']);
    const dependency=(await query('SELECT id,status,dependency_mode,sales_order_ref FROM order_dependencies WHERE id=279')).rows[0];
    assert.equal(dependency.dependency_mode,'direct_to_customer');
    const allocations=(await query(`SELECT id,item_id,item_name,unit,allocated_quantity,
      loaded_quantity,delivered_quantity,locally_received_quantity FROM order_dependency_lines WHERE dependency_id=279 ORDER BY id`)).rows;
    assert.deepEqual(allocations.map(line=>[Number(line.item_id),Number(line.allocated_quantity)]),[[1189,90],[3632,91.88],[1784,3]]);
    const orders=[];
    for(const id of ['1055868','GOA-10172-10173']) {
      const order=await getDeliveryOrder(id);
      assert.ok(order,id);
      const lines=order.lines.filter(line=>[1189,3632,1784].includes(Number(line.item_id))).map(line=>({
        itemId:Number(line.item_id),item:line.item_name,unit:line.unit,
        original:Number(line.original_quantity),directShip:Number(line.linked_direct_to_sales_qty),
        yardRequired:Number(line.operator_required_sales_qty),loaded:Number(line.loaded_qty||0),
        remaining:Math.max(0,Number(line.operator_required_sales_qty)-Number(line.loaded_qty||0)),
        noYardLoadRequired:Boolean(line.no_yard_load_required)}));
      assert.ok(lines.length>=2,id);
      for(const itemId of [1189,3632]) {
        const line=lines.find(value=>value.itemId===itemId);
        assert.ok(line,itemId);assert.equal(line.yardRequired,0);assert.equal(line.remaining,0);assert.equal(line.noYardLoadRequired,true);
      }
      if(id.startsWith('GOA')) {
        const pallet=lines.find(line=>line.itemId===1784);
        assert.ok(pallet);assert.equal(pallet.directShip,3);assert.equal(pallet.yardRequired,11);
        assert.equal(pallet.loaded,11);assert.equal(pallet.remaining,0);
      }
      orders.push({id,lines});
    }
    const preview=await reconcileLinkedDirectShipQuantities({transferOrderId:1055871,apply:false});
    assert.equal(preview.length,1);assert.equal(preview[0].changed,false);
    const repairAudit=(await query(`SELECT id,action,created_at,details->>'preservedExecutionHistory' AS preserved_history
      FROM delivery_audit_log WHERE action='netsuite.direct_ship.repaired' AND order_id=1055868
      AND details->>'dependencyId'='279' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.ok(repairAudit);assert.equal(repairAudit.preserved_history,'true');
    const mbrCounts=(await query(`SELECT (SELECT count(*)::integer FROM mbr_contracts) AS contracts,
      (SELECT count(*)::integer FROM operators WHERE 'mbr_sales'=ANY(roles)) AS mbr_sales_accounts`)).rows[0];
    return {migrations,dependency,allocations,orders,repairAudit,idempotentPreview:true,mbrCounts};
  },{rollback:true});
  const http=[];
  for(const [path,status] of [['/health',200],['/mbr/contracts',200],['/mbr/sign',200],
    ['/mbr/staff.js',200],['/mbr/customer.js',200],['/mbr/logo.png',200],
    ['/api/mbr/status',401],['/api/mbr/contracts',401],['/api/mbr/public/contract',404]]) {
    const response=await fetch('http://127.0.0.1:3000'+path,{signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,status,path);
    if(path.startsWith('/mbr/') || path.startsWith('/api/mbr/')) {
      assert.ok(response.headers.get('cache-control').includes('no-store'),path);
    }
    await response.arrayBuffer();
    http.push({path,status:response.status});
  }
  const publicUrl=config.appBaseUrl.replace(/\/$/u,'')+'/mbr/contracts';
  const publicResponse=await fetch(publicUrl,{signal:AbortSignal.timeout(15000)});
  assert.equal(publicResponse.status,200,publicUrl);
  assert.ok((await publicResponse.text()).includes('mbr-wrap'));
  console.log(JSON.stringify({verifiedAt:new Date().toISOString(),sourceHashesVerified:true,
    mbrEnabled:true,dataDirectoryWritable:true,signingKeyPresent,
    publicUrl,publicStatus:publicResponse.status,database,http}));
} finally {await closeDb();}
