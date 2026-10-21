// Read-only NetSuite schema check; uses a reserved, nonexistent local identity.
import assert from 'node:assert/strict';
import {suiteql} from '../src/netsuite.js';
import {withOperatorNetSuitePriority} from '../src/operator-netsuite-request-pool.js';
import {closeDb} from '../src/db.js';
try {
 const result=await withOperatorNetSuitePriority(()=>suiteql(`SELECT t.id FROM transaction t
   WHERE t.type = 'TrnfrOrd' AND UPPER(t.externalid) = 'MBBS_REGULAR_STOCK_0_0'
   FETCH FIRST 1 ROWS ONLY`));
 assert.equal(result.items.length,0);
 console.log(JSON.stringify({readOnly:true,externalIdQuerySupported:true,orderWrites:0}));
}finally{await closeDb();}
