import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeDb, pool, query, withTransaction } from '../../../src/db.js';
import { submitReturnBatch, localStockReserved, syncReturnRecord, voidReturnRecord,
  saveReturnDraft, listReturnDrafts } from '../../../src/return-repository.js';
import { getOperatorNetSuitePostingPolicy } from '../../../src/operator-netsuite-posting-policy-repository.js';
import { fixture, submitInput, actor, reasonPhotos } from '../../support/return-batch-ra-fixture.js';

after(closeDb);
async function exchangeInput(quantity = 2) {
  const input = await submitInput({ quantity });
  return { ...input, returnMode: 'exchange', stockReturnType: 'quality', palletQuantity: 0,
    expectedPostingPolicies: { stock_exchange: await getOperatorNetSuitePostingPolicy({ functionKey: 'stock_exchange', locationId: 1 }) },
    lines: [{ sourceLineId: 99091703, salesQuantity: quantity, reasonId: 5, photos: reasonPhotos }] };
}
const submit = input => submitReturnBatch({ operatorId: actor, input, autoSync: false });

test('exchange admission persists its identity and shares the stock return quantity pool', async t => {
  await fixture(t, { enabled: false });
  const result = await submit(await exchangeInput(4));
  assert.equal(result.stockExchange.recordType, 'exchange');
  assert.equal(result.stockReturn, null);
  assert.equal(result.stockExchange.estimatedCredit, null);
  assert.equal((await localStockReserved([99091703])).get('99091703'), 4);
  await assert.rejects(submit(await submitInput({ quantity: 7 })), /remaining|reserved/i);
  const returned = await submit(await submitInput({ quantity: 6 }));
  assert.equal(returned.stockReturn.recordType, 'stock');
  assert.equal((await localStockReserved([99091703])).get('99091703'), 10);
});

test('exchange rejects normal returns, GD, unsupported yards and pallet mixtures', async t => {
  await fixture(t, { enabled: false });
  const input = await exchangeInput();
  await assert.rejects(submit({ ...input, stockReturnType: 'normal' }), /quality|R1.R5/i);
  await assert.rejects(submit({ ...input, lines: [{ ...input.lines[0], reasonId: 10 }] }), /R1.R5/i);
  await assert.rejects(submit({ ...input, receivingLocationId: 15 }), /3445|2967|150|yard/i);
  await assert.rejects(submit({ ...input, palletQuantity: 1 }), /pallet/i);
  await assert.rejects(submit({ ...input, lines: [] }), /exchange|stock|quantity/i);
});

test('an order placed at 2967 can be exchanged at 3445 while its stock return stays at 2967', async t => {
  const { remoteLines } = await fixture(t, { enabled: false });
  Object.assign(remoteLines[0], { tranid: 'SOA99091700', ordering_location_id: '28', line_location_id: 28 });
  const prior = (await query('SELECT allow_cross_yard_returns FROM return_yard_settings WHERE location_id=1')).rows[0];
  await query('UPDATE return_yard_settings SET allow_cross_yard_returns=false WHERE location_id=1');
  t.after(() => query('UPDATE return_yard_settings SET allow_cross_yard_returns=$1 WHERE location_id=1', [prior.allow_cross_yard_returns]));
  await assert.rejects(submit(await submitInput({ quantity: 1 })), error => error.code === 'CROSS_YARD_RETURN_BLOCKED');
  const result = await submit(await exchangeInput(2));
  assert.equal(result.stockExchange.recordType, 'exchange');
  const batch = await query('SELECT receiving_location_id FROM return_batches WHERE id=$1', [result.stockExchange.batchId]);
  assert.equal(Number(batch.rows[0].receiving_location_id), 1);
  assert.equal((await localStockReserved([99091703])).get('99091703'), 2);
});

test('concurrent return and exchange admissions cannot spend the same remaining quantity', async t => {
  await fixture(t, { enabled: false });
  const results = await Promise.allSettled([submit(await exchangeInput(7)), submit(await submitInput({ quantity: 7 }))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await localStockReserved([99091703])).get('99091703'), 7);
});

