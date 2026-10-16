CREATE TABLE scm_stock_check_vendors (
 id serial PRIMARY KEY, name text NOT NULL, method_key text NOT NULL DEFAULT 'pending',
 selected_account_id integer, active boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
 method_verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE scm_stock_check_accounts (
 id serial PRIMARY KEY, vendor_id integer NOT NULL REFERENCES scm_stock_check_vendors(id),
 label text NOT NULL, username text NOT NULL, encrypted_secret jsonb, active boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1, last_verified_at timestamptz, last_error text,
 UNIQUE(vendor_id,label), UNIQUE(vendor_id,id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE scm_stock_check_vendors ADD CONSTRAINT scm_stock_check_selected_account_fk
 FOREIGN KEY (id,selected_account_id) REFERENCES scm_stock_check_accounts(vendor_id,id);
CREATE TABLE scm_stock_check_products (
 id serial PRIMARY KEY, vendor_id integer NOT NULL REFERENCES scm_stock_check_vendors(id), sku text NOT NULL,
 source_data jsonb NOT NULL, overrides jsonb NOT NULL DEFAULT '{}', manual_created boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1, last_scraped_at timestamptz, updated_by text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(vendor_id,sku)
);
CREATE TABLE scm_stock_check_jobs (
 id uuid PRIMARY KEY, vendor_id integer NOT NULL REFERENCES scm_stock_check_vendors(id),
 account_id integer REFERENCES scm_stock_check_accounts(id), product_id integer REFERENCES scm_stock_check_products(id),
 kind text NOT NULL CHECK(kind IN ('catalog_refresh','login_test','stock_test')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
 payload jsonb NOT NULL DEFAULT '{}', progress jsonb NOT NULL DEFAULT '{}', result jsonb,
 cancel_requested boolean NOT NULL DEFAULT false, created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz, heartbeat_at timestamptz
);
CREATE INDEX scm_stock_check_jobs_queue ON scm_stock_check_jobs(status,created_at);
CREATE TABLE scm_stock_check_steps (
 id serial PRIMARY KEY, job_id uuid NOT NULL REFERENCES scm_stock_check_jobs(id),
 key text NOT NULL, status text NOT NULL CHECK(status IN ('success','failure','info')),
 detail text NOT NULL DEFAULT '', sku text, url text, screenshot text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scm_stock_check_steps_job ON scm_stock_check_steps(job_id,id);
CREATE TABLE scm_stock_check_audit (
 id serial PRIMARY KEY, vendor_id integer REFERENCES scm_stock_check_vendors(id), actor text NOT NULL,
 action text NOT NULL, target_id text, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO scm_stock_check_vendors(name,method_key) VALUES ('Unilock','unilock-ontario-v1');
