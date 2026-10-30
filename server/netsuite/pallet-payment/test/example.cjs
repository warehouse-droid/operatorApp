// Standalone policy execution using the customer's example and observed memo syntax.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let core;
const filename = path.resolve('ppa_core.js');
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { define(_deps, factory) { core = factory(); } }, { filename });
const scope = { customer: '1', subsidiary: '1', currency: '1', date: '2026-01-01' };
const input = { customer: '1', invoices: [{ ...scope, id: '100', so: '90', lines: [{ line: '1001', qty: 6, net: 4000, gross: 4520 }] }],
  payments: [{ ...scope, id: '201', source: '201', invoice: '100', method: '1', memo: '', amount: 22000 },
    { ...scope, id: '202', source: '202', invoice: '100', method: '5', memo: 'SOB123456 / 0070', amount: 80000 }],
  credits: [], manual: [], physical: 6, issues: [] };
const result = core.build(input);
console.log('Standalone example:', JSON.stringify({ verified: result.verified, lots: result.allocations.map(a => ({
  method: core.methods[a.method], last4: a.last4, pallets: a.qty, unitAmount: a.rate / 100, amount: a.qty * a.rate / 100
})) }));
if (!result.verified) { process.exit(1); }
