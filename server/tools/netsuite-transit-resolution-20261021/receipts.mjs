import {closeDb} from './src/db.js';
import {fetchItemReceiptFromNetSuite} from './src/netsuite.js';
try {
  for(const id of [1071884,1070038]) {
    console.log(JSON.stringify({at:new Date().toISOString(),id,record:await fetchItemReceiptFromNetSuite(id)}));
  }
} finally {await closeDb();}
