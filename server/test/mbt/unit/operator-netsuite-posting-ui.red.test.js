import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [operator, gates, gatesHtml, server] = await Promise.all([
  readFile(new URL("../../../public/operator.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-gates.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-gates.html", import.meta.url), "utf8"),
  readFile(new URL("../../../src/server.js", import.meta.url), "utf8")
]);

test("U1 Operator shows the effective local/NetSuite mode and submits the exact policy revision", () => {
  assert.match(operator, /\/api\/operator\/netsuite-posting-policy\?[^"`]*functionKey=/u);
  assert.match(operator, /function renderOperatorNetSuitePostingMode/u);
  assert.match(operator, /Local only/u);
  assert.match(operator, /Creates NetSuite \$\{escapeHtml\(policy\.transactionType\)\}/u);
  assert.match(operator, /netSuitePostingPolicy:\s*operatorNetSuitePolicyToken\(/u);
  assert.match(operator, /gateKey:\s*policy\.gateKey/u);
  assert.match(operator, /revision:\s*policy\.revision/u);
  assert.match(operator, /effective:\s*policy\.effective/u);
});

test("U2 all three Operator actions use stable request IDs and wait for durable verification", () => {
  assert.match(operator, /receiptRequestId\s*=\s*createOperatorUuid\(\)/u);
  assert.match(operator, /requestId:\s*receiptRequestId/u);
  assert.match(operator, /\/api\/operator\/netsuite-posting-jobs\/\$\{jobId\}/u);
  assert.match(operator, /job\.status === "completed"/u);
  assert.match(operator, /job\.status === "attention"/u);
  assert.match(operator, /NetSuite verification needs Admin attention/u);
  assert.match(operator, /started\.status === "running"[\s\S]{0,350}pollOperatorNetSuitePostingJob/u);
  assert.match(operator, /operatorNetSuitePostingTransactions/u);
  assert.match(operator, /NetSuite transaction/u);
});

test("P8 Admin attention resume and its mandatory audit are one transaction", () => {
  assert.match(
    server,
    /app\.post\("\/api\/admin\/operator-netsuite-posting\/:id\/resume"[\s\S]*?withTransaction\(async \(\) => \{[\s\S]*?resumePublicOperatorNetSuitePostingCommand[\s\S]*?writeAudit[\s\S]*?\}\)/u
  );
  assert.match(server, /configureOperatorNetSuitePostingCompletionEvents\(emitAppEvent\)/u);
});

test("U3 Admin renders the twelve controls as a yard/function matrix and supports attention recovery", () => {
  assert.match(gatesHtml, /id="operatorNetSuiteGateMatrix"/u);
  assert.match(gatesHtml, /id="operatorNetSuiteAttention"/u);
  assert.match(gates, /gateGroup === "operator_netsuite_posting"/u);
  assert.match(gates, /operatorFunction/u);
  assert.match(gates, /yardCode/u);
  assert.match(gates, /netSuiteDirectAccessAllowed/u);
  assert.match(gates, /\/api\/admin\/operator-netsuite-posting\/attention/u);
  assert.match(gates, /\/api\/admin\/operator-netsuite-posting\/\$\{encodeURIComponent\(commandId\)\}\/resume/u);
});

test("L9/L11 Admin exposes completion-owned SO IF gates, attention actions, and historical selection", () => {
  assert.match(gatesHtml, /id="salesOrderFulfillmentGateMatrix"/u);
  assert.match(gatesHtml, /id="salesOrderFulfillmentAttention"/u);
  assert.match(gatesHtml, /id="salesOrderFulfillmentHistoricalSearch"/u);
  assert.match(gatesHtml, /Operator-loaded residual \+ completed Link PO \+ completed direct Link TO/u);
  assert.match(gates, /gateGroup === "dispatch_sales_order_fulfillment"/u);
  assert.match(gates, /\/api\/admin\/sales-order-fulfillment\/candidates/u);
  assert.match(gates, /\/api\/admin\/sales-order-fulfillment\/\$\{encodeURIComponent\(candidateId\)\}\/resolve/u);
  assert.match(gates, /\/api\/admin\/sales-order-fulfillment\/historical/u);
  assert.match(server, /app\.get\("\/api\/admin\/sales-order-fulfillment\/candidates"/u);
  assert.match(server, /app\.post\("\/api\/admin\/sales-order-fulfillment\/:id\/resolve"/u);
  assert.match(server, /app\.get\("\/api\/admin\/sales-order-fulfillment\/historical"/u);
  assert.match(server, /app\.post\("\/api\/admin\/sales-order-fulfillment\/historical"/u);
});
