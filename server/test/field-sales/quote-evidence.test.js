import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {saveQuoteEvidence} from '../../src/field-sales/evidence.js';
import {customerFixture} from './customer-fixture.js';
after(closeDb);
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable database required.');}
test('Evidence is content checked, actor and revision bound, replayable, bounded and retained on acceptance',()=>withTransaction(async()=>{
 const f=await customerFixture();await f.cmd('quote.save',f.draft);
 const png=await sharp({create:{width:10,height:10,channels:3,background:'#667799'}}).png().toBuffer();
 const input={id:randomUUID(),revision:1,name:'Confirmation.png',base64:png.toString('base64')};
 const save=(p,actor=f.actor)=>saveQuoteEvidence(f.repo.db,actor,f.draft.id,p);
 assert.deepEqual(await save(input),{id:input.id});assert.deepEqual(await save(input),{id:input.id});
 const stored=(await query('SELECT content_type,content FROM field_sales_quote_evidence WHERE id=$1',[input.id])).rows[0];assert.equal(stored.content_type,'image/jpeg');assert.equal(stored.content.subarray(0,2).toString('hex'),'ffd8');
 await assert.rejects(save(input,{id:randomUUID()}),e=>e.status===409);
 await assert.rejects(save({...input,revision:2}),e=>e.status===409);
 for(const base64 of ['invalid #$','a'.repeat(11200001),Buffer.from('<html>not an image</html>').toString('base64')]){await assert.rejects(save({...input,id:randomUUID(),base64}),e=>e.status===400);}
 await assert.rejects(f.cmd('quote.confirm',{id:f.draft.id,revision:1,confirmedBy:'Lee',confirmedAt:'2026-09-21T19:00:00Z',evidenceIds:[randomUUID()]}),/evidence/);
 const accepted=(await f.cmd('quote.confirm',{id:f.draft.id,revision:1,confirmedBy:'Lee',confirmedAt:'2026-09-21T19:00:00Z',evidenceIds:[input.id]})).quote;
 assert.deepEqual(accepted.confirmation.evidenceIds,[input.id]);await assert.rejects(save({...input,id:randomUUID()}),/unconfirmed/);
},{rollback:true}));
