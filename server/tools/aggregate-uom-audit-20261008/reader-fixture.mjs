import fs from 'node:fs';

export const aggregateLine = {
  id: '1028209', tranid: 'SOB121756', status: 'B', record_type: 'SalesOrd',
  transaction_id: '1028209', line_id: '5054171', source_line_key: '5054171',
  netsuite_order_line: '1', order_line_number: '1', item_id: '9912',
  item_name: 'Aggregate-3/4 Clear Limestone', item_type: 'InvtPart',
  unit: 'Yard', unit_id: '884', unit_conversion_rate: '1.3',
  quantity: '-5.2', netsuite_received_qty: '1.3', netsuite_committed_qty: '3.9',
  netsuite_backordered_qty: '0', location_id: '1', line_location_id: '1',
  item_weight: '1300', weight_unit: 'kg', stock_conversion_rate: '1.3',
  rate: '34.61538461538461', amount: '-180'
};

export function supply(rows) {
  globalThis.__aggregateAuditRows = rows;
  globalThis.__aggregateAuditQueries = [];
}

export function loadNetSuiteReaders() {
  let source = fs.readFileSync('/app/src/netsuite.js', 'utf8');
  for (const [start, end, replacement] of [
    ['export async function suiteql(', 'async function runSuiteql(', `export async function suiteql(sql) {
      globalThis.__aggregateAuditQueries.push(sql); return { items: globalThis.__aggregateAuditRows };\n}\n\n`],
    ['export async function suiteqlAll(', 'export async function fetchTransactionReferenceByTranidFromNetSuite(', `export async function suiteqlAll(sql) {
      globalThis.__aggregateAuditQueries.push(sql); return globalThis.__aggregateAuditRows;\n}\n\n`]
  ]) {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    if (first < 0 || last <= first) throw new Error('NetSuite transport boundary changed; update the audit fixture');
    source = source.slice(0, first) + replacement + source.slice(last);
  }
  source = source.replace(/(['"])\.\//gu, '$1file:///app/src/');
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return { url, module: import(url) };
}

export async function loadReturnReaders(netSuiteUrl) {
  let source = fs.readFileSync('/app/src/return-netsuite.js', 'utf8');
  source = source.replace('"./netsuite.js"', JSON.stringify(netSuiteUrl));
  source = source.replace(/(['"])\.\//gu, '$1file:///app/src/');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
