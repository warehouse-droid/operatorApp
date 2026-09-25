BEGIN READ ONLY;
EXPLAIN (ANALYZE, BUFFERS)
SELECT ledger.source_line_id, SUM(ledger.sales_qty) AS sales_qty
FROM dispatch_scm_po_split_lines ledger
JOIN dispatch_scm_po_splits split ON split.id = ledger.split_id
JOIN purchase_order_lines source ON source.id = ledger.source_line_id
WHERE split.source_po_id = 945685 AND source.purchase_order_id = 945685 AND split.status = 'active'
GROUP BY ledger.source_line_id;
ROLLBACK;
