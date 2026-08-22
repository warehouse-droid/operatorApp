import assert from "node:assert/strict";
import test from "node:test";

import { buildTransactionStatusBatchQuery } from "../../../src/netsuite.js";

test("PA-N1: status batch query accepts only positive numeric IDs and an allowlisted NetSuite record type", () => {
  const sql = buildTransactionStatusBatchQuery([9, 4, 9, 7], "SalesOrd");
  assert.match(sql, /t\.id IN \(4,7,9\)/u);
  assert.match(sql, /t\.type = 'SalesOrd'/u);
  assert.match(sql, /BUILTIN\.DF\(t\.status\) AS status_text/u);
  assert.throws(() => buildTransactionStatusBatchQuery([1, "2); DROP TABLE transaction; --"], "SalesOrd"), /numeric/i);
  assert.throws(() => buildTransactionStatusBatchQuery([1], "SalesOrd' OR '1'='1"), /record type/i);
  assert.throws(() => buildTransactionStatusBatchQuery([], "SalesOrd"), /at least one/i);
});
