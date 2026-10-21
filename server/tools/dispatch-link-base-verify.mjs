import assert from 'node:assert/strict';
import { closeDb, query, withTransaction } from '../src/db.js';
import { getSalesOrderPoAllocationOptions } from '../src/dispatch-repository.js';
import { getDriverPlanRoutesForDate } from '../src/driver-repository.js';

try {
  const result=await withTransaction(async()=>{
    await query("SET TRANSACTION READ ONLY");await query("SET LOCAL statement_timeout='20s'");
    const plan=(await query('SELECT p.revision,s.trucks FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=363')).rows[0];
    const load=plan.trucks.flatMap(truck=>truck.loads||[]).find(load=>load.id==='T7-L1792353708578-e25b724de7272');
    assert.equal(load.start,'06:30');assert.equal(load.switchYard,'3445');
    const routes=(await getDriverPlanRoutesForDate('2026-10-19')).routes;
    const jobs=routes.find(route=>route.driverLogin==='sety').jobs.filter(job=>job.loadId===load.id);
    assert.equal(jobs[0].stopType,'travel');assert.equal(jobs[0].status,'complete');
    const physical=jobs.filter(job=>job.stopType!=='travel');
    assert.deepEqual(physical.map(job=>job.stopType),['pickup','dropoff','dropoff']);
    const pallets=job=>(job.orders||[]).flatMap(order=>order.items||[]).flatMap(item=>item.units||[])
      .filter(unit=>unit.unit==='PLT').reduce((sum,unit)=>sum+unit.value,0);
    assert.deepEqual(physical.map(pallets),[22,16,6]);
    assert.match(physical[1].address,/56 William Bartlett/u);assert.match(physical[2].address,/2967 Kennedy/u);
    assert.ok(physical[0].retainedPhotoCount>=5);
    assert.ok(physical[0].jobId.endsWith(':stop-78e5eb5b-7b31-424d-abb2-00042626f044'));
    const options=await getSalesOrderPoAllocationOptions('GOB-122755-122934',{planDate:'2026-10-19'});
    const material=options.salesLines.find(line=>Number(line.itemId)===10374);
    const count=options.salesLines.find(line=>Number(line.itemId)===1784);
    assert.equal(material.required.unit,'SQFT');assert.equal(material.allocated.salesQty,1673.6);
    assert.equal(count.required.unit,'EACH');assert.equal(count.allocated.salesQty,16);
    assert.equal(count.available.salesQty,0);assert.equal(count.available.pieces,0);
    const dao=(await query("SELECT id,status,job_details->>'address' AS address,jsonb_array_length(photo_data_urls) AS photos,started_at,completed_at FROM driver_job_records WHERE id IN (6768,6770) ORDER BY id")).rows;
    assert.deepEqual(dao.map(job=>job.status),['complete','complete']);assert.match(dao[0].address,/3445 Kennedy/u);
    assert.ok(dao[0].photos>=2&&dao[1].photos>=3);
    return {checkedAt:new Date().toISOString(),readOnly:true,revision:plan.revision,start:load.start,
      sety:physical.map(job=>({stopType:job.stopType,status:job.status,address:job.address,pallets:pallets(job),retainedPhotoCount:job.retainedPhotoCount})),
      linkedBaseQuantities:[{quantity:material.allocated.salesQty,unit:material.required.unit},{quantity:count.allocated.salesQty,unit:count.required.unit}],
      remainingTargetCount:count.available.salesQty,dao};
  });
  const response=await fetch('http://127.0.0.1:3000/dispatch.js');assert.ok(response.ok);
  const source=await response.text();assert.match(source,/Base qty \(\$\{unit\}\)/u);
  assert.match(source,/preserveActiveLink: options.refreshLinkModal !== true/u);
  console.log(JSON.stringify({...result,servedBaseQuantityUi:true,servedPopupStability:true},null,2));
} finally {await closeDb();}
