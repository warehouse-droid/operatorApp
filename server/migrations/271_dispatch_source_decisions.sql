-- Existing acknowledgements remain review history, rather than silently
-- choosing a source of truth for dispatch. Previous app versions ignore these
-- additive columns; execution and photo evidence are untouched.
ALTER TABLE dispatch_executed_order_reviews
  ADD COLUMN decision text CHECK (decision IN ('protect_driver_work','accept_netsuite_change')),
  ADD COLUMN decided_at timestamptz,
  ADD CONSTRAINT dispatch_source_decision_timestamp
    CHECK ((decision IS NULL) = (decided_at IS NULL));
