import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync('public/control.js', 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('U1 admin aggregate controls display fixed scope, schedule, last run and next run', () => {
  const context = vm.createContext({ scmReconciliationSettings: { aggregateNightlyEnabled: true, aggregateNightlyTime: '22:15', aggregateNightlySchedule: { reason: 'already_attempted', nextRun: { localDate: '2026-10-23', localTime: '22:15', timeZone: 'America/Toronto' } }, aggregateNightlyLastRun: { id: 123, status: 'interrupted' } }, scmReconciliationBusy: false, scmReconciliationSettingsLoaded: true, escapeHtml: value => String(value) });
  const code = between('function renderAggregateNightlySettings()', 'function renderScmReconciliationSection()');
  assert.ok(code, 'Dedicated aggregate controls must exist');
  vm.runInContext(code, context);
  const html = context.renderAggregateNightlySettings();
  assert.match(html, /Pending Fulfillment/); assert.match(html, /Delivery and Pick-Up/);
  assert.match(html, /name="aggregateNightlyEnabled"[^>]*checked/);
  assert.match(html, /name="aggregateNightlyTime"[^>]*value="22:15"/);
  assert.match(html, /2026-10-23/); assert.match(html, /#123/); assert.match(html, /interrupted/);
});

test('U1 saving aggregate controls posts only its two settings and reloads the saved values', async () => {
  let sent;
  const context = vm.createContext({ scmReconciliationSettingsLoaded: true, scmReconciliationBusy: false, scmReconciliationSettings: {}, scmReconciliationLoadError: '', render() {}, alert() {}, normalizeScmReconciliationSettings: value => value.settings,
    request: async (url, input) => { sent = { url, ...JSON.parse(input.body) }; return { settings: { aggregateNightlyEnabled: false, aggregateNightlyTime: '23:45' } }; } });
  const code = between('async function saveAggregateNightlySettings(', 'async function saveScmReconciliationSettings(');
  assert.ok(code, 'Aggregate save handler must exist'); vm.runInContext(code, context);
  await context.saveAggregateNightlySettings({ elements: { aggregateNightlyEnabled: { checked: false }, aggregateNightlyTime: { value: '23:45' } } });
  assert.deepEqual(sent, { url: '/api/control/scm-reconciliation/settings', aggregateNightlyEnabled: false, aggregateNightlyTime: '23:45' });
  assert.equal(context.scmReconciliationSettings.aggregateNightlyTime, '23:45');
});