test('exchange draft is resumable without reserving; submission retry and void preserve balances', async t => {
  await fixture(t, { enabled: false });
  const input = await exchangeInput();
  const draft = await saveReturnDraft({ operatorId: actor, input: { ...input, draftType: 'exchange' } });
  assert.equal(draft.type, 'exchange');
  assert.equal((await listReturnDrafts({ operatorId: actor }))[0].returnMode, 'exchange');
  assert.equal((await localStockReserved([99091703])).get('99091703') || 0, 0);
  const result = await submit({ ...input, draftId: draft.id });
  const replay = await submit(input);
  assert.equal(replay.stockExchange.id, result.stockExchange.id);
  await voidReturnRecord({ recordId: result.stockExchange.id, reason: 'Duplicate physical entry', actorOperatorId: actor });
  assert.equal((await localStockReserved([99091703])).get('99091703') || 0, 0);
  await assert.rejects(syncReturnRecord({ recordId: result.stockExchange.id }), /void|accepted|locally|disabled/i);
  assert.equal((await query('SELECT count(*)::int n FROM return_batch_authorizations WHERE batch_id=$1', [result.stockExchange.batchId])).rows[0].n, 0);
});

async function postingFixture(t) {
  await fixture(t, { enabled: false });
  await query("DELETE FROM return_exchange_months WHERE id NOT IN (SELECT month_id FROM return_exchange_postings)");
  await query("UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key='operator_netsuite_stock_exchange_it_3445'");
  t.after(() => query("UPDATE mbt_feature_flags SET enabled=false,revision=revision+1 WHERE flag_key='operator_netsuite_stock_exchange_it_3445'"));
  const records = new Map(), writes = [], control = {};
  const remote = {
    directory: async () => [{ id:1, name:'3445', subsidiary:1 }, { id:9, parent:1, name:'3445 Return', subsidiary:1 }],
    get: async id => { if (control.hide) {throw new Error('read unavailable');} return structuredClone(records.get(Number(id))); },
    findExternal: async externalId => control.hide ? null : structuredClone([...records.values()].find(r => r.externalId === externalId) || null),
    findMonthly: async () => control.hide ? [] : structuredClone([...records.values()]),
    create: async payload => {
      writes.push({ method:'POST', payload:structuredClone(payload) });
      const id=810000 + records.size;
      records.set(id,{...structuredClone(payload),id,tranId:`IT${id}`,inventory:{items:payload.inventory.items.map((line,i)=>({...line,line:i+1}))}});
      if (control.lost) {throw new Error('lost response');}
      return remote.get(id);
    },
    append: async (id,lines) => {
      writes.push({method:'PATCH',payload:structuredClone(lines)});
      const record=records.get(Number(id));
      record.inventory.items.push(...lines.map((line,i)=>({...line,line:record.inventory.items.length+i+1})));
      if(control.alter){control.alter(record);}
      if(control.lost){throw new Error('lost response');}
    }
  };
  return { remote, records, writes, control };
}
async function post(id,remote) {
  const {synchronizeStockExchange}=await import('../../../src/stock-exchange-service.js');
  return synchronizeStockExchange(id,{remote,actorOperatorId:actor});
}

test('monthly posting appends exact exchange quantity, units, reason and SO Position without credits', async t => {
  const {remote,records,writes}=await postingFixture(t);
  const one=await submit(await exchangeInput(2)),two=await submit(await exchangeInput(3));
  await Promise.all([post(one.stockExchange.id,remote),post(two.stockExchange.id,remote)]);
  assert.equal(records.size,1);
  const [record]=records.values();
  assert.match(record.memo,/^3445 20\d{2} [A-Z][a-z]{2} Exchange$/);
  assert.equal(record.location.id,'1');assert.equal(record.transferLocation.id,'9');
  assert.deepEqual(record.inventory.items.map(l=>l.adjustQtyBy).sort(),[2,3]);
  for(const line of record.inventory.items){assert.equal(line.units,'3');assert.equal(line.custcol_atlas_rc_so.id,'5');assert.equal(line.custcol_position,'SOB99091700');}
  assert.equal(writes.length,2);
  await post(one.stockExchange.id,remote);assert.equal(writes.length,2);
  assert.equal((await localStockReserved([99091703])).get('99091703'),5);
  const rows=await query("SELECT netsuite_stage,netsuite_transaction_id,netsuite_sync_status FROM return_records WHERE id=ANY($1::bigint[])",[[one.stockExchange.id,two.stockExchange.id]]);
  assert.ok(rows.rows.every(r=>r.netsuite_stage==='inventory_transfer'&&r.netsuite_sync_status==='succeeded'));
  assert.equal(new Set(rows.rows.map(r=>r.netsuite_transaction_id)).size,1);
});

