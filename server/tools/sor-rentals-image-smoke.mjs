import assert from 'node:assert/strict';
import {app} from '/app/src/server.js';
import {closeDb} from '/app/src/db.js';
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
try {
 const base=`http://127.0.0.1:${server.address().port}`;
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 assert.equal((await fetch(base+'/api/admin/sor-auto-returns/settings')).status,401);
 const admin=await (await fetch(base+'/admin/sor-auto-returns')).text();assert.ok(admin.includes('/sor-admin.js?v=20260924-sor-v1'));
 const driver=await (await fetch(base+'/driver')).text();assert.ok(driver.includes('/sor-signature.js?v=20260924-sor-v1'));
 console.log(JSON.stringify({passed:true,node:process.version,health:200,anonymousAdmin:401,adminShell:true,driverShell:true}));
} finally {await new Promise(resolve=>server.close(resolve));await closeDb();}
