-- Independent Field Sales records; no driver/dispatch lifecycle is reused.
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_role_check;
ALTER TABLE operators ADD CONSTRAINT operators_role_check CHECK (role IN ('operator','dispatcher','admin','scm','yard_manager','sales','mbt_frontdesk','mbt_billing','field_sales'));
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_roles_allowed_check;
ALTER TABLE operators ADD CONSTRAINT operators_roles_allowed_check CHECK (cardinality(roles)>0 AND roles <@ ARRAY['operator','dispatcher','admin','scm','yard_manager','sales','mbt_frontdesk','mbt_billing','field_sales']::text[] AND role=ANY(roles));

CREATE TABLE field_sales_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  revision integer NOT NULL DEFAULT 1,
  data jsonb NOT NULL DEFAULT '{"enabled":false,"importsEnabled":false,"postingEnabled":false,"companies":{"MBBS":{"name":"MBBS","taxBps":1300},"MBT":{"name":"MBT","taxBps":1300}}}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by text
);
INSERT INTO field_sales_settings(singleton) VALUES(true);
CREATE TABLE field_sales_jobsites (
  id uuid PRIMARY KEY, source_group text UNIQUE, name text NOT NULL, address text NOT NULL,
  address_key text NOT NULL, latitude double precision, longitude double precision,
  district text NOT NULL DEFAULT '', ward text NOT NULL DEFAULT '', ward_name text NOT NULL DEFAULT '',
  postal_prefix text NOT NULL DEFAULT '', priority integer NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 3),
  observed_stage text NOT NULL DEFAULT 'Unknown', contacts jsonb NOT NULL DEFAULT '[]',
  manual boolean NOT NULL DEFAULT false, overridden boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false, merged_into uuid REFERENCES field_sales_jobsites(id),
  revision integer NOT NULL DEFAULT 1, created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(latitude IS NULL OR latitude BETWEEN -90 AND 90), CHECK(longitude IS NULL OR longitude BETWEEN -180 AND 180)
);
CREATE INDEX field_sales_jobsites_address ON field_sales_jobsites(address_key);
CREATE INDEX field_sales_jobsites_region ON field_sales_jobsites(district,ward,postal_prefix) WHERE merged_into IS NULL;
CREATE INDEX field_sales_jobsites_map ON field_sales_jobsites(latitude,longitude) WHERE merged_into IS NULL;
CREATE TABLE field_sales_sources (
  source text NOT NULL, source_key text NOT NULL, jobsite_id uuid NOT NULL REFERENCES field_sales_jobsites(id),
  address_key text NOT NULL, data jsonb NOT NULL, present boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source,source_key)
);
CREATE INDEX field_sales_sources_site ON field_sales_sources(jobsite_id,present);
CREATE INDEX field_sales_sources_rank ON field_sales_sources(((data->>'rank')::integer)) WHERE present;
CREATE INDEX field_sales_sources_address ON field_sales_sources(address_key);
CREATE TABLE field_sales_notes (
  id uuid PRIMARY KEY, jobsite_id uuid NOT NULL REFERENCES field_sales_jobsites(id), actor_id text NOT NULL,
  body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE field_sales_routes (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES operators(id), plan_date date NOT NULL,
  name text NOT NULL, status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','paused','completed')),
  data jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX field_sales_routes_date ON field_sales_routes(owner_id,plan_date);
CREATE UNIQUE INDEX field_sales_one_active_route ON field_sales_routes(owner_id) WHERE status='active';
CREATE TABLE field_sales_visits (
  id uuid PRIMARY KEY, jobsite_id uuid NOT NULL REFERENCES field_sales_jobsites(id), route_id uuid REFERENCES field_sales_routes(id),
  stop_id uuid, actor_id text NOT NULL REFERENCES operators(id), outcome text NOT NULL, note text NOT NULL DEFAULT '',
  observed_stage text NOT NULL DEFAULT 'Unknown', occurred_at timestamptz NOT NULL, data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX field_sales_visits_site ON field_sales_visits(jobsite_id,occurred_at DESC);
CREATE TABLE field_sales_followups (
  id uuid PRIMARY KEY, jobsite_id uuid NOT NULL REFERENCES field_sales_jobsites(id), visit_id uuid REFERENCES field_sales_visits(id),
  owner_id text NOT NULL REFERENCES operators(id), due_date date NOT NULL, priority integer NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 3),
  note text NOT NULL DEFAULT '', completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX field_sales_followups_due ON field_sales_followups(owner_id,due_date) WHERE completed_at IS NULL;
CREATE TABLE field_sales_photos (
  id uuid PRIMARY KEY, visit_id uuid NOT NULL REFERENCES field_sales_visits(id), actor_id text NOT NULL,
  content bytea NOT NULL, sha256 text NOT NULL, content_type text NOT NULL DEFAULT 'image/jpeg',
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(octet_length(content)<=8388608)
);
CREATE TABLE field_sales_quotes (
  id uuid PRIMARY KEY, quote_number bigserial UNIQUE, jobsite_id uuid NOT NULL REFERENCES field_sales_jobsites(id),
  revision integer NOT NULL DEFAULT 1, published_revision integer, created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE field_sales_quote_revisions (
  quote_id uuid NOT NULL REFERENCES field_sales_quotes(id), revision integer NOT NULL, snapshot jsonb NOT NULL,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(quote_id,revision)
);
CREATE FUNCTION field_sales_immutable_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Field Sales quote revisions are immutable'; END $$;
CREATE TRIGGER field_sales_immutable_quote BEFORE UPDATE OR DELETE ON field_sales_quote_revisions FOR EACH ROW EXECUTE FUNCTION field_sales_immutable_quote();
CREATE TABLE field_sales_estimates (
  quote_id uuid NOT NULL REFERENCES field_sales_quotes(id), company text NOT NULL CHECK(company IN ('MBBS','MBT')),
  external_id text UNIQUE NOT NULL, netsuite_id text, reference text, remote_hash text,
  synced_revision integer NOT NULL DEFAULT 0, closed boolean NOT NULL DEFAULT false,
  PRIMARY KEY(quote_id,company)
);
CREATE TABLE field_sales_posting_jobs (
  id uuid PRIMARY KEY, quote_id uuid NOT NULL REFERENCES field_sales_quotes(id), revision integer NOT NULL,
  company text NOT NULL CHECK(company IN ('MBBS','MBT')), payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','working','uncertain','done','attention','superseded')),
  attempt integer NOT NULL DEFAULT 0, lease_until timestamptz, lease_token uuid,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), error text, result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(quote_id,revision,company), FOREIGN KEY(quote_id,revision) REFERENCES field_sales_quote_revisions(quote_id,revision)
);
CREATE INDEX field_sales_posting_pending ON field_sales_posting_jobs(next_attempt_at) WHERE state IN ('pending','uncertain','working');
CREATE TABLE field_sales_commands (
  id uuid PRIMARY KEY, actor_id text NOT NULL, kind text NOT NULL, payload_hash text NOT NULL,
  response jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE field_sales_audit (
  id bigserial PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL, target_id text,
  detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE field_sales_import_runs (
  id uuid PRIMARY KEY, source text NOT NULL, state text NOT NULL DEFAULT 'running', record_count integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, error text
);
CREATE UNIQUE INDEX field_sales_import_active ON field_sales_import_runs(source) WHERE state='running';
CREATE TABLE field_sales_import_stage (
  run_id uuid NOT NULL REFERENCES field_sales_import_runs(id) ON DELETE CASCADE,
  source_key text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(run_id,source_key)
);
CREATE TABLE field_sales_addresses (
  address_key text PRIMARY KEY, latitude double precision, longitude double precision,
  ward text NOT NULL DEFAULT '', ward_name text NOT NULL DEFAULT '', district text NOT NULL DEFAULT '',
  ambiguous boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE field_sales_catalog (
  company text NOT NULL CHECK(company IN ('MBBS','MBT')), item_id text NOT NULL,
  sku text NOT NULL, description text NOT NULL, unit text NOT NULL DEFAULT '', unit_rate text,
  pricing jsonb NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company,item_id)
);
