import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createDeliveryRequestRouter} from '../../../src/delivery-request-router.js';
test('unexpected infrastructure failures reach error middleware with a private noncached response',async()=>{
  const app=express();let forwarded;
  app.use(createDeliveryRequestRouter({audience:'sales',service:{options:async()=>{throw new Error('database connection lost');}}}));
  app.use((error,_req,res,_next)=>{forwarded=error;res.status(503).json({error:'Temporarily unavailable'});});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/meta`);
    assert.equal(response.status,503);assert.equal(forwarded.message,'database connection lost');
    assert.match(response.headers.get('cache-control'),/private, no-store/);
    assert.deepEqual(await response.json(),{error:'Temporarily unavailable'});
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
