// Diagnostic only: the original benchmark and its timing gates remain unchanged.
// Run through the same disposable browser runner, with baseline/candidate mounts.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let source = await readFile(new URL('./order-update-save-benchmark.mjs', import.meta.url), 'utf8');
function inject(before, after) {
  assert.equal(source.split(before).length, 2, `Expected one instrumentation point: ${before}`);
  source = source.replace(before, after);
}
inject("from '../test/dispatch/support/dispatch-v2-fixture.js'", "from 'file:///app/test/dispatch/support/dispatch-v2-fixture.js'");
inject("from '../src/db.js'", "from 'file:///app/src/db.js'");
inject("from '@playwright/test'", `from ${JSON.stringify(import.meta.resolve('@playwright/test'))}`);
inject('const reports = [];', 'const reports = [], profiles = [];');
inject('startupTrace ? 1 : 8', 'startupTrace ? 1 : 3');
inject('localStorage.setItem(\'mbbs.staff.token\', token);', `
        window.__orderUpdateReady = null;
        const observer = new MutationObserver(() => {
          if (window.__orderUpdateReady !== null) return;
          const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Enter Edit Mode');
          if (button && !button.disabled && button.getClientRects().length) {
            window.__orderUpdateReady = performance.now();
            observer.disconnect();
          }
        });
        observer.observe(document, { subtree: true, childList: true, attributes: true });
        localStorage.setItem('mbbs.staff.token', token);`);
inject("await page.getByRole('button', { name: 'Exit Edit' }).waitFor();", `
        await page.getByRole('button', { name: 'Exit Edit' }).waitFor();
        await page.evaluate(() => {
          window.__orderUpdateProfile = { actualReadyMs: window.__orderUpdateReady, orderCount: orders.length, calls: {} };
          for (const name of ['normalizePlanBeforeSave', 'captureUndoPointIfNeeded', 'autoSavePlan', 'render',
            'clearInvalidEndingTrips', 'markLocalPlanDirty', 'planPayload', 'commitPlanMutation']) {
            const original = window[name];
            if (typeof original !== 'function') continue;
            window[name] = function (...args) {
              const start = performance.now();
              try { return original.apply(this, args); }
              finally { (window.__orderUpdateProfile.calls[name] ||= []).push(performance.now() - start); }
            };
          }
        });`);
inject('const savedAt = performance.now();', `
        profiles.push({ engine, run, ...(await page.evaluate(() => window.__orderUpdateProfile)) });
        const savedAt = performance.now();`);
inject('browser-${mode}${startupTrace', 'profile-${mode}${startupTrace');
inject('JSON.stringify({ mode, reports, startedAt,', 'JSON.stringify({ mode, reports, profiles, diagnosticOnly: true, startedAt,');
inject('console.log(JSON.stringify({ mode, reports }));', 'console.log(JSON.stringify({ mode, reports, profiles, diagnosticOnly: true }));');
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
