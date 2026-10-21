import assert from 'node:assert/strict';
import {query,pool} from '../src/db.js';
import {fetchInventoryBalancesForItemsFromNetSuite} from '../src/netsuite.js';
import {packedInventorySnapshot} from '../src/inventory-packed-stock.js';
try {
  const sheets=(await query("SELECT id,title,location_id,status,attempt FROM inventory_count_sheets WHERE title='HUNT 20261002'")).rows;
  assert.equal(sheets.length,1);
  const sheet=sheets[0];
  const items=(await query(`SELECT i.item_id,i.item_name,i.stock_unit,c.quantity,c.system_on_hand,c.system_available,c.inventory_synced_at,c.confirmed_at
    FROM inventory_count_sheet_items si JOIN inventory_items i ON i.item_id=si.item_id
    LEFT JOIN inventory_count_sheet_counts c ON c.sheet_id=si.sheet_id AND c.item_id=si.item_id AND c.attempt=$2
    WHERE si.sheet_id=$1 ORDER BY si.position`,[sheet.id,sheet.attempt])).rows;
  const live=await fetchInventoryBalancesForItemsFromNetSuite(items.map(item=>Number(item.item_id)),[Number(sheet.location_id)]);
  const packed=await packedInventorySnapshot(items.map(item=>Number(item.item_id)),Number(sheet.location_id));
  const result={checkedAt:new Date().toISOString(),readOnly:true,sheet,items:items.map(item=>{
    const row=live.find(value=>Number(value.item_id)===Number(item.item_id) && Number(value.location_id)===Number(sheet.location_id));
    assert.ok(row,`Missing SKU ${item.item_name}`);
    const packing=packed.get(Number(item.item_id)),actualOnHand=Number((Number(row.quantity_on_hand)-packing.quantity).toFixed(6));
    return {...item,currentOnHand:row.quantity_on_hand,currentAvailable:row.quantity_available,packed:packing.quantity,
      actualOnHand,variance:Number((Number(item.quantity)-actualOnHand).toFixed(6)),packedSources:packing.lines};
  })};
  console.log(JSON.stringify(result,null,2));
} finally {await pool.end();}
