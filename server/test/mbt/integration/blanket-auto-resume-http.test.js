import assert from "node:assert/strict";
import test, {before,after} from "node:test";
import {createDispatchV2Fixture} from "../../dispatch/support/dispatch-v2-fixture.js";
import {seedBlanketResume,resumeAudits} from "../../support/blanket-auto-resume-fixture.mjs";

let http;
before(async()=>{http=await createDispatchV2Fixture({role:"admin"});});
after(async()=>http?.close());

test("real HTTP flag and new-hold requests expose resumed status and retained audit history",async()=>{
  const f=await seedBlanketResume();
  const flagged=await http.request(`/api/scm/purchase-orders/${f.poRef}/blanket`,{
    method:"PUT",body:{isBlanket:true}
  });
  assert.equal(flagged.response.status,200,JSON.stringify(flagged.payload));
  assert.equal((await resumeAudits(f)).length,1);
  const holds=await http.request(`/api/scm/smart/planning-exclusions?includeInactive=true&search=${f.itemName}`);
  assert.equal(holds.response.status,200);
  assert.equal(holds.payload.activeCount,0);
  assert.equal(holds.payload.items[0].active,false);
  assert.match(holds.payload.items[0].deactivationNote,new RegExp(f.poRef));
  const newer=await http.request('/api/scm/smart/planning-exclusions',{
    method:"POST",body:{itemId:f.itemId,reason:"Hold entered after Blanket flag"}
  });
  assert.equal(newer.response.status,201,JSON.stringify(newer.payload));
  assert.equal(newer.payload.active,false);
  assert.equal((await resumeAudits({...f,holdId:newer.payload.id})).length,1);
});
