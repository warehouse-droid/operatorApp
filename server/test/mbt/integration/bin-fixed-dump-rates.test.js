import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {query,closeDb,withTransaction} from '../../../src/db.js';
import {config} from '../../../src/config.js';
import {correctFixedDumpRates} from '../../../tools/bin-fixed-dump-rates.mjs';
after(closeDb);

async function fixture() {
  config.mbt.enabled=true; config.mbtPhase3.masterDataEnabled=true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_master_data')");
  const versions={};
  for(const [code,amount] of [['SOIL',35000],['CONCRETE',30000],['DUMPGARBAGE',12000],['ASPHALT',null]]) {
    const material=crypto.randomUUID();
    await query(`INSERT INTO mbt_materials(material_id,material_code,display_name,created_by,updated_by)
      VALUES($1,$2,$2,'test','test') ON CONFLICT(material_code) DO NOTHING`,[material,code]);
    await query(`INSERT INTO mbt_local_item_settings
      SELECT (jsonb_populate_record(NULL::mbt_local_item_settings,to_jsonb(item)||jsonb_build_object('item_code',$1::text,
        'display_name',$1::text,'charge_basis',$2::text,'system_owned',false,'active',true))).* FROM mbt_local_item_settings item WHERE item_code='DUMP'
      ON CONFLICT(item_code) DO NOTHING`,[code,code==='DUMPGARBAGE'?'per_tonne':'per_bin']);
    if(amount===null) continue;
    const cardId=crypto.randomUUID(),versionId=crypto.randomUUID(); versions[code]=versionId;
    await query(`INSERT INTO mbt_rate_cards(rate_card_id,rate_card_code,display_name,currency,created_by,updated_by)
      VALUES($1,$2,$2,'CAD','test','test')`,[cardId,`TEST_${cardId}`]);
    await query(`INSERT INTO mbt_rate_card_versions(rate_card_version_id,rate_card_id,version_number,status,effective_from,created_by,updated_by)
      VALUES($1,$2,1,'draft','2020-01-01','test','test')`,[versionId,cardId]);
    await query(`INSERT INTO mbt_dump_tariffs(dump_tariff_id,rate_card_version_id,item_code,material_id,tariff_code,pricing_basis,unit_of_measure,amount_minor,currency,description)
      SELECT $1,$2,$3,material_id,'customer_dump',$4,$5,$6,'CAD','Test tariff' FROM mbt_materials WHERE material_code=$3`,
      [crypto.randomUUID(),versionId,code,code==='DUMPGARBAGE'?'per_weight':'per_quantity',code==='DUMPGARBAGE'?'TONNE':'BIN',amount]);
    await query("UPDATE mbt_rate_card_versions SET status='active',activated_at=now() WHERE rate_card_version_id=$1",[versionId]);
  }
  return {actor:{operatorId:'authorized-test-admin',roles:['admin']},idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),
    soilVersionId:versions.SOIL,concreteVersionId:versions.CONCRETE,garbageVersionId:versions.DUMPGARBAGE,asphaltCardCode:`ASPHALT_${crypto.randomUUID()}`};
}

test('rate correction versions Soil, adds Asphalt, retains Concrete and Garbage, replays once',async()=>{
  const input=await fixture();
  const result=await correctFixedDumpRates(input);
  for(const name of ['soil','concrete','asphalt']) assert.equal(result.body.after[name].graph.dumpTariffs[0].amountMinor,30000);
  assert.deepEqual(result.body.after.garbage,result.body.before.garbage);
  assert.deepEqual(result.body.after.concrete,result.body.before.concrete);
  assert.equal((await query('SELECT amount_minor FROM mbt_dump_tariffs WHERE rate_card_version_id=$1',[input.soilVersionId])).rows[0].amount_minor,'35000');
  assert.equal((await query('SELECT status FROM mbt_rate_card_versions WHERE rate_card_version_id=$1',[input.soilVersionId])).rows[0].status,'retired');
  assert.equal((await correctFixedDumpRates(input)).replayed,true);
});

test('rate correction rolls back Soil if Asphalt cannot be created and refuses changed input',async()=>{
  const input=await fixture();
  const before=(await query('SELECT * FROM mbt_rate_card_versions WHERE rate_card_version_id=$1',[input.soilVersionId])).rows[0];
  await assert.rejects(correctFixedDumpRates({...input,asphaltCardCode:''}));
  assert.deepEqual((await query('SELECT * FROM mbt_rate_card_versions WHERE rate_card_version_id=$1',[input.soilVersionId])).rows[0],before);
  await withTransaction(async()=>{
    const result=await correctFixedDumpRates(input); assert.equal(result.body.after.soil.graph.dumpTariffs[0].amountMinor,30000);
  },{rollback:true});
  assert.deepEqual((await query('SELECT * FROM mbt_rate_card_versions WHERE rate_card_version_id=$1',[input.soilVersionId])).rows[0],before);
});
