import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { setPurchaseOrderBlanketFlag } from "../../../src/dispatch-repository.js";
import { buildSmartScmBlanketPlan } from "../../../src/smart-scm-blanket-repository.js";
import { runSmartScmPlan, loadSmartScmPlanningPolicies } from "../../../src/smart-scm-planning-repository.js";
import { addSmartScmPlanningExclusion, listSmartScmPlanningExclusions, resumeSmartScmBlanketCoveredPlanningExclusions } from "../../../src/smart-scm-planning-exclusion-repository.js";
import { upsertPurchaseOrderLines } from "../../../src/order-sync-repository.js";
import { seedBlanketResume, holdState, resumeAudits } from "../../support/blanket-auto-resume-fixture.mjs";

assert.equal(process.env.MBT_TEST_ISOLATED, "1", "This suite requires a disposable database.");
after(closeDb);
const scenario = fn => withTransaction(fn, { rollback: true });
const flag = f => setPurchaseOrderBlanketFlag(f.poRef, { isBlanket: true });

test("flagging usable Blanket coverage resumes an earlier hold and preserves audited history", async () => {
  await scenario(async () => {
    const f = await seedBlanketResume();
    await flag(f);
    assert.ok((await holdState(f)).deactivated_at);
    assert.match((await holdState(f)).deactivation_note, new RegExp(f.poRef));
    const audits = await resumeAudits(f);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_type, "system");
    assert.equal(audits[0].details.itemId, f.itemId);
    assert.deepEqual(audits[0].details.sourcePoRefs, [f.poRef]);
    assert.ok((await loadSmartScmPlanningPolicies()).some(p=>Number(p.item_id)===f.itemId));
    const history = await listSmartScmPlanningExclusions({ includeInactive:true, search:f.itemName });
    assert.equal(history.items[0].reason, "Vendor out of stock");
    assert.equal(history.items[0].active, false);
  });
});

test("Blanket calculation catches existing coverage and creates releasable demand", async () => {
  await scenario(async () => {
    const f = await seedBlanketResume({flagged:true});
    const result = await buildSmartScmBlanketPlan();
    assert.ok((await holdState(f)).deactivated_at);
    const proposals = result.proposals.filter(p=>p.blanketSourcePoRef===f.poRef);
    assert.ok(proposals.length>0, "Earlier hold must not hide Blanket demand.");
    assert.ok(proposals.reduce((sum,p)=>sum+p.totalPallets,0)>0);
    assert.equal((await query("SELECT count(*)::int AS count FROM scm_smart_blanket_releases WHERE source_po_id=$1", [f.poId])).rows[0].count,0);
  });
});

test("ordinary planning resumes earlier holds before computing blanket coverage and residual demand", async () => {
  await scenario(async () => {
    const f = await seedBlanketResume({flagged:true,quantity:10});
    const result = await runSmartScmPlan();
    assert.ok((await holdState(f)).deactivated_at);
    const coverage=result.totals.blanketCoverage.find(r=>r.itemId===f.itemId);
    assert.equal(coverage.coveredPallets,1);
    assert.ok(coverage.residualPallets>0);
  });
});

test("PO line synchronization resumes a hold when a flagged source gains usable balance", async () => {
  await scenario(async () => {
    const f=await seedBlanketResume({flagged:true,quantity:0});
    await upsertPurchaseOrderLines(f.poId,[{line_id:1,item_id:f.itemId,item_name:f.itemName,
      sku:f.itemName,quantity:100,unit:"EA",to_plt:10,item_weight:100,location_id:1,location:"3445"}]);
    assert.ok((await holdState(f)).deactivated_at);
    assert.equal((await resumeAudits(f)).length,1);
  });
});

test("Blanket coverage resumes even a hold entered after flagging", async () => {
  await scenario(async () => {
    const f = await seedBlanketResume({flagged:true,holdDate:"2022-01-01T00:00:00Z"});
    await flag(f);
    await buildSmartScmBlanketPlan();
    assert.ok((await holdState(f)).deactivated_at);
    assert.equal((await resumeAudits(f)).length,1);
  });
});

test("unusable source lines and unrelated items stay paused", async () => {
  await scenario(async () => {
    const fixtures=[];
    for(const options of [{quantity:0},{quantity:9},{quantity:100,received:100},
      {toPlt:20},{closed:true},{active:false}]) {
      const f=await seedBlanketResume(options);
      fixtures.push(f);
      await flag(f);
    }
    const unrelated=await seedBlanketResume();
    const valid=await seedBlanketResume();
    await flag(valid);
    assert.ok((await holdState(valid)).deactivated_at);
    for(const f of [...fixtures,unrelated]) {
      assert.equal((await holdState(f)).deactivated_at,null,f.poRef);
      assert.equal((await resumeAudits(f)).length,0);
    }
  });
});

