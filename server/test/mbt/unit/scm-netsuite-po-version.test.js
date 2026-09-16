import assert from "node:assert/strict";
import test from "node:test";
import { scmNetSuitePoVersion } from "../../../src/scm-netsuite-po-version.js";

const remote = {id:991607,trandate:'9/15/2026',vendorId:8115,status:'B',memo:'Memo',vendorReference:'',foreignTotal:-100,
  lines:[{lineId:1,itemId:4778,quantity:20,rate:5,amount:100,locationId:28,receivedQuantity:0,closed:false,unit:'SQFT'}]};

test('same-day quantity, item, price, destination, receipt, status and header edits change the version', () => {
  const version=scmNetSuitePoVersion(remote);
  assert.match(version,/^[a-f0-9]{64}$/);
  for (const patch of [{quantity:21},{itemId:4795},{rate:6},{locationId:1},{receivedQuantity:1},{closed:true}]) {
    assert.notEqual(scmNetSuitePoVersion({...remote,lines:[{...remote.lines[0],...patch}]}),version);
  }
  for (const patch of [{memo:'new'},{status:'H'},{vendorReference:'REF'},{expectedDeliveryDate:'2026-09-19'}]) {
    assert.notEqual(scmNetSuitePoVersion({...remote,...patch}),version);
  }
});

test('persisted history and remote values produce the same version across date and numeric representations', () => {
  const current = {transactionDate:'2026-09-15T00:00:00.000Z',vendorId:8115,status:'B',memo:'Memo',vendorReference:'',total:-100,
    lines:[{lineId:1,itemId:4778,quantity:'20',rate:'5',amount:'100',destinationLocationId:28,receivedQuantity:0,closed:false,unit:'SQFT'}]};
  assert.equal(scmNetSuitePoVersion({current}),scmNetSuitePoVersion(remote));
  assert.notEqual(scmNetSuitePoVersion({current:{...current,lines:[]}}),scmNetSuitePoVersion(remote));
});

test('line order is irrelevant; duplicate identities and missing prices remain distinguishable', () => {
  const lines=[remote.lines[0],{...remote.lines[0],lineId:2}];
  assert.equal(scmNetSuitePoVersion({...remote,lines}),scmNetSuitePoVersion({...remote,lines:[...lines].reverse()}));
  assert.notEqual(scmNetSuitePoVersion({...remote,lines}),scmNetSuitePoVersion(remote));
  assert.notEqual(scmNetSuitePoVersion({...remote,lines:[{...remote.lines[0],rate:null}]}),scmNetSuitePoVersion(remote));
});
