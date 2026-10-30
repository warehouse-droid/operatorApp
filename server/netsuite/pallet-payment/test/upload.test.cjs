const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// Oracle specifies that JSDoc tag values end at a line break, not at */.
// https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/bridgehead_4387808259.html
const files = ['ppa_config.js', 'ppa_core.js', 'ppa_netsuite.js', 'ppa_service.js', 'ppa_rebuild_mr.js',
  'ppa_refresh_queue.js', 'ppa_watch_ue.js', 'ppa_dispatch_ss.js'];
const entrypoints = { 'ppa_rebuild_mr.js': 'MapReduceScript', 'ppa_watch_ue.js': 'UserEventScript', 'ppa_dispatch_ss.js': 'ScheduledScript' };
for (const file of files) {
  test(`NetSuite upload JSDoc is valid: ${file}`, () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const block = source.match(/^\/\*\*[\s\S]*?\*\//)?.[0];
    assert.ok(block, 'The file must start with a JSDoc block');
    const values = tag => Array.from(block.matchAll(new RegExp(`@${tag}[ \\t]+([^\\r\\n]*)`, 'g')), match => match[1].trim());
    assert.deepEqual(values('NApiVersion'), ['2.1'], 'The API version line must contain only 2.1, with the closing delimiter on a later line');
    assert.deepEqual(values('NScriptType'), entrypoints[file] ? [entrypoints[file]] : []);
    assert.match(block, /^\/\*\*\r?\n/);
    assert.match(block, /\r?\n[ \t]*\*\/$/);
  });
}
