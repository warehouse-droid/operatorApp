import assert from 'node:assert/strict';
import {createDeliveryRequestService} from '../src/delivery-request-repository.js';
import {query,withTransaction,closeDb} from '../src/db.js';

try {
  const targets=await query(`SELECT request.id,request.requesting_yard_location_id FROM delivery_requests request
    WHERE request.status='confirmed' AND EXISTS (SELECT 1 FROM delivery_request_events event
      WHERE event.request_id=request.id AND event.message<>'') ORDER BY request.updated_at DESC LIMIT 3`);
  const service=createDeliveryRequestService();let checked=0,messages=0,history=0;
  for(const target of targets.rows) {
    await withTransaction(async()=>{
      const before=await query('SELECT revision,updated_at FROM delivery_requests WHERE id=$1 FOR UPDATE',[target.id]);
      const count=await query('SELECT count(*)::int AS count FROM delivery_request_events WHERE request_id=$1',[target.id]);
      const row=await service.get(target.id,{id:'release-read-only-check',role:'sales',yardLocationIds:[target.requesting_yard_location_id]},'sales');
      assert.ok(row.conversation.every(event=>['sales','dispatch'].includes(event.audience) && event.message.trim()));
      assert.ok(row.conversation.every(event=>!['instructions','remind','expire'].includes(event.action)));
      const after=await query('SELECT revision,updated_at FROM delivery_requests WHERE id=$1',[target.id]);
      assert.deepEqual(after.rows,before.rows);
      assert.equal((await query('SELECT count(*)::int AS count FROM delivery_request_events WHERE request_id=$1',[target.id])).rows[0].count,count.rows[0].count);
      checked++;messages+=row.conversation.length;history+=row.history.length;
    });
  }
  assert.ok(checked>0,'Existing confirmed requests must be available for the read-only verification');
  console.log(JSON.stringify({readOnly:true,requestsChecked:checked,humanMessages:messages,historyEntries:history,auditRowsPreserved:true}));
} finally {await closeDb();}
