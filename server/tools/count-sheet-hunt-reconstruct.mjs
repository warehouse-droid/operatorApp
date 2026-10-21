import assert from 'node:assert/strict';
import {query,closeDb} from '../src/db.js';
import {countSheetReconstructionState,reconstructCountSheetComparison} from '../src/count-sheet-reconstruction.js';
import {fetchInventoryBalancesForItemsFromNetSuite} from '../src/netsuite.js';
const args=process.argv.slice(2),apply=args.includes('--apply');
const value=key=>args[args.indexOf(key)+1];
try {
  assert.equal(value('--sheet'),'3','Explicit --sheet 3 is required.');
  const state=await countSheetReconstructionState(3);
  assert.equal(state.sheet.title,'HUNT 20261002');assert.equal(Number(state.sheet.location_id),1);assert.equal(state.sheet.status,'submitted');
  assert.deepEqual(state.assigned,[2276,2277,2278,2340,2764,4991]);
  const balances=await fetchInventoryBalancesForItemsFromNetSuite(state.assigned,[1]);
  const observedAt=new Date().toISOString();
  const result=await reconstructCountSheetComparison({sheetId:3,expectedTitle:'HUNT 20261002',
    expectedFingerprint:apply?value('--fingerprint'):state.fingerprint,balances,observedAt,rollback:!apply});
  const items=(await query('SELECT item_id,item_name,stock_unit FROM inventory_items WHERE item_id=ANY($1::bigint[])',[state.assigned])).rows;
  console.log(JSON.stringify({applied:apply,basis:'current_stock',observedAt,previewFingerprint:state.fingerprint,
    sheetId:3,title:state.sheet.title,originalSubmittedAt:state.sheet.submitted_at,
    rows:result.items.map(count=>({...items.find(item=>Number(item.item_id)===Number(count.item_id)),
      onHand:count.system_on_hand,packed:count.packed_qty,actualOnHand:count.actual_on_hand,counted:count.quantity,variance:count.variance,confirmedAt:count.confirmed_at}))},null,2));
} finally {await closeDb();}
