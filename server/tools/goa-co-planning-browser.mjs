import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { browserSource, sampleCo } from '../test/support/goa-co-browser.mjs';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: browserSource() });
  const result = await page.evaluate(co => {
    const ui = globalThis.goaCoFunctions;
    globalThis.orderById = () => undefined;
    globalThis.orderAssignment = () => ({});
    globalThis.dispatchPlannedAssignment = () => null;
    const order = ui.normalizeOrder(co);
    return { route: ui.movementText(order), source: order.sourceYard, destination: order.destinationYard,
      pickups: order.pickupLocations, waiting: order.dependencyWaitingForTransfer,
      dependencies: order.orderDependencies, blocked: ui.replenishmentPlacementBlockMessage(order, {}, { stops: [] }),
      sourceDeliveryBlocked: ui.replenishmentPlacementBlockMessage(co.childOrderDetails[0], {}, { stops: [] }) };
  }, sampleCo());
  assert.equal(result.route, '2967 to 3445');
  assert.deepEqual(result.pickups, ['2967']);
  assert.equal(result.waiting, false);
  assert.deepEqual(result.dependencies, []);
  assert.equal(result.blocked, '');
  assert.match(result.sourceDeliveryBlocked, /requires TOB01180/u);
  writeFileSync('test-artifacts/goa-co-planning-20261001/browser.json', JSON.stringify({ passed: true, result }, null, 2));
  console.log(JSON.stringify({ chromium: browser.version(), ...result }));
} finally {
  await browser.close();
}
