import assert from 'node:assert/strict';
import {suiteql} from './src/netsuite.js';
import {closeDb} from './src/db.js';
try {
  const result=await suiteql("SELECT t.id,t.tranid,t.memo,t.custbody7 AS netsuite_note FROM transaction t WHERE t.id=1030348 AND t.type='PurchOrd'");
  const row=result.items?.[0];
  assert.equal(Number(row?.id),1030348);
  assert.equal(row.tranid,'POB03976');
  assert.equal(row.netsuite_note,'for SOB121819');
  assert.equal(row.memo,'Pickering Yard - Unilock');
  console.log(JSON.stringify({readOnly:true,suiteqlPoNote:true,poRef:row.tranid,note:row.netsuite_note,memo:row.memo}));
} finally {await closeDb();}
