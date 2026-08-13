-- PO History reads dedicated numeric columns, while older OAuth reconciliation
-- stored NetSuite line financials only inside the raw JSON snapshot. Promote
-- those already-authoritative values without replacing an existing local value.
UPDATE purchase_order_lines
   SET rate = CASE
                WHEN rate IS NOT NULL THEN rate
                WHEN COALESCE(BTRIM(raw ->> 'rate'), '') ~ '^[+-]?[0-9]+([.][0-9]+)?$'
                THEN (raw ->> 'rate')::numeric
                ELSE NULL
              END,
       amount = CASE
                  WHEN amount IS NOT NULL THEN amount
                  WHEN COALESCE(BTRIM(raw ->> 'amount'), '') ~ '^[+-]?[0-9]+([.][0-9]+)?$'
                  THEN (raw ->> 'amount')::numeric
                  ELSE NULL
                END,
       synced_at = now()
 WHERE (rate IS NULL AND COALESCE(BTRIM(raw ->> 'rate'), '') ~ '^[+-]?[0-9]+([.][0-9]+)?$')
    OR (amount IS NULL AND COALESCE(BTRIM(raw ->> 'amount'), '') ~ '^[+-]?[0-9]+([.][0-9]+)?$');
