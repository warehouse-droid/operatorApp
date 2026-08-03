ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS netsuite_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS remote_last_modified_at timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_reference text;

ALTER TABLE purchase_order_lines
  ADD COLUMN IF NOT EXISTS rate numeric,
  ADD COLUMN IF NOT EXISTS amount numeric,
  ADD COLUMN IF NOT EXISTS netsuite_closed boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS scm_netsuite_po_history (
  id bigserial PRIMARY KEY,
  proposal_id bigint,
  netsuite_purchase_order_id bigint NOT NULL,
  netsuite_purchase_order_ref text NOT NULL,
  created_by text,
  app_created_at timestamptz NOT NULL DEFAULT now(),
  creation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at timestamptz,
  archived_by text,
  last_synced_at timestamptz,
  last_sync_error text,
  remote_last_modified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_netsuite_po_history_netsuite_id_uq UNIQUE (netsuite_purchase_order_id),
  CONSTRAINT scm_netsuite_po_history_proposal_uq UNIQUE (proposal_id),
  CONSTRAINT scm_netsuite_po_history_snapshot_object CHECK (jsonb_typeof(creation_snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_scm_netsuite_po_history_archive
  ON scm_netsuite_po_history (archived_at DESC, id DESC)
  WHERE archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scm_netsuite_po_history_created
  ON scm_netsuite_po_history (app_created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS scm_netsuite_po_history_changes (
  id bigserial PRIMARY KEY,
  history_id bigint NOT NULL REFERENCES scm_netsuite_po_history(id) ON DELETE CASCADE,
  actor_operator_id text,
  source text NOT NULL,
  remote_last_modified_before timestamptz,
  remote_last_modified_after timestamptz,
  requested_changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  resulting_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scm_netsuite_po_history_changes_source CHECK (source IN ('application', 'netsuite_webhook', 'reconciliation', 'creation')),
  CONSTRAINT scm_netsuite_po_history_changes_requested_object CHECK (jsonb_typeof(requested_changes) = 'object'),
  CONSTRAINT scm_netsuite_po_history_changes_result_object CHECK (jsonb_typeof(resulting_snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_scm_netsuite_po_history_changes_history
  ON scm_netsuite_po_history_changes (history_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scm_netsuite_po_history_changes_creation
  ON scm_netsuite_po_history_changes (history_id)
  WHERE source = 'creation';

-- Existing successful Smart SCM-created POs become archived history. Pending
-- and failed reviews remain in Vendor Replies and are deliberately excluded.
INSERT INTO scm_netsuite_po_history (
  proposal_id,
  netsuite_purchase_order_id,
  netsuite_purchase_order_ref,
  created_by,
  app_created_at,
  creation_snapshot,
  archived_at,
  archived_by,
  last_synced_at,
  remote_last_modified_at
)
SELECT p.id,
       p.netsuite_purchase_order_id,
       p.netsuite_purchase_order_ref,
       p.confirmed_by,
       COALESCE(p.confirmed_at, p.updated_at, p.created_at, now()),
       jsonb_build_object(
         'proposalId', p.id,
         'purchaseOrderId', p.netsuite_purchase_order_id,
         'purchaseOrderRef', p.netsuite_purchase_order_ref,
         'vendor', p.vendor,
         'vendorReadyDate', p.vendor_ready_date,
         'vendorReference', p.vendor_reference,
         'routeStops', COALESCE(p.route_stops, '[]'::jsonb),
         'lines', COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'proposalLineId', l.id,
             'itemId', l.item_id,
             'itemName', l.item_name,
             'description', l.item_description,
             'quantity', l.sales_quantity,
             'confirmedPallets', l.confirmed_pallets,
             'destinationLocationId', l.destination_location_id,
             'destinationName', l.destination_name,
             'lastPurchasePrice', l.last_purchase_price
           ) ORDER BY l.id)
             FROM scm_smart_proposal_lines l
            WHERE l.proposal_id = p.id
         ), '[]'::jsonb)
       ),
       COALESCE(p.confirmed_at, p.updated_at, p.created_at, now()),
       p.confirmed_by,
       po.synced_at,
       po.remote_last_modified_at
  FROM scm_smart_proposals p
  LEFT JOIN purchase_orders po ON po.netsuite_id = p.netsuite_purchase_order_id
 WHERE p.proposal_type = 'PO'
   AND p.netsuite_purchase_order_id IS NOT NULL
   AND NULLIF(p.netsuite_purchase_order_ref, '') IS NOT NULL
   AND p.po_execution_status = 'created'
ON CONFLICT (netsuite_purchase_order_id) DO NOTHING;

COMMENT ON TABLE scm_netsuite_po_history IS
  'Registry of real NetSuite purchase orders created by Smart SCM. Archive state controls visibility in PO history; the creation snapshot is immutable evidence.';

COMMENT ON COLUMN scm_netsuite_po_history.creation_snapshot IS
  'Immutable application-side values used when the NetSuite PO was created. Live values are read from canonical purchase_orders and purchase_order_lines.';

CREATE TABLE IF NOT EXISTS scm_netsuite_vendor_item_codes (
  item_id bigint NOT NULL,
  vendor_id bigint NOT NULL,
  subsidiary_id bigint NOT NULL DEFAULT 0,
  vendor_code text NOT NULL,
  source text NOT NULL,
  preferred_vendor boolean NOT NULL DEFAULT false,
  synced_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, vendor_id, subsidiary_id),
  CONSTRAINT scm_netsuite_vendor_item_codes_source CHECK (source IN ('item_vendor', 'single_vendor_fallback'))
);

CREATE INDEX IF NOT EXISTS idx_scm_netsuite_vendor_item_codes_vendor
  ON scm_netsuite_vendor_item_codes (vendor_id, item_id, subsidiary_id);

COMMENT ON TABLE scm_netsuite_vendor_item_codes IS
  'Authoritative vendor-specific item codes from NetSuite Item Vendor, with item.vendorname only as the single-vendor fallback.';
