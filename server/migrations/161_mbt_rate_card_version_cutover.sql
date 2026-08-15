-- A used rate-card version keeps every pricing field immutable, but its
-- lifecycle must still be allowed to move once from active to retired so a
-- validated successor can take over without a billing gap.
CREATE OR REPLACE FUNCTION mbt_reject_used_rate_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.first_used_at IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'used rate-card version % is immutable', OLD.rate_card_version_id
        USING ERRCODE = '55000';
    END IF;

    IF NOT (
      OLD.status = 'active'
      AND NEW.status = 'retired'
      AND NEW.retired_at IS NOT NULL
      AND NEW.revision = OLD.revision + 1
      AND (
        to_jsonb(NEW) - ARRAY[
          'status', 'effective_to', 'retired_at',
          'revision', 'updated_by', 'updated_at'
        ]::text[]
      ) = (
        to_jsonb(OLD) - ARRAY[
          'status', 'effective_to', 'retired_at',
          'revision', 'updated_by', 'updated_at'
        ]::text[]
      )
    ) THEN
      RAISE EXCEPTION 'used rate-card version % is immutable', OLD.rate_card_version_id
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION mbt_reject_used_rate_version_mutation() IS
  'Freezes used rate pricing/evidence while allowing one audited active-to-retired lifecycle cutover.';
