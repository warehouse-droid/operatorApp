import { exactNetSuiteClosedSql } from "./netsuite-closed-order-policy.js";

// Keep the existing one-family Closed/Rejected rule, evaluating status labels
// once per header instead of re-scanning all headers for each split member.
export const DISPATCH_CLOSED_ORDER_FAMILY_CTES = [
  ["so", "sales_orders"],
  ["po", "purchase_orders"],
  ["to", "transfer_orders"]
].map(([kind, table]) => `
  closed_${kind} AS MATERIALIZED (
    SELECT netsuite_id AS id FROM ${table}
     WHERE ${exactNetSuiteClosedSql(table)}
  ),
  closed_${kind}_families AS MATERIALIZED (
    SELECT DISTINCT source_${kind}_id AS id
      FROM dispatch_scm_${kind}_splits
     WHERE source_${kind}_id IN (SELECT id FROM closed_${kind})
        OR split_${kind}_id IN (SELECT id FROM closed_${kind})
  ),
  closed_${kind}_ids AS MATERIALIZED (
    SELECT id FROM closed_${kind}
    UNION
    SELECT id FROM closed_${kind}_families WHERE id IS NOT NULL
    UNION
    SELECT split_${kind}_id FROM dispatch_scm_${kind}_splits
     WHERE source_${kind}_id IN (SELECT id FROM closed_${kind}_families)
       AND split_${kind}_id IS NOT NULL
  )
`).join(",");
