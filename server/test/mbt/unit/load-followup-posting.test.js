import assert from 'node:assert/strict';
import test from 'node:test';
import {createOperatorNetSuitePostingProcessor} from '../../../src/operator-netsuite-posting-service.js';
import {verifyOperatorNetSuitePostingRecord} from '../../../src/operator-netsuite-posting-adapter.js';
for(const scenario of ['mismatch','recovery-timeout','wrong-source','wrong-external'])test(`extra positive IF line remains held without reposting: ${scenario}`,async()=>{
 const step={id:1,status:'pending',sourceOrderKind:'SO',sourceNetSuiteId:995451,transactionType:'IF',externalId:'fixture-external',payload:{item:{items:[{orderLine:1,quantity:2,location:1,itemReceive:true}]}}};
 const record={id:996410,tranId:'IF153890',externalId:step.externalId,createdFrom:{id:995451},transactionType:'IF',item:{items:[{orderLine:1,quantity:2,location:1},{orderLine:8,quantity:2,location:1}]}};
 if(scenario==='wrong-source')record.createdFrom.id=995452;
 if(scenario==='wrong-external')record.externalId='different-command';
 const command={id:'fixture',status:'queued',leaseToken:'fixture-lease',steps:[step],inputSnapshot:{postingStrategy:'stored_order_line_v1'}};
 let attempts=0,posts=0,failure;
 const repository={get:async()=>command,claim:async()=>command,renew:async()=>{},startAttempt:async()=>({attemptNumber:++attempts,fresh:attempts===1}),
  failure:async input=>{failure=input;step.status='uncertain';return step;},attention:async()=>{command.status='attention';return command;},
  success:async()=>assert.fail('Unexpected extra line must not be accepted'),complete:async()=>assert.fail('Must not complete'),fail:async()=>assert.fail('Must retain uncertain claim')};
 const processor=createOperatorNetSuitePostingProcessor({repository,workerId:'test',finalize:async()=>assert.fail('Must not finalize'),adapter:{transform:async()=>{posts++;return{id:record.id};},fetchById:async()=>record,findByExternalId:async()=>{if(scenario==='recovery-timeout')throw Object.assign(new Error('Verification lookup timed out'),{code:'ETIMEDOUT'});return record;},verify:verifyOperatorNetSuitePostingRecord}});
 await processor.process(command.id);
 assert.equal(command.status,'attention');assert.equal(failure.uncertain,true);
 assert.deepEqual(failure.observedTransaction,scenario.startsWith('wrong-')?undefined:{id:996410,tranId:'IF153890',externalId:'fixture-external'});
 command.status='queued';await processor.process(command.id);assert.equal(posts,1);
});
