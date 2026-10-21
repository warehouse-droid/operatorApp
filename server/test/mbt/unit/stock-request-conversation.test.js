import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { normalizeConversationMessage, conversationMessage } from '../../../src/stock-request-conversation-domain.js';
const operationId='cd35059e-c66f-4aa1-9dc4-af353c500016';
const event=(event_type,details={},extra={})=>({id:1,event_type,details,actor_name:'Sally',actor_id:'sales-user',created_at:'2026-10-16T12:00:00Z',...extra});

test('conversation accepts typed multiline messages with a stable operation ID',()=>{
  assert.deepEqual(normalizeConversationMessage({message:'  Please confirm\r\nblue.  ',operationId}),{message:'Please confirm\nblue.',operationId});
  for(const message of ['', '  ', null, 123, 'bad\0text', 'x'.repeat(4001)])assert.throws(()=>normalizeConversationMessage({message,operationId}),{status:400});
  assert.throws(()=>normalizeConversationMessage({message:'Hello',operationId:'bad'}),{status:400});
});
test('conversation reads only explicit user message fields and their original authors',()=>{
  for(const [type,details,role,message] of [
    ['stock_request_conversation_message',{message:'New reply',audience:'scm'},'scm','New reply'],
    ['regular_scm_reply',{message:'Confirm stock',eta:'2026-10-20'},'scm','Confirm stock'],
    ['regular_sales_reply',{message:'Confirmed',salesOrderRef:'SO123'},'sales','Confirmed'],
    ['special_information_requested',{question:'Which color?',reply:'Do not repeat'},'scm','Which color?'],
    ['special_information_updated',{question:'Do not repeat',reply:'Blue.'},'sales','Blue.']
  ]) {
    const result=conversationMessage(event(type,details));assert.equal(result.message,message);assert.equal(result.audience,role);assert.equal(result.actorName,'Sally');
  }
  for(const row of [event('approved',{message:'Automatic approval'}),event('stock_check',{message:'Auto stock result'}),
    event('special_internal_remark_updated',{message:'Private note'}),event('stock_request_conversation_message',{message:'System note',audience:'system'}),
    event('special_information_requested',{question:'Private'},{audience:'scm'}),event('regular_sales_reply',{message:'   '})])assert.equal(conversationMessage(row),null);
});
test('property: arbitrary audit actions never enter the conversation, even with a message field',()=>{
  fc.assert(fc.property(fc.string(),fc.string(),(type,message)=>{
    if(['stock_request_conversation_message','regular_scm_reply','regular_sales_reply','special_information_requested','special_information_updated'].includes(type))return;
    assert.equal(conversationMessage(event(type,{message,question:message,reply:message,audience:'sales'})),null);
  }),{seed:20261016,numRuns:150});
});

test('property: whitespace-only input never becomes a message',()=>{
  fc.assert(fc.property(fc.array(fc.constantFrom(' ','\t','\n','\r'),{maxLength:100}),parts=>{
    assert.throws(()=>normalizeConversationMessage({message:parts.join(''),operationId}),{status:400});
  }),{seed:20261016,numRuns:100});
});
test('property: private audiences never enter shared conversation history',()=>{
  fc.assert(fc.property(fc.constantFrom('sales','scm'),fc.string({minLength:1}).filter(value=>value.trim()),(audience,message)=>{
    assert.equal(conversationMessage(event('special_information_requested',{question:message},{audience})),null);
  }),{seed:20261016,numRuns:100});
});
