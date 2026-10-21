import assert from 'node:assert/strict';
import {pool,closeDb} from '/app/src/db.js';
import {listSpecialStockCases} from '/app/src/special-stock-request-repository.js';
import {createSpecialOrderStatusCache} from '/app/src/special-stock-status-refresh.js';

pool.options.options='-c default_transaction_read_only=on -c statement_timeout=20000 -c application_name=mbbs_request_refresh_diagnostic';
const warnings=[];
const refresh=createSpecialOrderStatusCache({persist:async()=>false,logger:{error:message=>warnings.push(message)}});
try {
  assert.equal((await pool.query("SELECT current_setting('transaction_read_only') AS value")).rows[0].value,'on');
  for(const audience of ['sales','scm']) {
    const started=performance.now();
    const details=await listSpecialStockCases({audience,limit:60,...(audience==='sales'?{authorizedStoreLocationIds:[1,28,15,26]}:{})});
    const localMs=Math.round(performance.now()-started),refreshStarted=performance.now();
    const result=await refresh(details);
    assert.equal(result.updated,0,'This diagnostic never persists observed statuses');
    console.log(JSON.stringify({audience,rows:details.length,localMs,remoteRefreshMs:Math.round(performance.now()-refreshStarted),...result,warnings}));
  }
} finally {await closeDb();}