test('lost create and append responses recover without a second inventory movement', async t => {
  const {remote,writes,control}=await postingFixture(t);
  const one=await submit(await exchangeInput(2));control.lost=true;
  await assert.rejects(post(one.stockExchange.id,remote),/lost response/);
  await post(one.stockExchange.id,remote);assert.equal(writes.length,1);
  const two=await submit(await exchangeInput(3));
  await assert.rejects(post(two.stockExchange.id,remote),/lost response/);
  await post(two.stockExchange.id,remote);assert.equal(writes.length,2);
});

test('uncertain posting blocks another exchange and voiding until recovery', async t => {
  const {remote,writes,control}=await postingFixture(t);
  const one=await submit(await exchangeInput(2)),two=await submit(await exchangeInput(3));control.lost=true;
  await assert.rejects(post(one.stockExchange.id,remote),/lost response/);control.hide=true;
  await assert.rejects(post(one.stockExchange.id,remote),/unknown|unconfirmed|unavailable/i);
  await assert.rejects(post(two.stockExchange.id,remote),/reconcil|unconfirmed|unknown/i);
  await assert.rejects(voidReturnRecord({recordId:one.stockExchange.id,reason:'unsafe',actorOperatorId:actor}),/unconfirmed/i);
  assert.equal(writes.length,1);
});

test('readback mismatch preserves reservation and cannot trigger a duplicate append', async t => {
  const {remote,writes,control}=await postingFixture(t);
  const one=await submit(await exchangeInput(2));await post(one.stockExchange.id,remote);
  const two=await submit(await exchangeInput(3));control.alter=record=>{record.inventory.items.at(-1).custcol_position='SOB999';};
  await assert.rejects(post(two.stockExchange.id,remote),/confirm|differ|mismatch/i);
  await assert.rejects(post(two.stockExchange.id,remote),/confirm|differ|mismatch/i);
  assert.equal(writes.length,2);
  assert.equal((await localStockReserved([99091703])).get('99091703'),5);
});

