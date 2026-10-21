import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {createWaitlistFixture} from '../../support/regular-waitlist-fixture.mjs';
import {closeDb} from '../../../src/db.js';
import {updateSalesStockRequest,cancelSalesStockRequest,resubmitSalesStockRequest,decideSalesStockRequestLines,convertSalesStockRequestLines,updateScmStockRequestLine,listScmStockRequests} from '../../../src/stock-request-repository.js';
import {editRegularStockRequest,refreshRegularStockEvidence} from '../../../src/regular-stock-request-service.js';
import {convertStockRequestLines} from '../../../src/stock-request-service.js';
import {linkRegularStockSalesOrder,previewRegularStockSalesOrder} from '../../../src/regular-stock-handoff.js';
import {normalizeStockingType} from '../../../src/regular-stock-purchase-domain.js';
let f;before(async()=>{f=await createWaitlistFixture();});after(closeDb);
test('Waitlist cannot enter edit, cancellation, resubmission, approval, transfer or SO linkage workflows',async()=>{
  const s=await f.supply(),r=await s.demand(),input={expectedRevision:r.revision,lineIds:[r.lines[0].id],decision:'reject'};
  const calls=[()=>editRegularStockRequest(r.id,input,f.context),()=>updateSalesStockRequest(r.id,input,f.context),
    ()=>cancelSalesStockRequest(r.id,input,f.context),()=>resubmitSalesStockRequest(r.id,input,f.context),()=>decideSalesStockRequestLines(r.id,input,f.context),
    ()=>convertSalesStockRequestLines(r.id,input,f.context),()=>updateScmStockRequestLine(r.id,r.lines[0].id,input,f.context),
    ()=>convertStockRequestLines(r.id,input,{id:f.actor}),()=>linkRegularStockSalesOrder(r.id,input,f.context),()=>previewRegularStockSalesOrder(r.id,input,f.context)];
  for(const call of calls)await assert.rejects(call,error=>error.code==='WAITLIST_WORKFLOW_ONLY');
  let refreshes=0;const detail=await refreshRegularStockEvidence(r.id,{refreshAvailability:async()=>{refreshes++;}});assert.equal(detail.waitlist.waitingQty,1000);assert.equal(refreshes,0);
  assert.equal((await listScmStockRequests()).some(row=>row.id===r.id),false);assert.equal(normalizeStockingType('waitlist','transfer'),'waitlist');
});
