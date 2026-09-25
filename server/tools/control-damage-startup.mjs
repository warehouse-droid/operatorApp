// Real application startup in the network-isolated test environment only.
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {startServer} from '../src/server.js';
import {query} from '../src/db.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(config.netsuite.directAccessEnabled,false);
config.netsuite.directAccessEnabled=true;config.port=0;
const server=await startServer();
await new Promise(resolve=>server.listening?resolve():server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
assert.equal((await fetch(base+'/health')).status,200);
assert.equal((await fetch(base+'/api/control/damage/config')).status,401);
const before=(await query('SELECT id,status,attempt_count FROM inventory_damage_adjustments ORDER BY id')).rows;
await new Promise(resolve=>setTimeout(resolve,6500));
assert.deepEqual((await query('SELECT id,status,attempt_count FROM inventory_damage_adjustments ORDER BY id')).rows,before);
console.log(JSON.stringify({startupHealth:200,controlAuthentication:401,scheduledWorkersStarted:true,noUnrequestedAdjustments:true}));
server.close();process.exit(0);
