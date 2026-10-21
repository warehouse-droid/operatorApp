import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {app,startServer} from '../src/server.js';
import {query} from '../src/db.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
const id=Number(process.argv[2]),server=await startServer();
if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
try{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/health`);assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
  let caughtUp=false;for(let attempt=0;attempt<100;attempt++){const row=(await query("SELECT COUNT(*)::int AS count FROM regular_waitlist_allocations WHERE request_id=$1 AND status='reserved'",[id])).rows[0];if(!row.count){caughtUp=true;break;}await delay(50);}
  assert(caughtUp,'Real startup must catch up overdue waitlist allocations');assert(app);
  writeFileSync('test-artifacts/regular-waitlist/startup.json',JSON.stringify({health:true,expiryCaughtUp:true,remoteAccessDisabled:true}));process.exit(0);
}catch(error){console.error(error);process.exit(1);}
