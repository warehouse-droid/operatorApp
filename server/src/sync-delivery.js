import { closeDb } from "./db.js";
import { fetchDeliveryOrdersFromNetSuite } from "./netsuite.js";
import { upsertSalesOrders } from "./order-sync-repository.js";

const orders = await fetchDeliveryOrdersFromNetSuite();
await upsertSalesOrders(orders);
console.log(`Synced ${orders.length} delivery orders.`);
await closeDb();
