ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_role_check;
ALTER TABLE operators ADD CONSTRAINT operators_role_check CHECK(role IN ('operator','dispatcher','admin','scm','yard_manager','sales','field_sales','mbt_frontdesk','mbt_billing','boss','mbr_sales','repair_technician','repair_office'));
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_roles_allowed_check;
ALTER TABLE operators ADD CONSTRAINT operators_roles_allowed_check CHECK(cardinality(roles)>0 AND role=ANY(roles) AND roles <@ ARRAY['operator','dispatcher','admin','scm','yard_manager','sales','field_sales','mbt_frontdesk','mbt_billing','boss','mbr_sales','repair_technician','repair_office']::text[]);

CREATE TABLE repair_settings (id boolean PRIMARY KEY DEFAULT true CHECK(id),revision integer NOT NULL DEFAULT 1,data jsonb NOT NULL,updated_by text,updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO repair_settings(data) VALUES ('{"inspectionFeeMinor":15000,"taxBps":1300,"postingEnabled":false,"mappings":{"subsidiaryId":"7","locationId":"52","classId":"127","currencyId":"1","sosFormId":"183","billFormId":"137","partsAccountId":"2211","inspectionItemId":"10660","partsItemId":"10555","discountItemId":"10716","taxCodeId":"11","mbtCustomerId":"7973","mbrCustomerId":"13366","mbbsCustomerId":""}}');
CREATE TABLE repair_vehicles (
 id uuid PRIMARY KEY,netsuite_id bigint UNIQUE, machine_id bigint, dispatch_truck_id bigint REFERENCES dispatch_trucks(id),
 company text NOT NULL CHECK(company IN ('MBT','MBBS','MBR','EXTERNAL')),customer_id text NOT NULL,
 plate text NOT NULL DEFAULT '',alias text NOT NULL DEFAULT '',serial text NOT NULL DEFAULT '',data jsonb NOT NULL DEFAULT '{}',
 active boolean NOT NULL DEFAULT true,updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX repair_vehicles_dispatch ON repair_vehicles(dispatch_truck_id);
CREATE UNIQUE INDEX repair_vehicles_dispatch_unique ON repair_vehicles(dispatch_truck_id) WHERE dispatch_truck_id IS NOT NULL;
CREATE SEQUENCE repair_request_number_seq;
CREATE TABLE repair_requests (
 id uuid PRIMARY KEY,number text NOT NULL UNIQUE DEFAULT ('REP-'||lpad(nextval('repair_request_number_seq')::text,7,'0')),
 vehicle_id uuid NOT NULL REFERENCES repair_vehicles(id),company text NOT NULL CHECK(company IN ('MBT','MBBS','MBR','EXTERNAL')),
 requester_type text NOT NULL CHECK(requester_type IN ('driver','staff')),requester_id text NOT NULL,yard_id bigint,
 status text NOT NULL DEFAULT 'queuing' CHECK(status IN ('queuing','in_progress','waiting_for_parts','completed','re_inspect','cancelled')),
 condition text NOT NULL CHECK(condition IN ('can_operate','out_of_service')),priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','urgent')),
 receipt text NOT NULL DEFAULT 'none' CHECK(receipt IN ('none','pending','accepted','rejected')),outcome text NOT NULL DEFAULT 'repaired' CHECK(outcome IN ('repaired','declined')),
 inspection_fee_minor bigint NOT NULL CHECK(inspection_fee_minor>=0),inspection_tax_bps integer NOT NULL CHECK(inspection_tax_bps BETWEEN 0 AND 10000),
 revision integer NOT NULL DEFAULT 1,data jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX repair_requests_board ON repair_requests(status,updated_at DESC);
CREATE INDEX repair_requests_owner ON repair_requests(requester_type,requester_id,updated_at DESC);
CREATE INDEX repair_requests_vehicle ON repair_requests(vehicle_id,condition);
CREATE TABLE repair_commands (actor text NOT NULL,command_id uuid NOT NULL,kind text NOT NULL,payload jsonb NOT NULL,digest text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor,command_id));
CREATE TABLE repair_events (id bigserial PRIMARY KEY,request_id uuid REFERENCES repair_requests(id),actor text NOT NULL,kind text NOT NULL,data jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX repair_events_request ON repair_events(request_id,id);
CREATE TABLE repair_work_entries (id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES repair_requests(id),phase text NOT NULL CHECK(phase IN ('inspection','repair')),actor text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE repair_quotes (id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES repair_requests(id),version integer NOT NULL,status text NOT NULL CHECK(status IN ('pending','decided','superseded')),lines jsonb NOT NULL,created_by text NOT NULL,decided_by text,decided_at timestamptz,public_token_hash text UNIQUE,public_expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(request_id,version));
CREATE TABLE repair_parts (id uuid PRIMARY KEY,sku text NOT NULL UNIQUE,name text NOT NULL,unit text NOT NULL DEFAULT 'each',tracked boolean NOT NULL DEFAULT true,active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE repair_part_requests (id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES repair_requests(id),quote_id uuid NOT NULL REFERENCES repair_quotes(id),quote_line_id text NOT NULL,part_id uuid REFERENCES repair_parts(id),description text NOT NULL,quantity_milli bigint NOT NULL CHECK(quantity_milli>0),status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','ordered','received','rejected')),eta date,created_by text NOT NULL,approved_by text,created_at timestamptz NOT NULL DEFAULT now());
CREATE SEQUENCE repair_purchase_number_seq;
CREATE TABLE repair_purchases (id uuid PRIMARY KEY,number text NOT NULL UNIQUE DEFAULT ('PUR-'||lpad(nextval('repair_purchase_number_seq')::text,7,'0')),vendor_id text NOT NULL,invoice_ref text NOT NULL,purchase_date date NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','completed')),revision integer NOT NULL DEFAULT 1,data jsonb NOT NULL DEFAULT '{}',created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX repair_purchase_supplier_invoice ON repair_purchases(vendor_id,lower(btrim(invoice_ref)));
CREATE TABLE repair_purchase_lines (id uuid PRIMARY KEY,purchase_id uuid NOT NULL REFERENCES repair_purchases(id),request_id uuid REFERENCES repair_requests(id),part_request_id uuid REFERENCES repair_part_requests(id),part_id uuid REFERENCES repair_parts(id),category text NOT NULL CHECK(category IN ('general','job_part')),description text NOT NULL,quantity_milli bigint NOT NULL CHECK(quantity_milli>0),received_milli bigint NOT NULL DEFAULT 0 CHECK(received_milli>=0 AND received_milli<=quantity_milli),unit_minor bigint NOT NULL CHECK(unit_minor>=0),tax_bps integer NOT NULL CHECK(tax_bps BETWEEN 0 AND 10000),account_id text NOT NULL,data jsonb NOT NULL DEFAULT '{}');
CREATE TABLE repair_stock_movements (id uuid PRIMARY KEY,part_id uuid NOT NULL REFERENCES repair_parts(id),request_id uuid REFERENCES repair_requests(id),purchase_line_id uuid REFERENCES repair_purchase_lines(id),kind text NOT NULL CHECK(kind IN ('receipt','issue','return','adjustment')),quantity_milli bigint NOT NULL CHECK(quantity_milli<>0),actor text NOT NULL,reason text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX repair_stock_part ON repair_stock_movements(part_id);
CREATE TABLE repair_part_usages (id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES repair_requests(id),part_id uuid REFERENCES repair_parts(id),quote_line_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('issue','return')),quantity_milli bigint NOT NULL CHECK(quantity_milli>0),description text NOT NULL DEFAULT '',actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE repair_attachments (id uuid PRIMARY KEY,request_id uuid REFERENCES repair_requests(id),purchase_id uuid REFERENCES repair_purchases(id),kind text NOT NULL CHECK(kind IN ('defect','work','handover','receipt','purchase_photo')),filename text NOT NULL,mime_type text NOT NULL,byte_size integer NOT NULL CHECK(byte_size>0 AND byte_size<=10485760),sha256 text NOT NULL,storage_key text NOT NULL,caption text NOT NULL DEFAULT '',created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),CHECK((request_id IS NOT NULL)::integer+(purchase_id IS NOT NULL)::integer=1));
CREATE INDEX repair_attachments_request ON repair_attachments(request_id);
CREATE INDEX repair_attachments_purchase ON repair_attachments(purchase_id);
CREATE TABLE repair_notifications (id uuid PRIMARY KEY,recipient text NOT NULL,request_id uuid REFERENCES repair_requests(id),kind text NOT NULL,message text NOT NULL,read_at timestamptz,pushed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX repair_notifications_recipient ON repair_notifications(recipient,created_at DESC);
CREATE TABLE repair_push_subscriptions (actor text NOT NULL,endpoint_hash text NOT NULL,subscription jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor,endpoint_hash));
CREATE TABLE repair_postings (id uuid PRIMARY KEY,request_id uuid REFERENCES repair_requests(id),purchase_id uuid REFERENCES repair_purchases(id),kind text NOT NULL CHECK(kind IN ('inspection','work_update','bill')),state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','working','uncertain','attention','done')),payload jsonb NOT NULL DEFAULT '{}',attempt integer NOT NULL DEFAULT 0,lease_token uuid,lease_until timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now(),error text,result jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX repair_one_inspection ON repair_postings(request_id) WHERE kind='inspection';
CREATE UNIQUE INDEX repair_one_bill ON repair_postings(purchase_id) WHERE kind='bill';
CREATE INDEX repair_posting_queue ON repair_postings(state,next_attempt_at);
