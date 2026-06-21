import { closeDb } from "./db.js";
import { fetchDeliveryOrdersFromNetSuite } from "./netsuite.js";
import { upsertDeliveryOrders } from "./delivery-repository.js";

const orders = await fetchDeliveryOrdersFromNetSuite();
await upsertDeliveryOrders(orders);
console.log(`Synced ${orders.length} delivery orders.`);
await closeDb();
