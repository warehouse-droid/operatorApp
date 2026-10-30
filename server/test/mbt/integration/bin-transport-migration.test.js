import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {query,withTransaction,closeDb} from '../../../src/db.js';
after(closeDb);
test('Transport migration: additive schema applies transactionally and rollback restores preexisting routing data',async()=>{
  await query("UPDATE mbt_aggregate_routing_items SET bin_only=false,revision=revision+1 WHERE item_id=9909");
  const before=(await query('SELECT * FROM mbt_aggregate_routing_items ORDER BY item_id')).rows;
  await withTransaction(async()=>{
    await query(`DROP TABLE mbt_transport_driver_events,mbt_transport_assignment_history,mbt_transport_steps,
      mbt_transport_delivery_links,mbt_transport_trips,mbt_transport_sources;
      DROP FUNCTION mbt_bin_only_source(jsonb); DROP TABLE mbt_aggregate_routing_items;`);
    await query(readFileSync('migrations/309_bin_transport_planning.sql','utf8'));
    assert.equal((await query('SELECT count(*)::int AS n FROM mbt_aggregate_routing_items WHERE bin_only')).rows[0].n,11);
    assert.equal((await query("SELECT mbt_bin_only_source('{\"id\":\"SO1\",\"items\":[{\"itemId\":9909}]}') AS routed")).rows[0].routed,true);
  },{rollback:true});
  assert.deepEqual((await query('SELECT * FROM mbt_aggregate_routing_items ORDER BY item_id')).rows,before);
});
