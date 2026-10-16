ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_role_check;
ALTER TABLE operators ADD CONSTRAINT operators_role_check CHECK (role IN
 ('operator','dispatcher','admin','scm','yard_manager','sales','field_sales','mbt_frontdesk','mbt_billing','boss','mbr_sales'));
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_roles_allowed_check;
ALTER TABLE operators ADD CONSTRAINT operators_roles_allowed_check CHECK
 (cardinality(roles)>0 AND role=ANY(roles) AND roles <@ ARRAY['operator','dispatcher','admin','scm','yard_manager','sales','field_sales','mbt_frontdesk','mbt_billing','boss','mbr_sales']::text[]);

CREATE SEQUENCE mbr_contract_number_seq;
CREATE FUNCTION mbr_next_contract_number() RETURNS text LANGUAGE sql VOLATILE AS $$
 SELECT 'MBR-'||to_char(clock_timestamp(),'YYYY')||'-'||CASE WHEN length(value)>6 THEN value ELSE lpad(value,6,'0') END
 FROM (SELECT nextval('mbr_contract_number_seq')::text AS value) next_number
$$;
CREATE TABLE mbr_contracts (
 id uuid PRIMARY KEY,
 number text NOT NULL UNIQUE DEFAULT mbr_next_contract_number(),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','expired')),
 current_revision integer NOT NULL CHECK(current_revision>0),
 active_link_id uuid,
 issued_at timestamptz,
 expires_at timestamptz,
 created_by text NOT NULL REFERENCES operators(id),
 updated_by text NOT NULL REFERENCES operators(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 signed_snapshot jsonb,
 signature_png bytea,
 signature_sha256 text,
 submission_id uuid UNIQUE,
 submission_sha256 text,
 completed_pdf bytea,
 pdf_sha256 text,
 CHECK ((status='completed') = (completed_at IS NOT NULL)),
 CHECK(status<>'completed' OR (signed_snapshot IS NOT NULL AND signature_png IS NOT NULL AND signature_sha256 IS NOT NULL
   AND submission_id IS NOT NULL AND submission_sha256 IS NOT NULL AND completed_pdf IS NOT NULL AND pdf_sha256 IS NOT NULL)),
 CHECK((issued_at IS NULL) = (expires_at IS NULL))
);
CREATE TABLE mbr_contract_revisions (
 contract_id uuid NOT NULL REFERENCES mbr_contracts(id),
 revision integer NOT NULL CHECK(revision>0),
 snapshot jsonb NOT NULL,
 created_by text NOT NULL REFERENCES operators(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(contract_id,revision)
);
ALTER TABLE mbr_contracts ADD CONSTRAINT mbr_contract_current_revision_fk
 FOREIGN KEY(id,current_revision) REFERENCES mbr_contract_revisions(contract_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE mbr_contract_links (
 id uuid PRIMARY KEY,
 contract_id uuid NOT NULL REFERENCES mbr_contracts(id),
 token_hash text NOT NULL UNIQUE,
 encrypted_token jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 invalidated_at timestamptz
);
CREATE UNIQUE INDEX mbr_contract_links_active_unique ON mbr_contract_links(contract_id) WHERE invalidated_at IS NULL;
ALTER TABLE mbr_contracts ADD CONSTRAINT mbr_contract_active_link_fk FOREIGN KEY(active_link_id) REFERENCES mbr_contract_links(id);
CREATE TABLE mbr_contract_events (
 id bigserial PRIMARY KEY,
 contract_id uuid NOT NULL REFERENCES mbr_contracts(id),
 kind text NOT NULL CHECK(kind IN ('created','edited','link_issued','expired','renewed','completed')),
 revision integer NOT NULL,
 actor_id text REFERENCES operators(id),
 details jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX mbr_contracts_expiry ON mbr_contracts(expires_at) WHERE status='pending' AND expires_at IS NOT NULL;
CREATE INDEX mbr_contracts_list ON mbr_contracts(updated_at DESC,id);
CREATE INDEX mbr_contract_events_history ON mbr_contract_events(contract_id,id);
