import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { scmNetSuitePoVersion } from "../../../src/scm-netsuite-po-version.js";
import { buildPurchaseOrderHistoryRestPayload } from "../../../src/netsuite.js";

const original = { id:991607,tranid:'POB03875',lastModifiedAt:'2026-09-15',status:'B',statusText:'Pending Receipt',memo:'old',lines:[] };
function service({ remote=original, failLines=false }={}) {
  const writes=[];
  let transactions=0;
  let saved=false;
  const history={id:55,purchaseOrderId:991607,current:{active:true},remoteLastModifiedAt:original.lastModifiedAt};
  const context={
    setTimeout,scmNetSuitePoVersion,
    getScmNetSuitePoHistory:async (_id,options={}) => {
      if(options.includeUnarchived===false) {throw Object.assign(new Error('unarchived PO hidden'),{status:404});}
      return history;
    },
    fetchPurchaseOrderHistorySnapshotFromNetSuite:async () => saved ? {...remote,memo:'new'} : remote,
    fetchPurchaseOrderHistorySnapshotsFromNetSuite:async () => [remote],
    listScmNetSuitePoHistoryReconciliationCandidates:async () => [{historyId:55,purchaseOrderId:991607}],
    updatePurchaseOrderHistoryInNetSuite:async (id,changes) => {writes.push({id,changes});saved=true;},
    upsertPurchaseOrders:async () => {},
    upsertPurchaseOrderLines:async () => {if(failLines) {throw new Error('line persistence failure');}},
    markMissingInboundOrderLines:async () => {},
    persistScmNetSuitePoSnapshot:async () => history,
    markScmNetSuitePoHistorySyncError:async () => {},
    withTransaction:async (fn) => {transactions++;return fn();},
    writeAudit:async () => {}
  };
  const serviceUrl=new URL('../../../src/scm-netsuite-po-history-service.js',import.meta.url);
  const source=fs.readFileSync(serviceUrl,'utf8')
    .replace(/^import[\s\S]*?from "[^"]+";\n/gm,(part)=>part.replace(/[^\r\n]/g," ")).replace(/^export /gm,'       ');
  const api=vm.runInNewContext(`${source}\n({updateScmNetSuitePoHistory,refreshScmNetSuitePoHistory})`,context,{filename:serviceUrl.pathname});
  return {api,writes,transactions:()=>transactions};
}

test('the existing editor can update an unarchived created PO and reads back the same PO',async () => {
  const {api,writes}=service();
  const result=await api.updateScmNetSuitePoHistory(55,{expectedLastModifiedAt:original.lastModifiedAt,expectedVersion:scmNetSuitePoVersion(original),header:{memo:'new'}});
  assert.equal(result.purchaseOrderId,991607);
  assert.equal(writes.length,1);
  assert.equal(writes[0].id,991607);
  assert.equal(writes[0].changes.expectedVersion,scmNetSuitePoVersion(original));
});

test('a same-day NetSuite change rejects the stale editor without an outbound write',async () => {
  const {api,writes}=service({remote:{...original,memo:'edited in NetSuite'}});
  await assert.rejects(api.updateScmNetSuitePoHistory(55,{expectedLastModifiedAt:original.lastModifiedAt,expectedVersion:scmNetSuitePoVersion(original),header:{memo:'new'}}),{status:409});
  assert.equal(writes.length,0);
});

test('canonical refresh uses one transaction and surfaces a failed line write',async () => {
  const {api,transactions}=service({failLines:true});
  await assert.rejects(api.refreshScmNetSuitePoHistory(55),/line persistence failure/);
  assert.equal(transactions(),1);
});

test('closed and received POs reject edits before sending any update',async () => {
  for (const remote of [{...original,statusText:'Closed'}, {...original,lines:[{lineId:1,itemId:4778,receivedQuantity:1}]}]) {
    const {api,writes}=service({remote});
    await assert.rejects(api.updateScmNetSuitePoHistory(55,{expectedLastModifiedAt:remote.lastModifiedAt,expectedVersion:scmNetSuitePoVersion(remote),header:{memo:'new'}}),{status:409});
    assert.equal(writes.length,0);
  }
});

test('a request without a content version cannot bypass stale-edit protection',async () => {
  const {api,writes}=service();
  await assert.rejects(api.updateScmNetSuitePoHistory(55,{expectedLastModifiedAt:original.lastModifiedAt,header:{memo:'new'}}),{status:409});
  assert.equal(writes.length,0);
});

test('NetSuite transport rechecks content immediately before PATCH and blocks a race',async () => {
  const transportUrl=new URL('../../../src/netsuite.js',import.meta.url);
  const source=fs.readFileSync(transportUrl,'utf8');
  const start=source.indexOf('function comparableNetSuiteDate');
  const transportSource=source.slice(0,start).replace(/[^\r\n]/g," ")+source.slice(start,source.indexOf('export async function resolvePalletItemFromNetSuite')).replace(/^export /gm,'       ');
  for (const changed of [true,false]) {
    const methods=[];
    const context={scmNetSuitePoVersion,buildPurchaseOrderHistoryRestPayload,restMutationQueue:Promise.resolve(),
      fetchPurchaseOrderHistorySnapshotFromNetSuite:async ()=>changed ? {...original,memo:'external edit'} : original,
      netsuiteRest:async (_path,options)=>{methods.push(options.method);return {status:204,data:{lastModifiedDate:original.lastModifiedAt,item:{items:[]}}};}
    };
    const update=vm.runInNewContext(`${transportSource}\nupdatePurchaseOrderHistoryInNetSuite`,context,{filename:transportUrl.pathname});
    const pending=update(991607,{expectedLastModifiedAt:original.lastModifiedAt,expectedVersion:scmNetSuitePoVersion(original),header:{memo:'new'}});
    if (changed) {
      await assert.rejects(pending,{status:409});
      assert.deepEqual(methods,['GET']);
    } else {
      assert.equal((await pending).entityId,991607);
      assert.deepEqual(methods,['GET','PATCH']);
    }
  }
});
