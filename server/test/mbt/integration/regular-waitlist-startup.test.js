import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {query,closeDb} from '../../../src/db.js';
import {createWaitlistFixture} from '../../support/regular-waitlist-fixture.mjs';
test('real server startup runs waitlist catch-up without posting NetSuite orders',async()=>{
  const f=await createWaitlistFixture(),s=await f.supply(),a=await s.demand(600);await f.allocate(s.pool,[[a,600]]);await s.demand(100);
  await query("UPDATE regular_waitlist_allocations SET allocated_at=now()-interval '4 hours' WHERE request_id=$1",[a.id]);
  const result=spawnSync(process.execPath,['tools/regular-waitlist-startup.mjs',String(a.id)],{env:{...process.env,PORT:'0'},encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.equal((await query("SELECT status FROM regular_waitlist_allocations WHERE request_id=$1",[a.id])).rows[0].status,'released');await closeDb();
});