test('real HTTP submission and history expose exchange identity and enforce yard access', async t => {
  const nativeFetch=globalThis.fetch;
  await fixture(t,{enabled:false});
  const {app}=await import('../../../src/server.js');
  const {createHash}=await import('node:crypto');
  const token='synthetic-exchange-http-session';
  await query("INSERT INTO operator_sessions(token_hash,operator_id,expires_at) VALUES($1,$2,now()+interval '1 hour') ON CONFLICT(token_hash) DO NOTHING",
    [createHash('sha256').update(token).digest('hex'),actor]);
  const server=app.listen(0,'127.0.0.1');
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  await new Promise(resolve=>server.once('listening',resolve));
  const call=(path,method='GET',body)=>nativeFetch(`http://127.0.0.1:${server.address().port}${path}`,{
    method,headers:{authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const response=await call('/api/returns/submit','POST',await exchangeInput(2));
  assert.equal(response.status,201);
  const result=await response.json();assert.equal(result.stockExchange.recordType,'exchange');
  const history=await (await call('/api/returns/operator/history?type=exchange')).json();
  assert.ok(history.records.some(r=>r.id===result.stockExchange.id));
  const invalid=await exchangeInput(2);invalid.receivingLocationId=15;
  assert.ok((await call('/api/returns/submit','POST',invalid)).status>=400);
});

test('multiple monthly matches and wrong destinations fail before any inventory write', async t => {
  const {remote,records,writes}=await postingFixture(t);
  const result=await submit(await exchangeInput());
  const intent=(await query('SELECT intent FROM return_exchange_postings WHERE record_id=$1',[result.stockExchange.id])).rows[0].intent;
  for(const id of [81,82]){records.set(id,{id,tranId:`IT${id}`,memo:intent.memo,tranDate:intent.date,
    location:{id:'1'},transferLocation:{id:'9'},inventory:{items:[]}});}
  await assert.rejects(post(result.stockExchange.id,remote),/Multiple/);assert.equal(writes.length,0);
  records.delete(82);records.get(81).transferLocation.id='39';
  await assert.rejects(post(result.stockExchange.id,remote),/locations/);assert.equal(writes.length,0);
});

test('definite rejection can retry; turning the posting gate off prevents new writes', async t => {
  const {remote,writes}=await postingFixture(t);
  const result=await submit(await exchangeInput());
  const create=remote.create;remote.create=async()=>{throw Object.assign(new Error('invalid quantity'),{status:400,netsuiteResponseReceived:true});};
  await assert.rejects(post(result.stockExchange.id,remote),/invalid quantity/);
  assert.equal((await query('SELECT safe_to_retry FROM return_exchange_postings WHERE record_id=$1',[result.stockExchange.id])).rows[0].safe_to_retry,true);
  remote.create=create;
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key='operator_netsuite_stock_exchange_it_3445'");
  await assert.rejects(post(result.stockExchange.id,remote),/disabled/);assert.equal(writes.length,0);
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='operator_netsuite_stock_exchange_it_3445'");
  await post(result.stockExchange.id,remote);assert.equal(writes.length,1);
});

test('automatic submission and scheduled recovery use the exchange adapter and never the RA path', async t => {
  const {remote,writes,control}=await postingFixture(t);
  const {stockExchangeNetSuite}=await import('../../../src/stock-exchange-netsuite.js');
  const {processPendingReturnSyncs}=await import('../../../src/return-repository.js');
  for(const [key,value] of Object.entries(remote)){t.mock.method(stockExchangeNetSuite,key,value);}
  control.lost=true;
  const result=await submitReturnBatch({operatorId:actor,input:await exchangeInput(2)});
  assert.equal(result.stockExchange.netSuiteSyncStatus,'failed');assert.equal(result.stockReturn,null);
  await processPendingReturnSyncs();
  assert.equal((await query('SELECT netsuite_sync_status,netsuite_stage FROM return_records WHERE id=$1',[result.stockExchange.id])).rows[0].netsuite_sync_status,'succeeded');
  assert.equal(writes.length,1);
});

test('exchange migration can be replayed and rolled back without changing existing return data', async t => {
  await fixture(t,{enabled:false});
  const result=await submit(await exchangeInput());
  const {readFileSync}=await import('node:fs');
  const sql=readFileSync('migrations/323_stock_exchange.sql','utf8');
  const snapshot=async()=>JSON.stringify((await query('SELECT * FROM return_records ORDER BY id')).rows);
  const before=await snapshot();
  await withTransaction(async()=>{await query(sql);assert.equal(await snapshot(),before);},{rollback:true});
  assert.equal(await snapshot(),before);
  await assert.rejects(query("UPDATE return_exchange_postings SET intent=intent || '{\"month\":\"2099-01\"}'::jsonb WHERE record_id=$1",[result.stockExchange.id]),/immutable/);
});

test('durable exchange confirmation survives a caller transaction rollback',async t=>{
  const {remote,writes}=await postingFixture(t);
  const result=await submit(await exchangeInput());
  await assert.rejects(withTransaction(async()=>{await post(result.stockExchange.id,remote);throw new Error('outer rollback');}),/outer rollback/);
  await post(result.stockExchange.id,remote);assert.equal(writes.length,1);
  assert.equal((await query('SELECT netsuite_sync_status FROM return_records WHERE id=$1',[result.stockExchange.id])).rows[0].netsuite_sync_status,'succeeded');
});

test('concurrent exchange posting completes when monthly waiters fill the connection pool',async t=>{
  const {remote,writes,records}=await postingFixture(t);
  const submissions=[];
  for(let i=0;i<pool.options.max;i++){submissions.push(await submit(await exchangeInput(0.5)));}
  const originalTimeout=pool.options.connectionTimeoutMillis;
  pool.options.connectionTimeoutMillis=1500;
  t.after(()=>{pool.options.connectionTimeoutMillis=originalTimeout;});
  const directory=remote.directory;
  let release;
  const barrier=new Promise(resolve=>{release=resolve;});
  remote.directory=async()=>{await barrier;await query('SELECT 1');return directory();};
  const results=Promise.allSettled(submissions.map(result=>post(result.stockExchange.id,remote)));
  try{
    const deadline=Date.now()+3000;
    while(Date.now()<deadline&&(pool.totalCount<pool.options.max||pool.idleCount>0)){
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  }finally{release();}
  const outcomes=await results;
  assert.deepEqual(outcomes.filter(outcome=>outcome.status==='rejected').map(outcome=>outcome.reason.message),[]);
  assert.equal(records.size,1);assert.equal(writes.length,submissions.length);
  assert.equal([...records.values()][0].inventory.items.reduce((sum,line)=>sum+line.adjustQtyBy,0),submissions.length*0.5);
});
