-- Guarded cleanup for local MBT configuration and accidental asset
-- registrations. Destructive operations are denied by default and can only be
-- opened for one exact entity by an application transaction after it has
-- checked dependencies. Existing multi-item rate cards remain readable; every
-- newly item-owned card is constrained to one local item and one card per item.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE mbt_rate_cards
  ADD COLUMN IF NOT EXISTS item_code text;

ALTER TABLE mbt_rate_cards
  DROP CONSTRAINT IF EXISTS mbt_rate_cards_item_fk;
ALTER TABLE mbt_rate_cards
  ADD CONSTRAINT mbt_rate_cards_item_fk
    FOREIGN KEY (item_code)
    REFERENCES mbt_local_item_settings(item_code)
    ON DELETE RESTRICT;

WITH card_children AS (
  SELECT version.rate_card_id, band.item_code
    FROM mbt_rate_card_versions version
    JOIN mbt_rate_distance_bands band
      ON band.rate_card_version_id = version.rate_card_version_id
   WHERE band.item_code IS NOT NULL
  UNION ALL
  SELECT version.rate_card_id, component.item_code
    FROM mbt_rate_card_versions version
    JOIN mbt_rate_components component
      ON component.rate_card_version_id = version.rate_card_version_id
   WHERE component.item_code IS NOT NULL
  UNION ALL
  SELECT version.rate_card_id, tariff.item_code
    FROM mbt_rate_card_versions version
    JOIN mbt_dump_tariffs tariff
      ON tariff.rate_card_version_id = version.rate_card_version_id
   WHERE tariff.item_code IS NOT NULL
), single_item_cards AS (
  SELECT rate_card_id, min(item_code) AS item_code
    FROM card_children
   GROUP BY rate_card_id
  HAVING count(DISTINCT item_code) = 1
), ranked_item_cards AS (
  SELECT candidate.*,
         row_number() OVER (
           PARTITION BY candidate.item_code
           ORDER BY card.created_at, candidate.rate_card_id
         ) AS owner_rank
    FROM single_item_cards candidate
    JOIN mbt_rate_cards card ON card.rate_card_id = candidate.rate_card_id
)
UPDATE mbt_rate_cards card
   SET item_code = candidate.item_code
  FROM ranked_item_cards candidate
 WHERE card.rate_card_id = candidate.rate_card_id
   AND candidate.owner_rank = 1
   AND card.item_code IS NULL
   AND NOT EXISTS (
     SELECT 1
       FROM mbt_rate_cards other
      WHERE other.item_code = candidate.item_code
        AND other.rate_card_id <> card.rate_card_id
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_mbt_rate_cards_item_unique
  ON mbt_rate_cards (item_code)
  WHERE item_code IS NOT NULL;

CREATE OR REPLACE FUNCTION mbt_validate_rate_card_item_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_item_code text;
BEGIN
  SELECT card.item_code
    INTO owner_item_code
    FROM mbt_rate_card_versions version
    JOIN mbt_rate_cards card ON card.rate_card_id = version.rate_card_id
   WHERE version.rate_card_version_id = NEW.rate_card_version_id;

  IF owner_item_code IS NOT NULL
     AND NEW.item_code IS DISTINCT FROM owner_item_code THEN
    RAISE EXCEPTION 'rate-card item % cannot own pricing for item %',
      owner_item_code, NEW.item_code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_rate_distance_bands_owner_item
  ON mbt_rate_distance_bands;
CREATE TRIGGER trg_mbt_rate_distance_bands_owner_item
  BEFORE INSERT OR UPDATE OF rate_card_version_id, item_code
  ON mbt_rate_distance_bands
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_rate_card_item_ownership();

DROP TRIGGER IF EXISTS trg_mbt_rate_components_owner_item
  ON mbt_rate_components;
CREATE TRIGGER trg_mbt_rate_components_owner_item
  BEFORE INSERT OR UPDATE OF rate_card_version_id, item_code
  ON mbt_rate_components
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_rate_card_item_ownership();

DROP TRIGGER IF EXISTS trg_mbt_dump_tariffs_owner_item
  ON mbt_dump_tariffs;
CREATE TRIGGER trg_mbt_dump_tariffs_owner_item
  BEFORE INSERT OR UPDATE OF rate_card_version_id, item_code
  ON mbt_dump_tariffs
  FOR EACH ROW EXECUTE FUNCTION mbt_validate_rate_card_item_ownership();

CREATE OR REPLACE FUNCTION mbt_guard_rate_card_item_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mismatched_children integer;
BEGIN
  IF OLD.item_code IS NOT NULL
     AND NEW.item_code IS DISTINCT FROM OLD.item_code THEN
    RAISE EXCEPTION 'rate-card item ownership is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.item_code IS NULL AND NEW.item_code IS NOT NULL THEN
    SELECT count(*)::integer
      INTO mismatched_children
      FROM (
        SELECT band.item_code
          FROM mbt_rate_card_versions version
          JOIN mbt_rate_distance_bands band USING (rate_card_version_id)
         WHERE version.rate_card_id = NEW.rate_card_id
        UNION ALL
        SELECT component.item_code
          FROM mbt_rate_card_versions version
          JOIN mbt_rate_components component USING (rate_card_version_id)
         WHERE version.rate_card_id = NEW.rate_card_id
        UNION ALL
        SELECT tariff.item_code
          FROM mbt_rate_card_versions version
          JOIN mbt_dump_tariffs tariff USING (rate_card_version_id)
         WHERE version.rate_card_id = NEW.rate_card_id
      ) child
     WHERE child.item_code IS DISTINCT FROM NEW.item_code;
    IF mismatched_children > 0 THEN
      RAISE EXCEPTION 'rate-card item ownership does not match its pricing rows'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_rate_cards_item_identity ON mbt_rate_cards;
CREATE TRIGGER trg_mbt_rate_cards_item_identity
  BEFORE UPDATE OF item_code ON mbt_rate_cards
  FOR EACH ROW EXECUTE FUNCTION mbt_guard_rate_card_item_identity();

CREATE OR REPLACE FUNCTION mbt_validate_rate_card_version_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_item_code text;
  owner_item_type text;
  configured_count integer;
  invalid_count integer;
BEGIN
  IF NEW.status <> 'active'
     OR (TG_OP = 'UPDATE' AND OLD.status = 'active') THEN
    RETURN NEW;
  END IF;

  SELECT card.item_code, item.item_type
    INTO owner_item_code, owner_item_type
    FROM mbt_rate_cards card
    LEFT JOIN mbt_local_item_settings item ON item.item_code = card.item_code
   WHERE card.rate_card_id = NEW.rate_card_id;

  IF owner_item_type = 'bin' THEN
    SELECT count(DISTINCT component_kind)::integer
      INTO configured_count
      FROM mbt_rate_components
     WHERE rate_card_version_id = NEW.rate_card_version_id
       AND item_code = owner_item_code
       AND active
       AND component_kind IN ('rental', 'extension');
    invalid_count := CASE WHEN configured_count = 2 THEN 0 ELSE 1 END;
  ELSIF owner_item_type = 'dump' THEN
    SELECT count(*)::integer
      INTO configured_count
      FROM mbt_dump_tariffs
     WHERE rate_card_version_id = NEW.rate_card_version_id
       AND item_code = owner_item_code
       AND active;
    invalid_count := CASE WHEN configured_count > 0 THEN 0 ELSE 1 END;
  ELSIF owner_item_type = 'surcharge' THEN
    configured_count := 1;
    invalid_count := 0;
  ELSE
    WITH ordered_bands AS (
      SELECT minimum_metres,
             maximum_metres,
             row_number() OVER (
               PARTITION BY service_code,
                            COALESCE(bin_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
               ORDER BY minimum_metres, sequence_number, rate_distance_band_id
             ) AS band_position,
             count(*) OVER (
               PARTITION BY service_code,
                            COALESCE(bin_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
             ) AS group_size,
             lag(maximum_metres) OVER (
               PARTITION BY service_code,
                            COALESCE(bin_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
               ORDER BY minimum_metres, sequence_number, rate_distance_band_id
             ) AS previous_maximum
        FROM mbt_rate_distance_bands
       WHERE rate_card_version_id = NEW.rate_card_version_id
    )
    SELECT count(*)::integer,
           count(*) FILTER (
             WHERE (band_position = 1 AND minimum_metres <> 0)
                OR (band_position > 1 AND previous_maximum IS DISTINCT FROM minimum_metres)
                OR (band_position < group_size AND maximum_metres IS NULL)
                OR (band_position = group_size AND maximum_metres IS NOT NULL)
           )::integer
      INTO configured_count, invalid_count
      FROM ordered_bands;
  END IF;

  IF configured_count = 0 OR invalid_count > 0 THEN
    RAISE EXCEPTION 'rate-card version % has invalid item pricing', NEW.rate_card_version_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'mbt_rate_card_versions_item_pricing_valid';
  END IF;
  RETURN NEW;
END;
$$;

-- A normal local Delivery order is represented by the existing custom-order
-- aggregate so Dispatch and Driver PWA receive it without a second planner.
ALTER TABLE dispatch_custom_orders
  ADD COLUMN IF NOT EXISTS mbt_local_item_code text,
  ADD COLUMN IF NOT EXISTS mbt_customer_netsuite_id bigint,
  ADD COLUMN IF NOT EXISTS mbt_source text;

ALTER TABLE dispatch_custom_orders
  DROP CONSTRAINT IF EXISTS dispatch_custom_orders_mbt_item_fk;
ALTER TABLE dispatch_custom_orders
  ADD CONSTRAINT dispatch_custom_orders_mbt_item_fk
    FOREIGN KEY (mbt_local_item_code)
    REFERENCES mbt_local_item_settings(item_code)
    ON DELETE RESTRICT;

ALTER TABLE dispatch_custom_orders
  DROP CONSTRAINT IF EXISTS dispatch_custom_orders_mbt_customer_fk;
ALTER TABLE dispatch_custom_orders
  ADD CONSTRAINT dispatch_custom_orders_mbt_customer_fk
    FOREIGN KEY (mbt_customer_netsuite_id)
    REFERENCES netsuite_customers(netsuite_id)
    ON DELETE RESTRICT;

ALTER TABLE dispatch_custom_orders
  DROP CONSTRAINT IF EXISTS dispatch_custom_orders_mbt_source_valid;
ALTER TABLE dispatch_custom_orders
  ADD CONSTRAINT dispatch_custom_orders_mbt_source_valid
    CHECK (mbt_source IS NULL OR mbt_source IN ('frontdesk_delivery'));

CREATE INDEX IF NOT EXISTS idx_dispatch_custom_orders_mbt_item
  ON dispatch_custom_orders (mbt_local_item_code, status, id)
  WHERE mbt_local_item_code IS NOT NULL;

-- Exact, transaction-local delete grants. A SQL session cannot broadly turn
-- deletion on: the setting must equal the row identity being deleted.
CREATE OR REPLACE FUNCTION mbt_guard_local_item_setting_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.system_owned THEN
      RAISE EXCEPTION 'protected MBT local items cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    IF current_setting('mbt.delete_local_item', true) IS DISTINCT FROM OLD.item_code THEN
      RAISE EXCEPTION 'MBT local item deletion requires an exact guarded command'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.item_code IS DISTINCT FROM OLD.item_code
     OR NEW.system_owned IS DISTINCT FROM OLD.system_owned
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'MBT local item identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.system_owned AND (
       NEW.item_type IS DISTINCT FROM OLD.item_type
       OR NEW.category IS DISTINCT FROM OLD.category
       OR NEW.bin_type_id IS DISTINCT FROM OLD.bin_type_id
       OR NEW.pricing_mode IS DISTINCT FROM OLD.pricing_mode
       OR NEW.rental_period_days IS DISTINCT FROM OLD.rental_period_days
       OR NEW.netsuite_mapping_local_key IS DISTINCT FROM OLD.netsuite_mapping_local_key
       OR NEW.applicable_service_types IS DISTINCT FROM OLD.applicable_service_types
       OR NEW.applicable_legacy_source_types IS DISTINCT FROM OLD.applicable_legacy_source_types
     ) THEN
    RAISE EXCEPTION 'MBT protected local item identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'MBT local item revisions must advance exactly once per update'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mbt_reject_asset_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('mbt.delete_bin_asset', true) = OLD.asset_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% assets must be retained and retired', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION mbt_guard_bin_movement_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('mbt.delete_bin_asset', true) = OLD.asset_id::text
     AND OLD.asset_sequence = 1
     AND OLD.movement_type = 'asset_registered' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_mbt_bin_movements_immutable ON mbt_bin_movements;
CREATE TRIGGER trg_mbt_bin_movements_immutable
  BEFORE UPDATE OR DELETE ON mbt_bin_movements
  FOR EACH ROW EXECUTE FUNCTION mbt_guard_bin_movement_immutable();

CREATE OR REPLACE FUNCTION mbt_validate_bin_asset_state_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_asset_id uuid;
BEGIN
  target_asset_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.asset_id ELSE NEW.asset_id END;
  IF current_setting('mbt.delete_bin_asset', true) = target_asset_id::text
     AND NOT EXISTS (SELECT 1 FROM mbt_bin_assets WHERE asset_id = target_asset_id) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  PERFORM mbt_assert_bin_asset_state_matches_latest(target_asset_id);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN mbt_rate_cards.item_code IS
  'Optional only for grandfathered multi-item cards; every new local card is owned by one unique local item.';
COMMENT ON COLUMN dispatch_custom_orders.mbt_local_item_code IS
  'Local delivery-fee item selected by Front Desk for a non-contract A-to-B delivery.';
