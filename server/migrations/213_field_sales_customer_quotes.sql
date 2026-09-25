-- Additive customer directory and confirmed Sales Order workflow. Existing
-- immutable quote revisions, estimate links, visits and commands are retained.
CREATE TABLE field_sales_customers (
 id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '',
 billing jsonb NOT NULL DEFAULT '{}', note text NOT NULL DEFAULT '', archived boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX field_sales_customers_name ON field_sales_customers(lower(name));
CREATE TABLE field_sales_customer_types (
 id uuid PRIMARY KEY, name text NOT NULL, archived boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX field_sales_customer_types_name ON field_sales_customer_types(lower(name));
INSERT INTO field_sales_customer_types(id,name) VALUES
 ('21300000-0000-4000-8000-000000000001','General Contractor'),('21300000-0000-4000-8000-000000000002','Builder'),
 ('21300000-0000-4000-8000-000000000003','Contractor'),('21300000-0000-4000-8000-000000000004','Sub-contractor');
CREATE TABLE field_sales_customer_type_links (
 customer_id uuid NOT NULL REFERENCES field_sales_customers(id),type_id uuid NOT NULL REFERENCES field_sales_customer_types(id),PRIMARY KEY(customer_id,type_id)
);
CREATE TABLE field_sales_customer_representatives (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES field_sales_customers(id), name text NOT NULL,
 role text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '', archived boolean NOT NULL DEFAULT false
);
CREATE INDEX field_sales_customer_representatives_customer ON field_sales_customer_representatives(customer_id);
CREATE TABLE field_sales_customer_sites (
 customer_id uuid NOT NULL REFERENCES field_sales_customers(id),jobsite_id uuid NOT NULL REFERENCES field_sales_jobsites(id),
 created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(customer_id,jobsite_id)
);
CREATE INDEX field_sales_customer_sites_jobsite ON field_sales_customer_sites(jobsite_id);
CREATE TABLE field_sales_customer_accounts (
 customer_id uuid NOT NULL REFERENCES field_sales_customers(id),account_group text NOT NULL CHECK(account_group IN ('MBBS','MBT_MBR')),
 external_id text NOT NULL UNIQUE,netsuite_id text,reference text,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(customer_id,account_group),
 CHECK(netsuite_id IS NULL OR netsuite_id ~ '^[1-9][0-9]*$')
);
ALTER TABLE field_sales_quotes ADD COLUMN company text CHECK(company IN ('MBBS','MBR','MBT')),
 ADD COLUMN customer_id uuid REFERENCES field_sales_customers(id),
 ADD COLUMN representative_id uuid REFERENCES field_sales_customer_representatives(id),
 ADD COLUMN confirmation jsonb,
 ADD COLUMN copied_from uuid REFERENCES field_sales_quotes(id);
CREATE TABLE field_sales_quote_evidence (
 id uuid PRIMARY KEY,quote_id uuid NOT NULL REFERENCES field_sales_quotes(id),revision integer NOT NULL,
 actor_id text NOT NULL,name text NOT NULL,content_type text NOT NULL,content bytea NOT NULL,sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),CHECK(octet_length(content)<=8388608),
 FOREIGN KEY(quote_id,revision) REFERENCES field_sales_quote_revisions(quote_id,revision)
);
CREATE TABLE field_sales_order_jobs (
 id uuid PRIMARY KEY,quote_id uuid NOT NULL UNIQUE REFERENCES field_sales_quotes(id),revision integer NOT NULL,
 customer_id uuid NOT NULL REFERENCES field_sales_customers(id),account_group text NOT NULL CHECK(account_group IN ('MBBS','MBT_MBR')),
 payload jsonb NOT NULL,external_id text NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','working','uncertain','done','attention')),
 customer_netsuite_id text,netsuite_id text,reference text,error text,result jsonb,
 attempt integer NOT NULL DEFAULT 0,lease_until timestamptz,lease_token uuid,next_attempt_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(quote_id,revision) REFERENCES field_sales_quote_revisions(quote_id,revision)
);
CREATE INDEX field_sales_order_jobs_pending ON field_sales_order_jobs(next_attempt_at) WHERE state IN ('pending','uncertain','working');
UPDATE field_sales_settings SET data=data||'{"salesOrderPostingEnabled":false}'::jsonb,revision=revision+1,updated_at=now();
