import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {createOperator} from '../../src/auth-repository.js';
import {query,closeDb,withTransaction} from '../../src/db.js';
import {createMbrRepository} from '../../src/mbr/repository.js';
import {fields} from './fixtures.js';
import {pdfText} from '../field-sales/pdf-text.js';
import {readFile} from 'node:fs/promises';

let actor, other, repo, signatureDataUrl;
assert.equal(process.env.MBT_TEST_ISOLATED,'1','Run database tests through mbr-contract-gauntlet.py');
before(async()=>{
  actor=await createOperator({username:'mbr-repo-'+randomUUID(),displayName:'MBR Sales Alice',password:'mbr-test-password',role:'sales'});
  other=await createOperator({username:'mbr-repo-'+randomUUID(),displayName:'MBR Sales Bob',password:'mbr-test-password',role:'sales'});
  repo=createMbrRepository({linkKey:async()=>Buffer.alloc(32,7),baseUrl:'https://contracts.example.test'});
  signatureDataUrl='data:image/png;base64,'+(await sharp(Buffer.from('<svg width="900" height="320"><rect width="900" height="320" fill="white"/><path d="M20 180 Q90 40 140 190 L270 120 L250 200 L380 160" stroke="black" stroke-width="5" fill="none"/></svg>')).png().toBuffer()).toString('base64');
});
after(closeDb);
const signing = (revision=1, overrides={}) => ({revision,protectionPlanAccepted:true,consent:true,
  signerName:'Alice Customer',signatureDataUrl,submissionId:randomUUID(),...overrides});
const newIssued = async (overrides={}) => {
  const contract=await repo.create(actor,fields(overrides));
  const link=await repo.link(actor,contract.id,contract.revision);
  return {contract,link,token:new URL(link.url).hash.slice(1)};
};

test('pending save has no deadline; sales shares all contracts and issuing/copying is stable', async()=>{
  const c=await repo.create(actor,fields());
  assert.equal(c.status,'pending');assert.equal(c.expiresAt,null);
  assert.equal((await repo.get(c.id)).fields.lessee,'Acme Construction Ltd.');
  assert.ok((await repo.list({search:c.number})).items.some(row=>row.id===c.id));
  const issuedBefore=Date.now(), link=await repo.link(other,c.id,c.revision);
  assert.ok(Date.parse(link.expiresAt)>=issuedBefore+3*86400000-100);
  const copy=await repo.link(actor,c.id,c.revision);
  assert.equal(copy.url,link.url);assert.equal(copy.expiresAt,link.expiresAt);
  const publicView=await repo.review(new URL(link.url).hash.slice(1));
  assert.equal(publicView.fields.dailyRateMinor,25000);
  assert.ok(publicView.paragraphs.some(p=>p.includes('eight (8) operating hours')));
  assert.ok(!JSON.stringify(publicView).includes(actor.id));
});

