// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (relativePath) => readFile(new URL(`../../../${relativePath}`, import.meta.url), "utf8");

test("S1/S6: migration defaults the independent audited Admin gate on without overwriting", async () => {
  const [migration, catalog] = await Promise.all([
    source("migrations/165_operator_customer_pickup_photo_gate.sql"),
    source("src/mbt/feature-gate-catalog.js")
  ]);
  assert.match(
    migration,
    /'operator_customer_pickup_photo_required'\s*,\s*true\s*,/u
  );
  assert.match(migration, /ON CONFLICT \(flag_key\) DO NOTHING/u);
  assert.match(
    catalog,
    /flagKey:\s*"operator_customer_pickup_photo_required"[\s\S]{0,700}independent:\s*true[\s\S]{0,200}locked:\s*false/u
  );
});

test("S2/S3/S5: completion route accepts optional input but repository owns live enforcement", async () => {
  const [server, repository] = await Promise.all([
    source("src/server.js"),
    source("src/delivery-repository.js")
  ]);
  const route = server.match(
    /app\.post\("\/api\/customer-pickup\/orders\/:id\/load"[\s\S]*?\n\}\);/u
  )?.[0] || "";
  assert.match(route, /requiredPhotoDataUrls\(req\.body\?\.photoDataUrls,\s*0\)/u);
  assert.doesNotMatch(route, /req\.body\?\.(?:required|requiredPhotoCount|revision)/u);

  const completion = repository.slice(
    repository.indexOf("export async function recordCustomerPickupLoad"),
    repository.indexOf("export async function recordDeliveryFulfillmentFailure")
  );
  assert.match(completion, /getOperatorCustomerPickupPhotoRequirement\(\)/u);
  assert.match(completion, /requirePhotoReferences\(photoDataUrls,\s*photoRequirement\.requiredPhotoCount\)/u);
  assert.match(completion, /photoRequirementRevision/u);
  assert.match(completion, /photoEvidenceCount/u);
});

test("S6/S7: Operator receives a no-store live policy and refreshes it at entry and confirmation", async () => {
  const [server, operator] = await Promise.all([
    source("src/server.js"),
    source("public/operator.js")
  ]);
  const configRoute = server.match(
    /app\.get\("\/api\/customer-pickup\/config"[\s\S]*?\n\}\);/u
  )?.[0] || "";
  assert.match(configRoute, /Cache-Control[^\n]*no-store|cache-control[^\n]*no-store/iu);
  assert.match(configRoute, /getOperatorCustomerPickupPhotoRequirement/u);

  const start = operator.slice(
    operator.indexOf("async function startFulfillment"),
    operator.indexOf("function stopFulfillmentCamera")
  );
  const confirm = operator.slice(
    operator.indexOf("async function confirmFulfillment"),
    operator.indexOf("async function pollFulfillmentJob")
  );
  assert.match(start, /refreshCustomerPickupPhotoRequirement/u);
  assert.match(confirm, /refreshCustomerPickupPhotoRequirement/u);
  assert.match(confirm, /uploadedPhotoRefs\s*=\s*photos\.length/u);
  assert.match(confirm, /:\s*\[\]/u);
  assert.doesNotMatch(confirm, /body:[\s\S]{0,180}(?:requiredPhotoCount|photoRequirementRevision)/u);
});

test("S7/S8: Customer Pickup can be optional while ordinary Delivery stays at two photos", async () => {
  const operator = await source("public/operator.js");
  const fulfillment = operator.slice(
    operator.indexOf("function renderFulfillmentScreen"),
    operator.indexOf("function renderLine(line)")
  );
  assert.match(fulfillment, /customerPickupRequiredPhotoCount/u);
  assert.match(fulfillment, /operator\.customerPickupPhotoOptional/u);
  assert.match(operator, /function fulfillmentRequiredPhotoCount/u);
  assert.match(
    operator,
    /if \(currentModule === "customer-pickup-load"\) return customerPickupRequiredPhotoCount\(\);/u
  );
  assert.match(operator, /return 2;/u);
});

test("S7: Operator cache revision ships the live-policy client once; later toggles are server-only", async () => {
  const [html, serviceWorker] = await Promise.all([
    source("public/operator.html"),
    source("public/service-worker.js")
  ]);
  assert.match(html, /operator\.js\?v=20260815-customer-pickup-photo-gate-v1/u);
  assert.match(serviceWorker, /mbbs-yard-operator-v140-customer-pickup-photo-gate-v1/u);
  assert.match(serviceWorker, /operator\.js\?v=20260815-customer-pickup-photo-gate-v1/u);
});
