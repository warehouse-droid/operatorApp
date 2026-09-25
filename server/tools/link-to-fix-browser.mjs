/* global window, document */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parse } from 'espree';
import { chromium } from '@playwright/test';

const folder = `test-artifacts/link-to-fix/${process.argv[2] || 'final'}`;
mkdirSync(folder, { recursive: true });
const source = readFileSync('public/dispatch.js', 'utf8');
const names = ['renderSelectedOrderActions', 'renderToLinkModal', 'renderDependencyLinks', 'escapeHtml'];
const functions = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true }).body
  .filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name))
  .map(node => source.slice(...node.range)).join('\n');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.setContent(`<style>${readFileSync('public/dispatch.css', 'utf8')}</style><div id="panel"></div><div id="modal"></div>`);
  await page.addScriptTag({ content: functions });
  await page.evaluate(() => {
    const order = { id: 'GOM-6531-6537-VERY-LONG-GROUP-REFERENCE', type: 'SO',
      childOrders: ['SOM06531', 'SOM06537'], transitCo: { id: 'CO-GOM-6531-6537' } };
    Object.assign(window, {
      activeOrderType: 'SO', selectedOrder: () => order, selectedOrders: () => [order],
      isDispatchPlanningRestricted: () => false, isReviewOnlyOrder: () => false,
      isScmReconciliationBlocked: () => false, groupedOrderTransitCoId: () => order.transitCo.id,
      supportsTransitCoForOrder: () => true, isSalesOrderReattempt: () => false,
      canConsolidatePick: () => true, SALES_PLANNING_HOST: false,
      orderDependencyOptions: null, orderDependencyLoading: false, orderDependencyError: '',
      getLinkModalDraft: () => ({ ref: 'TOB01103', mode: 'direct_to_customer', quantities: {} })
    });
    document.addEventListener('click', event => {
      if (event.target.closest('[data-action="open-to-link-modal"]')) {
        document.getElementById('modal').innerHTML = window.renderToLinkModal(order);
      }
    });
  });
  for (const width of [280, 320, 390, 480, 760]) {
    await page.evaluate(panelWidth => {
      document.getElementById('modal').innerHTML = '';
      const panel = document.getElementById('panel');
      panel.style.cssText = `width:${panelWidth}px;margin:20px;background:white;padding:8px;box-sizing:border-box`;
      panel.innerHTML = window.renderSelectedOrderActions();
    }, width);
    const geometry = await page.evaluate(() => {
      const panel = document.getElementById('panel').getBoundingClientRect();
      const entries = [...document.querySelectorAll('.selected-order-actions > *')].map(node => {
        const box = node.getBoundingClientRect();
        return { label: node.textContent.trim(), button: node.tagName === 'BUTTON',
          left: box.left, right: box.right, top: box.top, bottom: box.bottom,
          clipped: node.tagName === 'BUTTON' && node.scrollWidth > node.clientWidth + 1 };
      });
      const overlaps = entries.flatMap((left, i) => entries.slice(i + 1).filter(right =>
        left.left < right.right - 0.5 && right.left < left.right - 0.5
        && left.top < right.bottom - 0.5 && right.top < left.bottom - 0.5).map(right => [left.label, right.label]));
      return { overlaps, outside: entries.filter(row => row.left < panel.left || row.right > panel.right),
        clipped: entries.filter(row => row.clipped), buttonCount: entries.filter(row => row.button).length };
    });
    await page.screenshot({ path: `${folder}/actions-${width}.png` });
    let clickable = false;
    try {
      await page.locator('[data-action="open-to-link-modal"]').click({ timeout: 1500 });
      clickable = await page.locator('[data-form="to-link"]').isVisible();
    } catch { /* Record the failed pointer test alongside its geometry. */ }
    results.push({ width, ...geometry, clickable });
  }
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => { document.getElementById('modal').innerHTML = window.renderToLinkModal(window.selectedOrder()); });
    const fits = await page.evaluate(() => {
      const controls = document.querySelector('.to-link-ref-control');
      const input = controls.querySelector('input').getBoundingClientRect();
      const button = controls.querySelector('button').getBoundingClientRect();
      return input.right <= button.left && button.right <= controls.getBoundingClientRect().right + 1;
    });
    results.push({ modalWidth: width, matchControlsFit: fits });
    await page.screenshot({ path: `${folder}/modal-${width}.png` });
  }
  writeFileSync(`${folder}/browser.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  assert.ok(results.every(row => row.modalWidth ? row.matchControlsFit
    : row.clickable && row.buttonCount >= 5 && !row.overlaps.length && !row.outside.length && !row.clipped.length),
  'Link TO and adjacent controls must fit and remain clickable');
} finally { await browser.close(); }
