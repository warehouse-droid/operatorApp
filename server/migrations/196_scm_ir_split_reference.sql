-- Preserve the NetSuite Item Receipt memo used to identify the exact
-- operator-created split PO. Existing snapshots are backfilled where an
-- earlier payload already carried that evidence.
ALTER TABLE scm_reconciliation_transaction_snapshots
  ADD COLUMN IF NOT EXISTS transaction_memo text;

UPDATE scm_reconciliation_transaction_snapshots
   SET transaction_memo = COALESCE(
     NULLIF(BTRIM(snapshot->>'transactionMemo'), ''),
     NULLIF(BTRIM(snapshot->>'transaction_memo'), ''),
     NULLIF(BTRIM(snapshot->>'memo'), ''),
     NULLIF(BTRIM(snapshot#>>'{record,memo}'), '')
   )
 WHERE transaction_memo IS NULL;

COMMENT ON COLUMN scm_reconciliation_transaction_snapshots.transaction_memo IS
  'NetSuite IF/IR memo; for IRs this may identify one operator-created split PO.';
