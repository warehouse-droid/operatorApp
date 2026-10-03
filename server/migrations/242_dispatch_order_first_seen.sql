-- Dispatch recency follows arrival in this application, independently of the
-- NetSuite transaction date or a later synchronization/edit. Older headers did
-- not retain first arrival; recover the earliest available local evidence.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $migration$
DECLARE
  source record;
  suspended_triggers jsonb;
  suspended_trigger record;
BEGIN
  FOR source IN
    SELECT * FROM (VALUES
      ('sales_orders', 'SO', 'sales_order'),
      ('purchase_orders', 'PO', 'purchase_order'),
      ('transfer_orders', 'TO', 'transfer_order')
    ) AS sources(table_name, order_type, entity_type)
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS first_seen_at timestamptz',
      source.table_name
    );

    -- ADD COLUMN holds ACCESS EXCLUSIVE until commit. No application update can
    -- run while these existing business projections are suspended. A metadata
    -- backfill must not record completions or enqueue SOR reconciliation; leave
    -- every other trigger intact and restore each original firing mode below.
    SELECT COALESCE(jsonb_object_agg(trigger.tgname, trigger.tgenabled), '{}'::jsonb)
      INTO suspended_triggers
      FROM pg_trigger trigger
     WHERE trigger.tgrelid = source.table_name::regclass
       AND NOT trigger.tgisinternal
       AND source.table_name = 'sales_orders'
       AND trigger.tgname IN (
         'sor_header_changed', 'trg_sales_fulfillment_dispatch_completion'
       );
    FOR suspended_trigger IN SELECT * FROM jsonb_each_text(suspended_triggers)
    LOOP
      EXECUTE format('ALTER TABLE %I DISABLE TRIGGER %I',
        source.table_name, suspended_trigger.key);
    END LOOP;

    -- A freshly added, all-null column has no statistics. Its default null
    -- estimate can turn the evidence joins into repeated nested-loop scans.
    EXECUTE format('ANALYZE %I (first_seen_at)', source.table_name);

    EXECUTE format($backfill$
      WITH discovery AS MATERIALIZED (
        SELECT audit.details->'order'->>'netsuite_id' AS record_id,
               min(audit.created_at) AS first_seen_at
          FROM delivery_audit_log audit
         WHERE audit.source = 'netsuite'
           AND audit.action IN (
             'netsuite.order.discover', 'netsuite.receiving_order.discover'
           )
           AND audit.details->'order'->>'order_type' = %L
         GROUP BY audit.details->'order'->>'netsuite_id'
      ), catalog_identity AS MATERIALIZED (
        SELECT candidate.created_at, candidate.order_type,
               lower(candidate.order_ref) AS order_ref,
               candidate.full_order->>'sourceTable' AS source_table,
               candidate.full_order->>'sourceRecordId' AS source_record_id,
               candidate.full_order->>'netsuiteId' AS netsuite_id,
               candidate.full_order->'raw'->>'netsuite_id' AS raw_netsuite_id
          FROM dispatch_order_catalog_entries candidate
         WHERE candidate.order_type = %L
            OR candidate.full_order->>'sourceTable' = %L
      ), catalog_by_id AS MATERIALIZED (
        SELECT identity.record_id, min(candidate.created_at) AS first_seen_at
          FROM catalog_identity candidate
          CROSS JOIN LATERAL (VALUES
            (candidate.source_record_id), (candidate.netsuite_id), (candidate.raw_netsuite_id)
          ) identity(record_id)
         WHERE candidate.source_table = %L
           AND identity.record_id IS NOT NULL
         GROUP BY identity.record_id
      ), catalog_by_ref AS MATERIALIZED (
        SELECT candidate.order_ref, min(candidate.created_at) AS first_seen_at
          FROM catalog_identity candidate
         WHERE candidate.order_type = %L
         GROUP BY candidate.order_ref
      ), arrivals AS MATERIALIZED (
        SELECT header.netsuite_id,
               COALESCE(LEAST(
                 discovery.first_seen_at,
                 catalog_by_id.first_seen_at,
                 catalog_by_ref.first_seen_at,
                 header.synced_at,
                 header.status_updated_at,
                 header.dispatch_parsed_at
               ), '1970-01-01T00:00:00Z'::timestamptz) AS first_seen_at
          FROM %I header
          LEFT JOIN discovery
            ON discovery.record_id = header.netsuite_id::text
          LEFT JOIN catalog_by_id
            ON catalog_by_id.record_id = header.netsuite_id::text
          LEFT JOIN catalog_by_ref
            ON catalog_by_ref.order_ref = lower(header.tranid)
         WHERE header.first_seen_at IS NULL
      )
      UPDATE %I header
         SET first_seen_at = arrivals.first_seen_at
        FROM arrivals
       WHERE header.netsuite_id = arrivals.netsuite_id
         AND header.first_seen_at IS NULL
    $backfill$, source.entity_type, source.order_type, source.table_name,
       source.table_name, source.order_type, source.table_name, source.table_name);

    FOR suspended_trigger IN SELECT * FROM jsonb_each_text(suspended_triggers)
    LOOP
      EXECUTE format('ALTER TABLE %I %s TRIGGER %I', source.table_name,
        CASE suspended_trigger.value
          WHEN 'O' THEN 'ENABLE'
          WHEN 'R' THEN 'ENABLE REPLICA'
          WHEN 'A' THEN 'ENABLE ALWAYS'
          ELSE 'DISABLE'
        END, suspended_trigger.key);
    END LOOP;
    -- DDL is transactional: any error/cancellation also rolls suspension back.

    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN first_seen_at SET DEFAULT now(), ALTER COLUMN first_seen_at SET NOT NULL',
      source.table_name
    );
  END LOOP;
END;
$migration$;

CREATE OR REPLACE FUNCTION preserve_dispatch_order_first_seen_at()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  NEW.first_seen_at := OLD.first_seen_at;
  RETURN NEW;
END;
$function$;

DO $migration$
DECLARE
  source_table text;
BEGIN
  FOREACH source_table IN ARRAY ARRAY['sales_orders', 'purchase_orders', 'transfer_orders']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS preserve_dispatch_order_first_seen_at ON %I', source_table);
    EXECUTE format(
      'CREATE TRIGGER preserve_dispatch_order_first_seen_at BEFORE UPDATE OF first_seen_at ON %I FOR EACH ROW EXECUTE FUNCTION preserve_dispatch_order_first_seen_at()',
      source_table
    );
    EXECUTE format(
      'COMMENT ON COLUMN %I.first_seen_at IS %L', source_table,
      'Immutable local first-arrival timestamp. Historical rows use the earliest retained local evidence; epoch means arrival is unknown. Later syncs and edits preserve it.'
    );
  END LOOP;
END;
$migration$;
