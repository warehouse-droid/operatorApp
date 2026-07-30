ALTER TABLE scm_reconciliation_review_resolutions
  DROP CONSTRAINT IF EXISTS scm_reconciliation_review_resolutions_action;

ALTER TABLE scm_reconciliation_review_resolutions
  ADD CONSTRAINT scm_reconciliation_review_resolutions_action
  CHECK (action IN (
    'retry', 'allocate', 'accept', 'dismiss', 'auto_resolve', 'reopen',
    'cancel_missing'
  ));

COMMENT ON CONSTRAINT scm_reconciliation_review_resolutions_action
  ON scm_reconciliation_review_resolutions IS
  'Explicit cancel_missing resolutions record an admin decision made only after a fresh NetSuite ID/header and transaction-number lookup found no source order.';
