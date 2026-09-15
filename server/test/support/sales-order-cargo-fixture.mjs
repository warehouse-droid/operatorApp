import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";

// Execute production functions with only their transport/browser environment
// supplied by the test. Retain offsets for changed-line V8 coverage.
export function cargoFunctions(relativeFile, names, dependencies = {}) {
  const file = new URL(relativeFile, import.meta.url);
  const source = fs.readFileSync(file, "utf8");
  let body = source.replace(/[^\n\r]/gu, " ");
  for (const name of names) {
    const start = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "mu").exec(source);
    assert.ok(start, `Missing production function ${name}`);
    const end = /^\}/mu.exec(source.slice(start.index));
    assert.ok(end, `Missing function end ${name}`);
    const finish = start.index + end.index + 1;
    body = body.slice(0, start.index) + source.slice(start.index, finish).replace(/^export /u, "       ") + body.slice(finish);
  }
  return compileFunction(`${body}\nreturn {${names.join(",")}};`, Object.keys(dependencies), {
    filename: fileURLToPath(file)
  })(...Object.values(dependencies));
}

export const soLines = [
  { line_id: 4928727, item_id: 3632, item_name: "UNI-WIN70T-RDM-GN", quantity: "735.04", netsuite_received_qty: "735.04", pallet_qty: 8 },
  { line_id: 4928728, item_id: 8472, item_name: "UNI-WIN70S-0714-DC-2026", quantity: "61.25", netsuite_received_qty: "61.25", layer_qty: 5 },
  { line_id: 4928729, item_id: 1256, item_name: "BWS-GD-CURB-CHAR", quantity: "37", netsuite_received_qty: "25" },
  { line_id: 4928730, item_id: 1219, item_name: "UNI-PISA2-COP-GN", quantity: "4", netsuite_received_qty: "4" },
  { line_id: 4928731, item_id: 1142, item_name: "UNI-PISA2-COR-GN", quantity: "4", netsuite_received_qty: "4" },
  { line_id: 4928732, item_id: 1134, item_name: "UNI-PISA2-STD-GN", quantity: "12", netsuite_received_qty: "12" },
  { line_id: 4928733, item_id: 1987, item_name: "DeliveryCharge", quantity: "1", netsuite_received_qty: "0" }
].map((line) => ({ ...line, transaction_id: 986406 }));

export function netsuiteCargoReader(rows = soLines) {
  const queries = [];
  const read = async (sql) => {
    queries.push(sql);
    const where = sql.slice(sql.indexOf("WHERE"));
    // Model SuiteQL's fulfilled-line eligibility at the external read boundary.
    return structuredClone(where.includes("quantityshiprecv")
      ? rows.filter((line) => Math.abs(Number(line.quantity)) - Math.abs(Number(line.netsuite_received_qty)) > 0.000001)
      : rows);
  };
  const functions = cargoFunctions("../../src/netsuite.js", [
    "openLineQuantitySql", "openLineFilterSql", "excludedSalesOrderPrefixSql",
    "outboundStatusFilterSql", "receivingStatusFilterSql", "purchaseReceivingStatusFilterSql",
    "deliveryOrderListQuery", "purchaseOrderListQuery", "transferOrderListQuery",
    "toNumber", "derivePackQuantitiesFromConversion", "hasConversion",
    "deriveQuantitiesFromSalesQuantity", "normalizeOpenDeliveryLine",
    "fetchDeliveryOrderDetailsFromNetSuite", "fetchDeliveryOrderDetailsBatchFromNetSuite",
    "fetchDeliveryOrdersFromNetSuite", "fetchSovPendingFulfillmentOrdersFromNetSuite",
    "fetchDeliveryOrderFromNetSuite", "fetchCustomerPickupOrderFromNetSuite"
  ], { EXCLUDED_SALES_ORDER_PREFIXES: ["SOT"], suiteql: async (sql) => ({ items: await read(sql) }), suiteqlAll: read });
  return { ...functions, queries };
}
