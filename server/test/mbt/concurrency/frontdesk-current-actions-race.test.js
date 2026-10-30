import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import {rental} from '../support/bin-collection-request-fixtures.js';
import {nextVersion,addInput} from '../support/frontdesk-current-actions-fixtures.js';
import {previewFrontdeskChargeRequest} from '../../../src/mbt/customer-charge-request-service.js';
after(closeDb);
test('a new action waits for an in-flight activation and then reads the committed active version',{timeout:30000},async()=>{
  const f=await rental(false,'garbage');let release,locked;
  const releaseGate=new Promise(resolve=>{release=resolve;}),lockGate=new Promise(resolve=>{locked=resolve;});
  let preview;
  const activation=withTransaction(async()=>{
    await query('SELECT rate_card_id FROM mbt_rate_cards WHERE rate_card_id=$1 FOR UPDATE',[f.rateCardId]);
    const current=await nextVersion(f,38000);locked();await releaseGate;return current;
  });
  try {
    await lockGate;let finished=false;
    preview=previewFrontdeskChargeRequest(addInput(f)).finally(()=>{finished=true;});
    await delay(80);assert.equal(finished,false,'new work must not read the superseded version during activation');
    release();const current=await activation,result=await preview;
    assert.equal(result.body.request.rateCardVersionId,current);assert.equal(result.body.request.requiredDepositMinor,38000);
  } finally {release();await Promise.allSettled([activation,preview]);}
});
