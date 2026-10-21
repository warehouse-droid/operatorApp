import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOperator} from '../../src/auth-repository.js';
import {query,closeDb} from '../../src/db.js';
import {createMbrRuntime} from '../../src/mbr/runtime.js';
import {fields} from './fixtures.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1','Disposable test database required.');
after(closeDb);

test('background expiration honors its independent flag and start/stop lifecycle',async t=>{
  const config={mbr:{enabled:false},appBaseUrl:'https://contracts.example.test'},errors=[];
  const runtime=createMbrRuntime({authenticate:(_req,_res,next)=>next(),config,dataDir:'/app/data',logger:{error:(...args)=>errors.push(args)}});
  t.after(()=>runtime.stop());
  const actor=await createOperator({username:'mbr-runtime-'+randomUUID(),displayName:'Runtime Sales',password:'mbr-runtime-tests',role:'mbr_sales'});
  const contract=await runtime.repo.create(actor,fields());
  await runtime.repo.link(actor,contract.id,1);
  await query('UPDATE mbr_contracts SET expires_at=clock_timestamp() WHERE id=$1',[contract.id]);
  await runtime.tick();assert.equal((await query('SELECT status FROM mbr_contracts WHERE id=$1',[contract.id])).rows[0].status,'pending');
  config.mbr.enabled=true;
  await Promise.all([runtime.tick(),runtime.tick()]);
  assert.equal((await query('SELECT status FROM mbr_contracts WHERE id=$1',[contract.id])).rows[0].status,'expired');
  runtime.start();runtime.start();runtime.stop();runtime.stop();assert.deepEqual(errors,[]);
});

test('invalid stored link key produces no broken invitation and no leaked error detail',async t=>{
  const {writeFile,rm}=await import('node:fs/promises');
  const directory='/app/data/mbr-bad-key';
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const {mkdir}=await import('node:fs/promises');await mkdir(directory,{recursive:true});
  await writeFile(directory+'/.mbr-signing-link-key','corrupt');
  const runtime=createMbrRuntime({authenticate:(_req,_res,next)=>next(),config:{mbr:{enabled:true},appBaseUrl:'https://contracts.example.test'},dataDir:directory});
  t.after(()=>runtime.stop());
  const actor=await createOperator({username:'mbr-corrupt-'+randomUUID(),displayName:'Runtime Sales',password:'mbr-runtime-tests',role:'mbr_sales'});
  const contract=await runtime.repo.create(actor,fields());
  await assert.rejects(runtime.repo.link(actor,contract.id,1),/key/i);
  const saved=await runtime.repo.get(contract.id);assert.equal(saved.issuedAt,null);assert.equal(saved.expiresAt,null);
  assert.equal((await query('SELECT count(*) FROM mbr_contract_links WHERE contract_id=$1',[contract.id])).rows[0].count,'0');
});
