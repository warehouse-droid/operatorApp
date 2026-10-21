import { query, withTransaction, closeDb } from './src/db.js';
import { config } from './src/config.js';
import { getSalesOrderPoAllocationOptions } from './src/dispatch-repository.js';

config.netsuite.directAccessEnabled = false;
const pick = (row, names) => Object.fromEntries(names.filter(key => key in row).map(key => [key, row[key]]));
try {
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const options = await getSalesOrderPoAllocationOptions('SOM06964');
    const exactIds = options.salesLines.flatMap(line => line.poCandidates.filter(candidate => candidate.exactMatch).map(candidate => candidate.poLineId));
    const relevant = options.poLines.filter(line => exactIds.includes(line.id) || /StoneArch|Rockface|Onyx|Pier Caps|28x28/i.test(line.description));
    const poIds = [...new Set(relevant.map(line => line.orderId))];
    const headers = (await query('SELECT * FROM purchase_orders WHERE netsuite_id = ANY($1::bigint[])', [poIds])).rows;
    const cases = (await query(`SELECT * FROM sales_special_stock_cases WHERE sales_order_ref = 'SOM06964'
      OR sales_order_netsuite_id = 1049213 OR purchase_order_netsuite_id = ANY($1::bigint[])`, [poIds])).rows;
    const allocations = (await query(`SELECT id, sales_order_ref, dispatch_target_ref, po_order_ref,
      po_line_id, allocated_sales_qty, allocated_piece_qty, status
      FROM dispatch_so_po_allocations WHERE po_order_id = ANY($1::bigint[]) ORDER BY id`, [poIds])).rows;
    return {
      readOnly: true,
      salesLines: options.salesLines.map(line => pick(line, ['id','targetLineKey','lineId','itemId','sku','description','required','allocated','poCandidates'])),
      poLines: relevant.map(line => pick(line, ['id','orderId','poRef','originalPoRef','vendor','description','required','allocated','available','statusText'])),
      headers: headers.map(row => pick(row, ['netsuite_id','tranid','dispatch_ref','status','status_text','trandate','memo','netsuite_active','created_at','updated_at','last_synced_at','linked_sales_order_ref','source_order_ref'])),
      specialCases: cases.map(row => pick(row, ['id','request_id','sales_order_ref','sales_order_netsuite_id','sales_order_source','purchase_order_ref','purchase_order_netsuite_id','purchase_order_custom_linkage','purchase_order_reference','purchase_order_status','created_at','updated_at','status','close_status','attention_reason'])),
      allocations
    };
  });
  console.log(JSON.stringify(result, null, 2));
} finally { await closeDb(); }
