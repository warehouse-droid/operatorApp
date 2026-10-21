import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {getScmStockRequest} from '../../src/stock-request-repository.js';
try{
  const request=await withTransaction(async()=>{await query('SET TRANSACTION READ ONLY');return getScmStockRequest(122);});
  assert.equal(request.requestRef,'STREQ-000082');assert.equal(request.lines.length,4);
  const helper=await readFile('src/regular-stock-line-actions.js','utf8');assert.ok(helper.includes('Choose one material line.'));
  for(const audience of ['sales','scm']){
    const response=await fetch(`http://127.0.0.1:3000/${audience}-stock-requests.html`);assert.equal(response.status,200);
    assert.ok((await response.text()).includes('lineActions=20261006-v1'));
  }
  console.log(JSON.stringify({request:request.requestRef,revision:request.revision,status:request.status,
    lines:request.lines.map(line=>({id:line.id,itemName:line.itemName,status:line.status,resolution:line.resolution})),verification:'Read-only live request and served pages verified'}));
}finally{await closeDb();}
