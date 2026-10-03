import {withTransaction} from './db.js';
import {inventoryError,inventoryId,assertInventoryYard,inventoryYards} from './inventory-workflow-domain.js';
import {fetchInventoryBalancesForItemsFromNetSuite} from './netsuite.js';
import {upsertInventoryBalancesBulk,confirmCycleCountLine} from './inventory-repository.js';
import {validateRows} from './count-sheet-stock-refresh.js';

export function blindCycleCount(draft) {
  return {...draft,lines:draft.lines.map(line=>{
    const safe={...line};
    for(const key of ['system_on_hand_qty','system_available_qty','system_packed_qty','actual_on_hand_qty','variance_qty']) {delete safe[key];}
    return safe;
  })};
}

export async function confirmFreshCycleCount(actor,values,{fetchBalances=fetchInventoryBalancesForItemsFromNetSuite}={}) {
  const locationId=assertInventoryYard(actor,values.locationId),itemId=inventoryId(values.itemId,'SKU');
  let rows;
  try {
    rows=await fetchBalances([itemId],[locationId]);
    validateRows(rows,[itemId],locationId);
  } catch {throw inventoryError('Could not refresh this SKU\'s stock. Please retry confirmation.',503,'CYCLE_COUNT_REFRESH_FAILED');}
  return withTransaction(async()=>{
    await upsertInventoryBalancesBulk(rows);
    return blindCycleCount(await confirmCycleCountLine(actor.id,values,{yardLocationIds:inventoryYards(actor)}));
  });
}
