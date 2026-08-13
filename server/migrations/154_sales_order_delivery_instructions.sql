-- Delivery instructions retain the automatic memo interpretation separately
-- from staff-authored text and media. Staff content is revisioned so Sales and
-- Dispatch cannot silently overwrite one another.

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS dispatch_instruction_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS dispatch_instruction_parse_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dispatch_instruction_parsed_at timestamptz;

CREATE TABLE IF NOT EXISTS sales_order_delivery_instructions (
  sales_order_id bigint PRIMARY KEY REFERENCES sales_orders(netsuite_id) ON DELETE CASCADE,
  additional_text text NOT NULL DEFAULT '',
  revision bigint NOT NULL DEFAULT 1,
  created_by text,
  created_source text NOT NULL DEFAULT 'sales',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_source text NOT NULL DEFAULT 'sales',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_order_delivery_instructions_text_length
    CHECK (char_length(additional_text) <= 5000),
  CONSTRAINT sales_order_delivery_instructions_revision
    CHECK (revision > 0),
  CONSTRAINT sales_order_delivery_instructions_source
    CHECK (created_source IN ('sales', 'dispatch') AND updated_source IN ('sales', 'dispatch'))
);

CREATE TABLE IF NOT EXISTS sales_order_delivery_instruction_media (
  id uuid PRIMARY KEY,
  sales_order_id bigint NOT NULL REFERENCES sales_orders(netsuite_id) ON DELETE CASCADE,
  object_reference text NOT NULL UNIQUE,
  media_kind text NOT NULL,
  mime_type text NOT NULL,
  original_file_name text NOT NULL,
  byte_size bigint NOT NULL,
  position integer NOT NULL,
  instruction_revision bigint NOT NULL,
  uploaded_by text,
  uploaded_source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  deleted_source text,
  CONSTRAINT sales_order_delivery_instruction_media_kind
    CHECK (media_kind IN ('image', 'video')),
  CONSTRAINT sales_order_delivery_instruction_media_size
    CHECK (byte_size > 0 AND byte_size <= 26214400),
  CONSTRAINT sales_order_delivery_instruction_media_position
    CHECK (position > 0),
  CONSTRAINT sales_order_delivery_instruction_media_revision
    CHECK (instruction_revision > 0),
  CONSTRAINT sales_order_delivery_instruction_media_sources
    CHECK (
      uploaded_source IN ('sales', 'dispatch')
      AND (deleted_source IS NULL OR deleted_source IN ('sales', 'dispatch'))
    )
);

CREATE TABLE IF NOT EXISTS sales_order_delivery_instruction_upload_tickets (
  id uuid PRIMARY KEY,
  sales_order_id bigint NOT NULL REFERENCES sales_orders(netsuite_id) ON DELETE CASCADE,
  expected_revision bigint NOT NULL,
  mime_type text NOT NULL,
  original_file_name text NOT NULL,
  byte_size bigint NOT NULL,
  issued_by text,
  issued_source text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT sales_order_delivery_instruction_ticket_revision CHECK (expected_revision >= 0),
  CONSTRAINT sales_order_delivery_instruction_ticket_size CHECK (byte_size > 0 AND byte_size <= 26214400),
  CONSTRAINT sales_order_delivery_instruction_ticket_source CHECK (issued_source IN ('sales', 'dispatch'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_order_delivery_instruction_media_active_position
  ON sales_order_delivery_instruction_media (sales_order_id, position)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sales_order_delivery_instruction_media_active_order
  ON sales_order_delivery_instruction_media (sales_order_id, created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sales_order_delivery_instructions_updated
  ON sales_order_delivery_instructions (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_order_delivery_instruction_tickets_expiry
  ON sales_order_delivery_instruction_upload_tickets (expires_at)
  WHERE consumed_at IS NULL;

-- Serialize a Driver completion/reopen with instruction edits for every SO ref
-- in the physical stop. This prevents a save that began concurrently with the
-- completion from committing after the stop became read-only.
CREATE OR REPLACE FUNCTION lock_delivery_instruction_order_refs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  order_ref text;
BEGIN
  IF NEW.stop_type = 'dropoff' THEN
    FOR order_ref IN
      SELECT DISTINCT value
        FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(COALESCE(NEW.order_refs, '[]'::jsonb)) = 'array'
               THEN COALESCE(NEW.order_refs, '[]'::jsonb)
               ELSE '[]'::jsonb END
        ) refs(value)
       WHERE btrim(value) <> ''
       ORDER BY value
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('delivery-instruction:' || upper(btrim(order_ref)), 0));
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_delivery_instruction_order_refs ON driver_job_records;
CREATE TRIGGER trg_lock_delivery_instruction_order_refs
BEFORE INSERT OR UPDATE OF stop_type, order_refs, status ON driver_job_records
FOR EACH ROW EXECUTE FUNCTION lock_delivery_instruction_order_refs();
