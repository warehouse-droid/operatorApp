import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

function vendorUi() {
  const calls=[];
  const listeners=new Map();
  const context=vm.createContext({
    console,URLSearchParams,setInterval(){},
    smartState:{tab:'vendors',busy:'',vendorReplyLoads:[],data:{yards:[]}},
    smartScmApp:{addEventListener:(name,fn)=>listeners.set(name,fn)},
    window:{addEventListener(){}},document:{visibilityState:'visible',activeElement:null},
    smartApi:async (url,options)=>{calls.push({url,options});return [];},
    smartWork:async (_label,fn)=>fn(),smartRender(){},smartCanWrite:()=>true,
    smartEscape:(value)=>String(value??''),smartNumber:(value)=>String(value??''),
    smartPill:(_value,label)=>label||'',smartDate:()=>'',
    smartProposalRoute:(proposal)=>proposal.destinationName,
  });
  vm.runInContext(fs.readFileSync(new URL('../../../public/scm-smart-vendor.js',import.meta.url),'utf8'),context);
  return {context,calls,listeners};
}

test('created PO cards expose the editor without archiving and show native quantities without conversion',async () => {
  const {context,calls,listeners}=vendorUi();
  context.proposal={id:1,workflowId:2,workflowKind:'regular_po',status:'completed',purchaseOrderHistoryId:55,
    netsuitePurchaseOrderId:991607,netsuitePurchaseOrderRef:'POB03875',currentPurchaseOrder:true,
    lines:[],physicalPalletLines:[],totalPallets:23};
  const html=vm.runInContext('smartVendorLoadCard(proposal)',context);
  assert.match(html,/href="\/scm\/netsuite-po\?historyId=55"/);
  const button={dataset:{smartAction:'refresh-vendor-po',historyId:'55'}};
  await listeners.get('click')({target:{closest:()=>button}});
  assert.equal(calls[0]?.url,'/api/scm/netsuite-po-history/55/refresh');
  assert.equal(calls[0].options.method,'POST');
  assert.equal(vm.runInContext('smartVendorLineSalesQuantity({currentPurchaseOrder:true,salesQuantity:932.8,toPlt:null},0)',context),932.8);
  assert.equal(vm.runInContext('smartVendorLinePurchaseAmount({currentPurchaseOrder:true,purchaseAmount:null,lastPurchasePrice:99},20)',context),null);
});

test('visible Vendor Replies reconciles one stale PO; hidden or focused editors do not start sync',async () => {
  const {context,calls}=vendorUi();
  context.smartState.vendorReplyLoads=[{purchaseOrderHistoryId:55,purchaseOrderSyncedAt:'2026-01-01'}];
  context.document.visibilityState='hidden';
  await vm.runInContext('smartReconcileCreatedPurchaseOrders()',context);
  assert.equal(calls.length,0);
  context.document.visibilityState='visible';
  context.document.activeElement={tagName:'INPUT'};
  await vm.runInContext('smartReconcileCreatedPurchaseOrders()',context);
  assert.equal(calls.length,0);
  context.document.activeElement=null;
  await vm.runInContext('smartReconcileCreatedPurchaseOrders()',context);
  assert.equal(calls.filter((call)=>call.url.endsWith('/refresh')).length,1);
});

test('linked editor loads a single unarchived PO and retains the content version for saves',async () => {
  const calls=[];
  const mount={innerHTML:'',addEventListener(){},contains:()=>false};
  const record={id:55,version:'content-version',purchaseOrderRef:'POB03875',current:{status:'B',statusText:'Pending Receipt',lines:[]}};
  const context=vm.createContext({
    console,URLSearchParams,setInterval(){},
    document:{getElementById:()=>mount,addEventListener(){},visibilityState:'hidden'},
    window:{addEventListener(){},location:{search:'?historyId=55'}},
    requireDispatchLogin(){},dispatchAuthHeaders:()=>({}),
    fetch:async (url)=>{calls.push(url);return {ok:true,headers:{get:()=>"application/json"},json:async ()=>url.endsWith('/55') ? record : {records:[],total:0}};}
  });
  vm.runInContext(fs.readFileSync(new URL('../../../public/scm-netsuite-po.js',import.meta.url),'utf8'),context);
  await vm.runInContext('poLinkedHistoryId=55;poState.operator={role:"scm"};load()',context);
  assert.ok(calls.includes('/api/scm/netsuite-po-history/55'));
  assert.equal(vm.runInContext('poState.records[0].version',context),'content-version');
  assert.match(mount.innerHTML,/POB03875/);
  assert.doesNotMatch(mount.innerHTML,/data-action="unarchive"/);
});
