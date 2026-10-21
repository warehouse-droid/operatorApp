import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import fc from 'fast-check';
import {fetchNetSuiteOrderPdf} from '../../../src/netsuite-order-pdf.js';
import {fetchEstimatePdfFromNetSuite} from '../../../src/netsuite.js';

function fixture(kind,overrides={}) {
  const state={userId:81,environment:'SANDBOX',transactionType:'estimate',visible:true,searchId:51,
    content:Buffer.from('%PDF-1.7 original quotation').toString('base64'),size:29,filename:'NetSuite quote.pdf',...overrides};
  const calls={searches:[],renders:[],contents:0};
  const modules={
    'N/error':{create:options=>Object.assign(new Error(options.message),{name:options.name})},
    'N/log':{audit(){},error(){}},
    'N/record':{load(){throw new Error('Workflow-locked records must not be loaded.');}},
    'N/search':{Type:{ESTIMATE:'estimate',SALES_ORDER:'salesorder',PURCHASE_ORDER:'purchaseorder'},create:options=>{
      calls.searches.push(JSON.parse(JSON.stringify(options)));
      return {run:()=>({getRange:()=>state.visible && options.type===state.transactionType?[{id:state.searchId}]:[]})};
    }},
    'N/render':{PrintMode:{PDF:'PDF'},transaction:options=>{
      calls.renders.push(JSON.parse(JSON.stringify(options)));
      if(state.renderError) {throw new Error('Internal account details must not leak.');}
      return {name:state.filename,size:state.size,getContents:()=>{calls.contents++;return state.content;}};
    }},
    'N/runtime':{accountId:'TEST_SB1',get envType(){return state.environment;},EnvType:{SANDBOX:'SANDBOX'},
      getCurrentUser:()=>({id:state.userId,role:18}),getCurrentScript:()=>({getRemainingUsage:()=>4000})}
  };
  const path=new URL(kind==='suitelet'?'../../../netsuite-transaction-pdf-suitelet.js':'../../../netsuite-smart-scm-picking-ticket-restlet.js',import.meta.url);
  let api;
  vm.runInNewContext(readFileSync(path,'utf8'),{define:(names,factory)=>{api=factory(...names.map(name=>modules[name]));}},{filename:path.pathname});
  function call(parameters={},method='GET') {
    if(kind==='restlet') {return api[method.toLowerCase()](parameters);}
    const response={headers:{},body:null,file:null,setHeader({name,value}){this.headers[name.toLowerCase()]=value;},
      write(value){this.body=JSON.parse(typeof value==='string'?value:value.output);},
      writeFile(value){this.file=value;}};
    api.onRequest({request:{method,parameters},response});
    return response;
  }
  return {state,calls,call};
}
test('RESTlet advertises native quotation PDFs and renders only visible estimates through their saved form',()=>{
  const {call,calls}=fixture('restlet');
  const health=call({action:'health'});assert.equal(health.version,'3.4.0');assert.equal(health.capabilities.estimatePdf,true);
  for(const method of ['GET','POST']) {
    const result=call({action:'estimatePdf',entityId:'51'},method);
    assert.equal(result.ok,true);assert.equal(result.action,'estimatePdf');assert.equal(result.entityId,51);
    assert.equal(result.contentType,'application/pdf');assert.equal(result.contentEncoding,'base64');
    assert.equal(result.filename,'NetSuite-quote.pdf');assert.equal(result.contentBase64,Buffer.from('%PDF-1.7 original quotation').toString('base64'));
  }
  assert.deepEqual(calls.searches[0],{type:'estimate',filters:[['internalid','anyof',51],'and',['mainline','is','T']],columns:['internalid']});
  assert.deepEqual(calls.renders,[{entityId:51,printMode:'PDF'},{entityId:51,printMode:'PDF'}]);
  const metadata=call({action:'estimatePdf',entityId:51,includeContent:false});assert.equal(metadata.contentBase64,'');
  assert.equal(calls.contents,2);
});
test('RESTlet estimate requests reject wrong type, denied visibility, wrong ID, unsafe IDs and wrong environment before rendering',()=>{
  for(const overrides of [{transactionType:'salesorder'},{transactionType:'purchaseorder'},{visible:false},{searchId:52}]) {
    const f=fixture('restlet',overrides);
    assert.throws(()=>f.call({action:'estimatePdf',entityId:51}),{name:'MBBS_ORDER_NOT_ACCESSIBLE'});
    assert.equal(f.calls.renders.length,0);
  }
  const f=fixture('restlet');
  for(const entityId of [0,-1,1.5,'51 OR 1=1',Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(()=>f.call({action:'estimatePdf',entityId}),{name:'MBBS_INVALID_ARGUMENT'});
  }
  assert.equal(f.calls.searches.length,0);assert.equal(f.calls.renders.length,0);
  f.state.environment='PRODUCTION';
  assert.throws(()=>f.call({action:'estimatePdf',entityId:51,requireSandbox:true}),{name:'MBBS_NOT_SANDBOX'});
});
test('RESTlet quotation PDFs retain existing empty, oversized and native rendering error boundaries',()=>{
  for(const [overrides,name] of [[{content:''},'MBBS_EMPTY_PDF'],[{content:'a'.repeat(9*1024*1024+1)},'MBBS_PDF_TOO_LARGE'],[{renderError:true},'MBBS_RESTLET_FAILED']]) {
    const f=fixture('restlet',overrides);assert.throws(()=>f.call({action:'estimatePdf',entityId:51}),{name});
  }
});
test('property: estimate PDF client verifies identity and preserves the exact native bytes',async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:2147483647}),fc.uint8Array({maxLength:1000}),async(id,bytes)=>{
    const buffer=Buffer.concat([Buffer.from('%PDF-1.7\n'),bytes]);
    const document=await fetchNetSuiteOrderPdf('estimate',id,{restlet:async request=>{
      assert.deepEqual(request,{action:'estimatePdf',entityId:id,includeContent:true});
      return {ok:true,action:'estimatePdf',entityId:id,contentType:'application/pdf',contentEncoding:'base64',contentBase64:buffer.toString('base64')};
    }});
    assert.deepEqual(document.buffer,buffer);assert.equal(document.filename,`EST-${id}.pdf`);
  }),{seed:14102026,numRuns:60});
});
test('estimate PDF client rejects another action or ID, bad content, and unsupported remote quotation actions',async()=>{
  const valid={ok:true,action:'estimatePdf',entityId:51,contentType:'application/pdf',contentEncoding:'base64',contentBase64:Buffer.from('%PDF-NATIVE').toString('base64')};
  for(const patch of [{action:'salesOrderPdf'},{entityId:52},{contentType:'text/html'},{contentBase64:Buffer.from('HTML').toString('base64')}]) {
    await assert.rejects(fetchNetSuiteOrderPdf('estimate',51,{restlet:async()=>({...valid,...patch})}),{status:502});
  }
  await assert.rejects(fetchNetSuiteOrderPdf('estimate',51,{restlet:async()=>{throw new Error('MBBS_UNSUPPORTED_ACTION');}}),/MBBS_UNSUPPORTED_ACTION/);
});
test('configured quotation PDF transport uses the estimate action and preserves the original bytes',async()=>{
  const buffer=Buffer.from('%PDF-1.7 transport'),calls=[];
  const document=await fetchEstimatePdfFromNetSuite(51,{restlet:async request=>{
    calls.push(request);return {ok:true,action:'estimatePdf',entityId:51,contentType:'application/pdf',
      contentEncoding:'base64',contentBase64:buffer.toString('base64')};
  }});
  assert.deepEqual(calls,[{action:'estimatePdf',entityId:51,includeContent:true}]);
  assert.deepEqual(document.buffer,buffer);assert.equal(document.filename,'EST-51.pdf');
});
test('Suitelet health requires login and advertises all three native document actions without searching or rendering',()=>{
  const f=fixture('suitelet'),response=f.call({action:'health'});
  assert.equal(response.body.ok,true);assert.equal(response.body.capabilities.estimatePdf,true);
  assert.equal(response.body.capabilities.salesOrderPdf,true);assert.equal(response.body.capabilities.purchaseOrderPdf,true);
  assert.equal(f.calls.searches.length,0);assert.equal(f.calls.renders.length,0);
  for(const userId of [-4,-1,0,null]) {
    f.state.userId=userId;assert.equal(f.call({action:'health'}).body.code,'MBBS_LOGIN_REQUIRED');
  }
});
test('Suitelet returns each visible transaction as an inline native PDF, with its exact type and protected headers',()=>{
  for(const [action,transactionType] of [['estimatePdf','estimate'],['salesOrderPdf','salesorder'],['purchaseOrderPdf','purchaseorder']]) {
    const f=fixture('suitelet',{transactionType}),response=f.call({action,entityId:'51'});
    assert.equal(response.file.isInline,true);assert.equal(response.file.file.getContents(),f.state.content);
    assert.deepEqual(f.calls.searches,[{type:transactionType,filters:[['internalid','anyof',51],'and',['mainline','is','T']],columns:['internalid']}]);
    assert.deepEqual(f.calls.renders,[{entityId:51,printMode:'PDF'}]);
    assert.equal(response.headers['cache-control'],'private, no-store');assert.equal(response.headers['x-content-type-options'],'nosniff');
  }
});
test('Suitelet metadata excludes PDF content and preserves identity, native filename and size',()=>{
  const f=fixture('suitelet'),response=f.call({action:'estimatePdf',entityId:51,includeContent:'false'});
  assert.equal(response.file,null);assert.equal(response.body.ok,true);assert.equal(response.body.action,'estimatePdf');
  assert.equal(response.body.entityId,51);assert.equal(response.body.contentType,'application/pdf');assert.equal(response.body.fileSize,29);
  assert.equal(response.body.contentIncluded,false);assert.equal(response.body.filename,'NetSuite-quote.pdf');
  assert.equal(f.calls.contents,0);assert.equal(Object.hasOwn(response.body,'contentBase64'),false);
});
test('Suitelet denies anonymous access, wrong types, denied visibility and wrong identities before rendering',()=>{
  for(const [overrides,code] of [[{userId:-4},'MBBS_LOGIN_REQUIRED'],[{transactionType:'salesorder'},'MBBS_ORDER_NOT_ACCESSIBLE'],
    [{visible:false},'MBBS_ORDER_NOT_ACCESSIBLE'],[{searchId:52},'MBBS_ORDER_NOT_ACCESSIBLE']]) {
    const f=fixture('suitelet',overrides),response=f.call({action:'estimatePdf',entityId:51});
    assert.equal(response.body.ok,false);assert.equal(response.body.code,code);assert.equal(response.file,null);
    assert.equal(f.calls.renders.length,0);
  }
});
test('Suitelet rejects unsafe IDs, unsupported actions, non-GET methods and an incorrect environment before remote access',()=>{
  const f=fixture('suitelet');
  for(const entityId of [undefined,'',0,-1,1.5,'51 OR 1=1',Number.MAX_SAFE_INTEGER+1]) {
    assert.equal(f.call({action:'estimatePdf',entityId}).body.code,'MBBS_INVALID_ARGUMENT');
  }
  for(const action of ['updatePurchaseOrder','createSpecialSalesOrder','__proto__','constructor']) {
    assert.equal(f.call({action,entityId:51}).body.code,'MBBS_UNSUPPORTED_ACTION');
  }
  assert.equal(f.call({action:'estimatePdf',entityId:51},'POST').body.code,'MBBS_METHOD_NOT_ALLOWED');
  f.state.environment='PRODUCTION';assert.equal(f.call({action:'estimatePdf',entityId:51,requireSandbox:'true'}).body.code,'MBBS_NOT_SANDBOX');
  assert.equal(f.calls.searches.length,0);assert.equal(f.calls.renders.length,0);
});
test('Suitelet bounds PDF sizes and hides internal exception details from the response',()=>{
  const f=fixture('suitelet',{size:10*1024*1024+1});
  assert.equal(f.call({action:'estimatePdf',entityId:51}).body.code,'MBBS_PDF_TOO_LARGE');
  assert.equal(f.calls.contents,0);
  f.state.size=100;f.state.renderError=true;
  const response=f.call({action:'estimatePdf',entityId:51});
  assert.equal(response.body.code,'MBBS_PDF_FAILED');assert.equal(response.body.ok,false);
  assert.doesNotMatch(JSON.stringify(response.body),/Internal account details/);assert.equal(response.file,null);
});
test('Suitelet rejects empty or invalid file sizes and uses a safe EST filename when NetSuite omits it',()=>{
  for(const size of [0,-1,undefined,NaN]) {
    const f=fixture('suitelet',{size});assert.equal(f.call({action:'estimatePdf',entityId:51}).body.code,'MBBS_PDF_TOO_LARGE');
  }
  const f=fixture('suitelet',{filename:'',size:10*1024*1024});
  assert.equal(f.call({action:'estimatePdf',entityId:51,includeContent:'false'}).body.filename,'EST-51.pdf');
});
