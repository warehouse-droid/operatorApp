import crypto from "node:crypto";

import { query } from "../../src/db.js";
import { createOperator, loginOperator } from "../../src/auth-repository.js";

export async function seedOperatorPickup({ quantity = 20, loaded = 0, conversion = 1 } = {}) {
  if (process.env.MBT_TEST_ISOLATED !== "1" || !/\/mbt_test(?:_file_[\w]+)?(?:[?#]|$)/u.test(process.env.DATABASE_URL || "")) {
    throw new Error("Operator UI fixtures require the disposable test database.");
  }
  const suffix = crypto.randomUUID();
  const orderId = String(9_920_000_000 + crypto.randomInt(10_000_000));
  const username = `operator-ui-${suffix}`;
  const password = crypto.randomUUID();
  await createOperator({ username, displayName: "UI Test", password, role: "operator", yardLocationIds: [1], operatorYardLocationIds: [1] });
  const session = await loginOperator(username, password);
  const tranid = `PICKUP-UI-${suffix}`;
  await query(`INSERT INTO sales_orders (
    netsuite_id, tranid, trandate, customer, status, status_text,
    outbound_location_id, outbound_location, sales_order_type,
    operator_status, local_yard_order_status, fulfillment_status, netsuite_active
  ) VALUES ($1, $2, current_date, 'Operator UI Customer', 'B', 'Pending Fulfillment',
    1, '3445', 'Pick-Up', 'open', 'Open', 'open', true)`, [orderId, tranid]);
  const result = await query(`INSERT INTO sales_order_lines (
    sales_order_id, line_id, item_id, item_name, sku, item_description, item_type,
    quantity, unit, location_id, location, piece_qty, to_pcs, packed_piece_qty,
    loaded_qty, netsuite_active
  ) VALUES ($1, 1, 889201, 'Item A', 'ITEM-A', 'Operator UI test item', 'InvtPart',
    $2, 'PC', 1, '3445', $3, $4, 0, $5, true) RETURNING id`,
  [orderId, quantity, conversion ? quantity / conversion : 0, conversion, loaded]);
  return { orderId, lineId: String(result.rows[0].id), tranid, ...session };
}
