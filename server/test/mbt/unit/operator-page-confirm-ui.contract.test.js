// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (relativePath) => readFile(new URL(`../../../${relativePath}`, import.meta.url), "utf8");

test("Customer Pickup reuses Delivery Prep's visible-page confirmation control", async () => {
  const operator = await source("public/operator.js");
  const selectedPanel = operator.slice(
    operator.indexOf("function renderSelectedLinePanel"),
    operator.indexOf("function renderStepper")
  );
  const confirmPage = operator.slice(
    operator.indexOf("async function confirmPage"),
    operator.indexOf("async function unpackLine")
  );

  assert.match(
    selectedPanel,
    /currentModule === "delivery"[\s\S]{0,120}currentModule === "customer-pickup"/u
  );
  assert.match(selectedPanel, /data-action="confirm-page"/u);
  assert.match(confirmPage, /currentDetailPageLines\(selectedOrder\)/u);
  assert.match(confirmPage, /\/api\/customer-pickup\/orders\/\$\{encodeURIComponent\(selectedId\)\}\/lines\/confirm-page/u);
});

test("PO Receiving exposes the same page action without changing TO or Transit CO", async () => {
  const operator = await source("public/operator.js");
  const receivingPanel = operator.slice(
    operator.indexOf("function renderReceivingSelectedLinePanel"),
    operator.indexOf("function cycleStepTitle")
  );
  const receivingConfirmPage = operator.slice(
    operator.indexOf("async function confirmReceivingPage"),
    operator.indexOf("async function unconfirmReceivingLine")
  );

  assert.match(receivingPanel, /orderType === "purchase_order"/u);
  assert.match(receivingPanel, /data-action="confirm-receiving-page"/u);
  assert.match(receivingConfirmPage, /pageItems\(lines, receivingLinePage, activeLinePageSize\(\)\)/u);
  assert.match(receivingConfirmPage, /orderType:\s*"purchase_order"/u);
  assert.match(receivingConfirmPage, /\/api\/receiving\/orders\/\$\{encodeURIComponent\(receivingSelectedId\)\}\/lines\/confirm-page/u);
  assert.match(operator, /button\.dataset\.action === "confirm-receiving-page"/u);
});

test("page confirmation has a duplicate-click guard and ships in a fresh Operator cache", async () => {
  const [operator, css, html, serviceWorker] = await Promise.all([
    source("public/operator.js"),
    source("public/operator.css"),
    source("public/operator.html"),
    source("public/service-worker.js")
  ]);

  assert.match(operator, /let pageConfirming = false;/u);
  assert.match(operator, /if \(pageConfirming\) return;/u);
  assert.match(operator, /pageConfirming = true;/u);
  assert.match(operator, /pageConfirming = false;/u);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.receiving-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/u);
  assert.match(html, /operator\.css\?v=20260815-page-confirm-v1/u);
  assert.match(html, /operator\.js\?v=20260815-operator-page-confirm-v1/u);
  assert.match(serviceWorker, /mbbs-yard-operator-v141-page-confirm-v1/u);
  assert.match(serviceWorker, /operator\.css\?v=20260815-page-confirm-v1/u);
  assert.match(serviceWorker, /operator\.js\?v=20260815-operator-page-confirm-v1/u);
});

test("server exposes separate Customer Pickup and PO-only batch endpoints", async () => {
  const server = await source("src/server.js");
  assert.match(server, /confirmCustomerPickupLines/u);
  assert.match(server, /app\.post\("\/api\/customer-pickup\/orders\/:id\/lines\/confirm-page"/u);
  assert.match(server, /confirmPurchaseOrderReceivingLines/u);
  assert.match(server, /app\.post\("\/api\/receiving\/orders\/:id\/lines\/confirm-page"/u);
});
