import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {query,closeDb} from '../../src/db.js';
import {cityDate,recencyCutoff,isServiceWork,sourceEvidence,leadDateLabel,alignLeadFilters,PLANNING_MILESTONES} from '../../public/field-sales/lead-policy.js';
import {leadSourceFilter,sourceDateSql} from '../../src/field-sales/lead-filters.js';
after(closeDb);
test('P1 Toronto calendar recency is inclusive and clamps leap years/month ends',()=>{
  assert.equal(recencyCutoff('12',new Date('2026-09-19T00:30:00Z')),'2025-09-18');
  assert.equal(recencyCutoff('6',new Date('2026-08-31T16:00:00Z')),'2026-02-28');
  assert.equal(recencyCutoff('12',new Date('2024-02-29T16:00:00Z')),'2023-02-28');
  assert.equal(recencyCutoff(24,new Date('2026-02-28T16:00:00Z')),'2024-02-28');
  for(const value of [undefined,null,'','all']){assert.equal(recencyCutoff(value),null);}
  for(const value of [true,0,[],['12'],'12foo',{},'48']){assert.throws(()=>recencyCutoff(value),/recency/i);}
  for(const value of ['2025-02-29','2026-13-01','0000-01-01','yesterday',12,null,'']){assert.equal(cityDate(value),null);}
  assert.equal(cityDate(' 2024-02-29T00:00:00.000Z '),'2024-02-29');assert.equal(cityDate('9999-12-31'),'9999-12-31');
});
test('P2 source filter changes preserve age and map while removing incompatible stage restrictions',()=>{
  const start={source:'recommended',recencyMonths:'12',bounds:'-79.6,43.6,-79.5,43.8',milestone:'Notice of Complete Application Issued',permitStatus:'Inspection'};
  const planning=alignLeadFilters(start,'milestone');assert.equal(planning.source,'planning');assert.equal(planning.permitStatus,undefined);assert.equal(planning.recencyMonths,'12');assert.equal(planning.bounds,start.bounds);
  const permit=alignLeadFilters(start,'permitStatus');assert.equal(permit.source,'permit');assert.equal(permit.milestone,undefined);
  assert.equal(alignLeadFilters({...start,source:'planning'},'source').permitStatus,undefined);assert.equal(alignLeadFilters({...start,source:'permit'},'source').milestone,undefined);
  const manual=alignLeadFilters({...start,source:'manual',category:'New Houses'},'source');assert.equal(manual.category,undefined);assert.equal(manual.milestone,undefined);assert.equal(manual.permitStatus,undefined);
  assert.deepEqual(alignLeadFilters(start,'search'),start);assert.equal(start.source,'recommended');assert.ok(PLANNING_MILESTONES.includes(start.milestone));
});
test('P3 SQL and browser date/work interpretation agree across hostile and mixed imported values',async()=>{
  const date=fc.constantFrom(null,'','2026-09-18','2024-02-29T00:00:00Z','2025-02-29','2026-02-30','2026-99-01','0000-01-01','9999-12-31',"2026'); DROP TABLE field_sales_sources;--");
  const data=fc.record({source:fc.constantFrom('permit','planning'),category:fc.constantFrom('New Houses','Plumbing','Fire/Security','Signs','Designated Structures','Drain and Site Service'),minor:fc.boolean(),date,raw:fc.record({ISSUED_DATE:date,APPLICATION_DATE:date,WORK:fc.constantFrom('',null,'New Building',' Inside and Outside Drains ','Back Water Valve (Sewer only)','Sign Building Permit Related','Other(SR)')})});
  await fc.assert(fc.asyncProperty(fc.array(data,{minLength:1,maxLength:25}),async records=>{
    const sources=records.map((record,id)=>({id,source:record.source,present:true,data:record}));
    const dates=await query(`SELECT s.id,${sourceDateSql} AS day FROM jsonb_to_recordset($1::jsonb) AS s(id int,source text,present boolean,data jsonb) ORDER BY s.id`,[JSON.stringify(sources)]);
    assert.deepEqual(dates.rows.map(r=>r.day),records.map(r=>sourceEvidence(r.source,r).date));
    const args=[],filter=leadSourceFilter({source:'permit',recencyMonths:'all'},args);args.push(JSON.stringify(sources));
    const eligible=await query(`SELECT s.id FROM jsonb_to_recordset($${args.length}::jsonb) AS s(id int,source text,present boolean,data jsonb) WHERE ${filter.where} ORDER BY s.id`,args);
    assert.deepEqual(eligible.rows.map(r=>r.id),records.map((r,id)=>({r,id})).filter(({r})=>r.source==='permit'&&!isServiceWork(r)).map(({id})=>id));
  }),{seed:20260919,numRuns:40});
});
test('P4 evidence distinguishes legacy/unknown dates, uncertainty and explicit date labels',()=>{
  const legacy=sourceEvidence('permit',{date:'2026-01-01'});assert.equal(legacy.dateKind,'record');assert.equal(legacy.needsReview,true);assert.equal(legacy.date,'2026-01-01');
  const missing=sourceEvidence('planning',{});assert.equal(missing.date,null);assert.equal(missing.needsReview,false);
  assert.deepEqual(['issued','application','milestone','record','unknown'].map(leadDateLabel),['Issued','Applied','Milestone','Source date','Source date']);
  assert.equal(isServiceWork({category:'New Houses',raw:{WORK:'New Building'},description:'backwater valve and plumbing included'}),false);
  assert.equal(isServiceWork({category:'Conditional Permit',raw:{WORK:'Inside and Outside Drains'}}),false);
});