test("flag, resumption and audit roll back together", async () => {
  await scenario(async () => {
    const f=await seedBlanketResume();
    await assert.rejects(withTransaction(async()=>{
      await flag(f);
      assert.ok((await holdState(f)).deactivated_at);
      assert.equal((await resumeAudits(f)).length,1);
      throw new Error("rollback resumption rehearsal");
    }),/rollback resumption rehearsal/);
    assert.equal((await holdState(f)).deactivated_at,null);
    assert.equal((await resumeAudits(f)).length,0);
    assert.equal((await query("SELECT is_blanket_po FROM purchase_orders WHERE netsuite_id=$1",[f.poId])).rows[0].is_blanket_po,false);
  });
});

test("global reconciliation skips ordinary, closed and inactive sources and preserves expired history",async()=>{
  await scenario(async()=>{
    const ordinary=await seedBlanketResume();
    const closed=await seedBlanketResume({flagged:true});
    const inactive=await seedBlanketResume({flagged:true});
    const expired=await seedBlanketResume({flagged:true});
    const valid=await seedBlanketResume({flagged:true});
    await query("UPDATE purchase_orders SET status_text='Purchase Order : Closed' WHERE netsuite_id=$1",[closed.poId]);
    await query("UPDATE purchase_orders SET netsuite_active=false WHERE netsuite_id=$1",[inactive.poId]);
    await query("UPDATE scm_smart_planning_exclusions SET expires_at='2020-02-01' WHERE id=$1",[expired.holdId]);
    await resumeSmartScmBlanketCoveredPlanningExclusions();
    assert.ok((await holdState(valid)).deactivated_at);
    for(const f of [ordinary,closed,inactive,expired]) {
      assert.equal((await holdState(f)).deactivated_at,null,f.poRef);
      assert.equal((await resumeAudits(f)).length,0);
    }
  });
});

test("an audit failure rolls back automatic resumption and the Blanket flag",async()=>{
  await scenario(async()=>{
    const f=await seedBlanketResume();
    await query(`CREATE FUNCTION pg_temp.reject_blanket_resume_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='smart_scm.planning_exclusion.auto_resume_blanket' THEN
        RAISE EXCEPTION 'audit unavailable rehearsal'; END IF; RETURN NEW; END $$`);
    await query(`CREATE TRIGGER reject_blanket_resume_audit BEFORE INSERT ON delivery_audit_log
      FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_blanket_resume_audit()`);
    await assert.rejects(flag(f),/audit unavailable rehearsal/);
    assert.equal((await holdState(f)).deactivated_at,null);
    assert.equal((await resumeAudits(f)).length,0);
    assert.equal((await query("SELECT is_blanket_po FROM purchase_orders WHERE netsuite_id=$1",[f.poId])).rows[0].is_blanket_po,false);
  });
});

test("concurrent reconciliation calls create exactly one audit for a shared hold",async()=>{
  const f=await seedBlanketResume({flagged:true});
  const results=await Promise.all(Array.from({length:6},()=>resumeSmartScmBlanketCoveredPlanningExclusions({sourcePoId:f.poId})));
  assert.equal(results.flat().length,1);
  assert.ok((await holdState(f)).deactivated_at);
  assert.equal((await resumeAudits(f)).length,1);
});

test("concurrent flag requests retire each hold once, including a new hold entered afterward", async () => {
  const f=await seedBlanketResume();
  await Promise.all(Array.from({length:5},()=>flag(f)));
  assert.ok((await holdState(f)).deactivated_at);
  assert.equal((await resumeAudits(f)).length,1);
  const newer=await addSmartScmPlanningExclusion({itemId:f.itemId,reason:"New vendor stockout"});
  assert.equal(newer.active,false,"New holds must resume immediately while covered.");
  await flag(f);
  assert.ok((await holdState({...f,holdId:newer.id})).deactivated_at);
  assert.equal((await resumeAudits({...f,holdId:newer.id})).length,1);
  assert.equal((await resumeAudits(f)).length,1);
});

test("generated balances resume compatible whole-pallet coverage regardless of hold chronology", async () => {
  await fc.assert(fc.asyncProperty(
    fc.record({quantity:fc.integer({min:0,max:100}),received:fc.integer({min:0,max:100}),
      compatible:fc.boolean(),earlier:fc.boolean()}),
    async ({quantity,received,compatible,earlier})=>scenario(async()=>{
      const f=await seedBlanketResume({flagged:true,quantity,received,toPlt:compatible?10:20,
        holdDate:earlier?"2020-01-01T00:00:00Z":"2022-01-01T00:00:00Z"});
      await flag(f);
      const expected=compatible&&quantity-received>=10;
      assert.equal(Boolean((await holdState(f)).deactivated_at),expected);
      await flag(f);
      assert.equal((await resumeAudits(f)).length,expected?1:0);
    })
  ),{numRuns:40,seed:3737});
});
