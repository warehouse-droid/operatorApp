import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, webkit } from '@playwright/test';

const moduleSource = await readFile('public/dispatch-save-journal.js', 'utf8');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/journal.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/journal.js' ? moduleSource : '<!doctype html><title>Isolated draft storage</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const reports = [];
try {
  for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await type.launch({ args: engine === 'chromium' ? ['--no-sandbox'] : [] });
    try {
      const page = await browser.newPage();
      if (engine === 'chromium') await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const result = await page.evaluate(async () => {
        const { createDispatchDraftJournal } = await import('/journal.js');
        const journal = createDispatchDraftJournal({ name: 'isolated-drafts', maxEntries: 2, maxBytes: 1024, maxRecordBytes: 512 });
        const data = { baseline: { revision: 2, digest: 'before' }, inFlight: { body: '{"commandId":"same"}' },
          pendingPayload: { orders: [{ id: 'SO-S2', raw: { zero: 0, fractional: 0.125, nested: [{ quantity: 12.3456789 }] } }] } };
        const write = journal.write('owner:date1', data);
        const asynchronous = write instanceof Promise;
        await write;
        const saved = await journal.read('owner:date1');
        await journal.write('owner:date2', { value: 2 });
        await journal.write('owner:date3', { value: 3 });
        const evicted = await journal.read('owner:date1');
        const retained = await journal.read('owner:date3');
        let oversize;
        try { await journal.write('owner:huge', { text: 'x'.repeat(2048) }); } catch (error) { oversize = error.message; }
        await journal.remove('owner:date3');
        const removed = await journal.read('owner:date3');
        const otherOwner = await journal.read('another-owner:date2');
        await journal.close();
        const reopened = createDispatchDraftJournal({ name: 'isolated-drafts' });
        const persisted = await reopened.read('owner:date2');
        await reopened.close();
        return { asynchronous, data, saved, evicted, retained, oversize, removed, otherOwner, persisted };
      });
      assert.equal(result.asynchronous, true);
      assert.deepEqual(result.saved, result.data);
      assert.equal(result.evicted, null);
      assert.deepEqual(result.retained, { value: 3 });
      assert.match(result.oversize, /large|limit/i);
      assert.equal(result.removed, null);
      assert.equal(result.otherOwner, null);
      assert.deepEqual(result.persisted, { value: 2 });
      if (engine === 'chromium') await writeFile('test-artifacts/dispatch-save-reliability/journal-v8.json', JSON.stringify(await page.coverage.stopJSCoverage()));
      reports.push({ engine, roundTrip: true, bounded: true, survivedReload: true, separatedOwners: true });
    } finally { await browser.close(); }
  }
  await writeFile('test-artifacts/dispatch-save-reliability/journal-browser.json', JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports));
} finally { await new Promise(resolve => server.close(resolve)); }