test('every pending edit retains the link, appends a version and restarts expiry; stale signatures fail', async()=>{
  const {contract,link,token}=await newIssued();
  await query("UPDATE mbr_contracts SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[contract.id]);
  const edited=await repo.edit(other,contract.id,{revision:1,...fields({dailyRate:'270.00',expiryDays:5})});
  assert.equal(edited.revision,2);
  assert.ok(Date.parse(edited.expiresAt)>Date.now()+4*86400000);
  assert.equal((await repo.link(actor,contract.id,2)).url,link.url);
  await assert.rejects(repo.sign(token,signing(1)),{status:409,code:'MBR_CONTRACT_CHANGED'});
  assert.equal((await repo.review(token)).fields.dailyRateMinor,27000);
  await assert.rejects(repo.edit(actor,contract.id,{revision:1,...fields()}),{status:409});
  const versions=(await query('SELECT revision FROM mbr_contract_revisions WHERE contract_id=$1 ORDER BY revision',[contract.id])).rows;
  assert.deepEqual(versions.map(row=>row.revision),[1,2]);
});

test('expired contract blocks edits/signing without a worker; renewal keeps number and invalidates old link', async()=>{
  const {contract,token}=await newIssued();
  await query('UPDATE mbr_contracts SET expires_at=clock_timestamp() WHERE id=$1',[contract.id]);
  assert.equal((await repo.get(contract.id)).status,'expired');
  await assert.rejects(repo.sign(token,signing()),{status:410});
  await assert.rejects(repo.edit(actor,contract.id,{revision:1,...fields()}),{status:410});
  const renewed=await repo.renew(actor,contract.id,{revision:1,...fields({expiryDays:1})});
  assert.equal(renewed.contract.number,contract.number);assert.equal(renewed.contract.status,'pending');
  const fresh=new URL(renewed.url).hash.slice(1);assert.notEqual(fresh,token);
  await assert.rejects(repo.review(token),{status:410});
  assert.equal((await repo.review(fresh)).revision,2);
  assert.ok((await repo.get(contract.id)).history.some(event=>event.kind==='expired'));
});

test('completion persists exact terms/choice and actual PDF text; completed links never expire', async()=>{
  const {contract,token}=await newIssued();
  const request=signing();
  const completed=await repo.sign(token,request,{ip:'127.0.0.1',userAgent:'MBR test'});
  assert.equal(completed.status,'completed');
  const pdf=await repo.pdf({token});assert.equal(pdf.bytes.subarray(0,4).toString(),'%PDF');
  const text=pdfText(pdf.bytes).replace(/\s+/g,' ');
  for(const phrase of ['Acme Construction Ltd.','STR1000H','VLGST1KHAT0610007','Alice Customer',
    'Accept Rental Protection Plan','15%','13. WAIVER AND LIMITATION OF RESPONSIBILITY',
    '2,000,000','5,000','GPS TRACKING','Toronto, Ontario','250.00','500.00']) {
    assert.ok(text.includes(phrase),`Missing actual PDF content: ${phrase}`);
  }
  const row=(await query('SELECT * FROM mbr_contracts WHERE id=$1',[contract.id])).rows[0];
  assert.equal(row.signed_snapshot.signature.protectionPlanAccepted,true);
  assert.equal(row.signed_snapshot.signature.consent,true);
  assert.ok(row.completed_pdf && row.signature_png && row.pdf_sha256);
  // Pagination can split a clause. Remove only the known page-number footer,
  // then require every clause word from the actual emitted content streams.
  const compact=value=>value.replace(/\s+/gu,'');
  const bodyText=compact(pdfText(pdf.bytes)).replace(/MBR-\d{4}-\d+·Revision\d+·\d+\/\d+/gu,'');
  const reference=JSON.parse(await readFile(new URL('./source-agreement.json',import.meta.url),'utf8'));
  for(const paragraph of reference.paragraphs.slice(1)) {
    const parts=paragraph.split(/_{3,}|\(\s+\)|☐ Accept Rental Protection Plan \(RPP\)\s+☐ Decline Rental Protection Plan \(RPP\)/gu);
    for(const part of parts) {
      assert.ok(bodyText.includes(compact(part)),`Agreement wording missing from actual PDF: ${part.slice(0,65)}`);
    }
  }
  assert.equal((await repo.sign(token,request)).status,'completed');
  assert.equal((await query("SELECT count(*) FROM mbr_contract_events WHERE contract_id=$1 AND kind='completed'",[contract.id])).rows[0].count,'1');
  await query("UPDATE mbr_contracts SET expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[contract.id]);
  await repo.expireDue();
  assert.equal((await repo.review(token)).status,'completed');
  assert.ok((await repo.pdf({token})).bytes.equals(pdf.bytes));
  await assert.rejects(repo.edit(actor,contract.id,{revision:1,...fields()}),{status:409});
  await assert.rejects(repo.renew(actor,contract.id,{revision:1,...fields()}),{status:409});
  await assert.rejects(repo.sign(token,signing()),{status:409});
});

test('declining protection is explicitly recorded in the signed PDF', async()=>{
  const {contract,token}=await newIssued();
  await repo.sign(token,signing(1,{protectionPlanAccepted:false}));
  assert.equal((await repo.get(contract.id)).signature.protectionPlanAccepted,false);
  assert.ok(pdfText((await repo.pdf({token})).bytes).includes('Decline Rental Protection Plan'));
});

test('PDF rendering failure rolls back signature, status and completion history', async()=>{
  const {contract,token}=await newIssued();
  const failing=createMbrRepository({linkKey:async()=>Buffer.alloc(32,7),renderPdf:async()=>{throw new Error('Renderer offline');}});
  await assert.rejects(failing.sign(token,signing()),/Renderer offline/);
  const saved=(await query('SELECT status,signature_png,completed_pdf FROM mbr_contracts WHERE id=$1',[contract.id])).rows[0];
  assert.deepEqual(saved,{status:'pending',signature_png:null,completed_pdf:null});
  assert.equal((await query("SELECT count(*) FROM mbr_contract_events WHERE contract_id=$1 AND kind='completed'",[contract.id])).rows[0].count,'0');
});

test('two simultaneous signers produce one immutable completion; matching retries are idempotent', async()=>{
  const {contract,token}=await newIssued();
  const outcomes=await Promise.allSettled([repo.sign(token,signing()),repo.sign(token,signing(1,{signerName:'Other signer'}))]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(outcomes.find(result=>result.status==='rejected').reason.status,409);
  assert.equal((await query("SELECT count(*) FROM mbr_contract_events WHERE contract_id=$1 AND kind='completed'",[contract.id])).rows[0].count,'1');
  const second=await newIssued(), attempt=signing();
  const retries=await Promise.all([repo.sign(second.token,attempt),repo.sign(second.token,attempt)]);
  assert.ok(retries.every(result=>result.status==='completed'));
});

test('deadline is checked after waiting for a lock, so an expired waiter cannot complete', async()=>{
  const {contract,token}=await newIssued();
  let release, acquired;
  const gate=new Promise(resolve=>{release=resolve;});
  const ready=new Promise(resolve=>{acquired=resolve;});
  const holding=withTransaction(async()=>{
    await query('SELECT id FROM mbr_contracts WHERE id=$1 FOR UPDATE',[contract.id]);
    acquired();await gate;
    await query('UPDATE mbr_contracts SET expires_at=clock_timestamp() WHERE id=$1',[contract.id]);
  });
  await ready;
  const waiting=repo.sign(token,signing());
  release();await holding;
  await assert.rejects(waiting,{status:410});
  assert.equal((await repo.get(contract.id)).status,'expired');
});

test('concurrent sales edits cannot overwrite each other', async()=>{
  const {contract}=await newIssued();
  const result=await Promise.allSettled([
    repo.edit(actor,contract.id,{revision:1,...fields({lessee:'One'})}),
    repo.edit(other,contract.id,{revision:1,...fields({lessee:'Two'})})]);
  assert.equal(result.filter(row=>row.status==='fulfilled').length,1);
  assert.equal(result.find(row=>row.status==='rejected').reason.status,409);
  assert.equal((await repo.get(contract.id)).revision,2);
});

test('contract search is bounded and does not accept malformed pagination or unsupported statuses',async()=>{
  for(const input of [{status:'draft'},{search:'x'.repeat(201)},{offset:-1},{offset:1.2},{limit:101},{limit:0}]) {
    await assert.rejects(repo.list(input),{status:400});
  }
  const page=await repo.list({limit:1});assert.equal(page.items.length,1);assert.equal(page.hasMore,true);
});

test('contract numbering stays unique after crossing six digits',async t=>{
  const prior=(await query('SELECT last_value,is_called FROM mbr_contract_number_seq')).rows[0];
  const contracts=[];
  t.after(async()=>{
    try {
      await withTransaction(async()=>{
        const ids=contracts.map(value=>value.id);
        await query('DELETE FROM mbr_contract_events WHERE contract_id=ANY($1::uuid[])',[ids]);
        await query('DELETE FROM mbr_contract_revisions WHERE contract_id=ANY($1::uuid[])',[ids]);
        await query('DELETE FROM mbr_contracts WHERE id=ANY($1::uuid[])',[ids]);
      });
    } finally {await query("SELECT setval('mbr_contract_number_seq',$1::bigint,$2)",[prior.last_value,prior.is_called]);}
  });
  await query("SELECT setval('mbr_contract_number_seq',999998,true)");
  for(let index=0;index<3;index+=1) {contracts.push(await repo.create(actor,fields()));}
  assert.equal(new Set(contracts.map(value=>value.number)).size,3);
  assert.ok(contracts[1].number.endsWith('-1000000'));
  assert.ok(contracts[2].number.endsWith('-1000001'));
});
