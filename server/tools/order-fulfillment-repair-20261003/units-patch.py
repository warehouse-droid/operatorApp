"""Add native UOM evidence to the existing SuiteQL transaction boundaries."""
from pathlib import Path
import sys
p=Path(sys.argv[1] if len(sys.argv)>1 else '/home/ubuntu/operatorapp-investigations/operator-review-navigation-20261003/candidate/src/netsuite.js')
s=p.read_text()
assert 'normalizeNetSuiteTransactionUnits' not in s
s="import { normalizeNetSuiteTransactionUnits } from './netsuite-transaction-units.js';\n"+s
s=s.replace('function normalizeOpenDeliveryLine(line) {','function normalizeOpenDeliveryLine(line) {\n  line = normalizeNetSuiteTransactionUnits(line);',1)
def edit(name,change):
 global s
 start=s.index(('export async function ' if 'export async function '+name in s else 'async function ')+name+'(')
 end=s.find('\nexport ',start+10)
 # Private reconciliation function is followed by a constant then the public reader.
 if end<0:end=len(s)
 chunk=s[start:end];new=change(chunk);assert new!=chunk,name;s=s[:start]+new+s[end:]
def metadata(chunk):
 assert 'BUILTIN.DF(tl.units) AS unit,' in chunk
 chunk=chunk.replace('BUILTIN.DF(tl.units) AS unit,','BUILTIN.DF(tl.units) AS unit,\n      tl.units AS unit_id, uom.conversionrate AS unit_conversion_rate,',1)
 assert 'LEFT JOIN item i ON i.id = tl.item' in chunk
 return chunk.replace('LEFT JOIN item i ON i.id = tl.item','LEFT JOIN item i ON i.id = tl.item\n    LEFT JOIN UnitsTypeUom uom ON uom.internalid = tl.units',1)
for name in ['fetchDeliveryOrderDetailsFromNetSuite','fetchDeliveryOrderDetailsBatchFromNetSuite','fetchTransferOrderDetailsFromNetSuite','fetchPurchaseOrderDetailsFromNetSuite']:
 edit(name,metadata)
edit('fetchTransactionProgressFromNetSuite',lambda c:metadata(c).replace('const rows = result.items || [];','const rows = (result.items || []).map(normalizeNetSuiteTransactionUnits);',1))
edit('fetchScmReconciliationOrdersBatch',lambda c:metadata(c).replace('for (const row of rows) {','for (const row of rows.map(normalizeNetSuiteTransactionUnits)) {',1))
edit('fetchPurchaseOrderHistorySnapshotsFromNetSuite',lambda c:metadata(c).replace('for (const row of rows) {','for (const row of rows.map(normalizeNetSuiteTransactionUnits)) {',1))
def fulfillment(c):
 c=c.replace('           tl.quantity,','           tl.quantity, tl.units AS unit_id, uom.conversionrate AS unit_conversion_rate,',1)
 c=c.replace('LEFT JOIN item i ON i.id = tl.item','LEFT JOIN item i ON i.id = tl.item\n      LEFT JOIN UnitsTypeUom uom ON uom.internalid = tl.units',1)
 return c.replace('const rows = result.items || [];','const rows = (result.items || []).map(normalizeNetSuiteTransactionUnits);',1)
edit('fetchSalesOrderFulfillmentStateFromNetSuite',fulfillment)
def linked(c):
 c=c.replace('BUILTIN.DF(event_line.units) AS unit,','BUILTIN.DF(source_line.units) AS unit,\n        source_line.units AS unit_id, uom.conversionrate AS unit_conversion_rate,',1)
 c=c.replace('      WHERE link.previousdoc IN','      LEFT JOIN UnitsTypeUom uom ON uom.internalid = source_line.units\n      WHERE link.previousdoc IN',1)
 return c.replace('allRows.push(...rows);','allRows.push(...rows.map(normalizeNetSuiteTransactionUnits));',1)
edit('fetchPoToLinkedTransactionsFromNetSuite',linked)
def kit(c):
 c=c.replace('tl.quantityshiprecv, tl.location,','tl.quantityshiprecv, tl.units AS unit_id, uom.conversionrate AS unit_conversion_rate, tl.location,',1)
 c=c.replace('FROM transactionline tl JOIN item i ON i.id = tl.item','FROM transactionline tl JOIN item i ON i.id = tl.item\n               LEFT JOIN UnitsTypeUom uom ON uom.internalid = tl.units',1)
 return c.replace('return { sourceItems, sourceRows, kitDefinitions };','return { sourceItems, sourceRows: sourceRows.map(normalizeNetSuiteTransactionUnits), kitDefinitions };',1)
edit('fetchOperatorNetSuiteKitEvidenceFromNetSuite',kit)
p.write_text(s)
