import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {listAggregateRouting,saveAggregateRouting,aggregateRoutingIds} from '../../../src/mbt/aggregate-routing.js';
after(closeDb);
test('Aggregate Routing: seeded loose material IDs, searchable imported catalog and Admin-only optimistic changes',async()=>{
  const ids=await aggregateRoutingIds();
  assert.deepEqual([...ids].sort(),['9909','9910','9912','9913','9914','9915','9916','9917','9919','9921','9922']);
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit) VALUES (10233,'BulkBagGravel','Bulk bag gravel','EACH') ON CONFLICT(item_id) DO NOTHING");
  const listing=await listAggregateRouting({search:'BulkBag'});
  assert.equal(listing.items.length,1);assert.equal(listing.items[0].itemId,'10233');
  assert.equal(listing.items[0].binOnly,false);assert.equal(listing.items[0].unit,'EACH');
  const input={itemId:'10233',binOnly:true,expectedRevision:0,actor:{operatorId:'admin',roles:['admin']},
    idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID()};
  await assert.rejects(saveAggregateRouting({...input,actor:{operatorId:'dispatcher',roles:['dispatcher']}}),e=>e.status===403);
  const saved=await saveAggregateRouting(input);assert.equal(saved.body.binOnly,true);
  assert.ok((await aggregateRoutingIds()).has('10233'));
  const replay=await saveAggregateRouting(input);assert.equal(replay.replayed,true);
  await assert.rejects(saveAggregateRouting({...input,idempotencyKey:crypto.randomUUID(),binOnly:false}),e=>e.status===409);
  await query("UPDATE inventory_items SET display_name='Imported name changed' WHERE item_id=10233");
  assert.ok((await aggregateRoutingIds()).has('10233'));
  const current=(await listAggregateRouting({search:'10233'})).items[0];
  await saveAggregateRouting({...input,idempotencyKey:crypto.randomUUID(),expectedRevision:current.revision,binOnly:false});
  assert.equal((await aggregateRoutingIds()).has('10233'),false);
  await query("UPDATE inventory_items SET raw=' {\"isinactive\":\"T\"}'::jsonb WHERE item_id=10233");
  assert.equal((await listAggregateRouting({search:'10233'})).items[0].active,false);
});
