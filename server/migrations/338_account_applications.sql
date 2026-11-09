-- Customer account applications: staff-issued, expiring customer links; a signed
-- application form; Accounting review and NetSuite customer creation.
-- Card numbers, CVVs and ID-document images are never stored here: they live
-- encrypted in the Cloudflare account vault and only references are kept.

ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_role_check;
ALTER TABLE operators ADD CONSTRAINT operators_role_check CHECK(role IN ('operator','dispatcher','admin','scm','yard_manager','sales','field_sales','mbt_frontdesk','mbt_billing','boss','mbr_sales','repair_technician','repair_office','accounting'));
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_roles_allowed_check;
ALTER TABLE operators ADD CONSTRAINT operators_roles_allowed_check CHECK(cardinality(roles)>0 AND role=ANY(roles) AND roles <@ ARRAY['operator','dispatcher','admin','scm','yard_manager','sales','field_sales','mbt_frontdesk','mbt_billing','boss','mbr_sales','repair_technician','repair_office','accounting']::text[]);

CREATE TABLE account_application_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 data jsonb NOT NULL,
 updated_by text REFERENCES operators(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO account_application_settings(data) VALUES ($json${
 "defaultValidityDays": 7,
 "maxValidityDays": 30,
 "profiles": [
  {"key":"MBBS-3445","company":"MBBS","label":"MBBS · 3445 Kennedy Rd","yardLocationId":1,"legalName":"Mr Bin Building Supply LTD",
   "addressLines":["3445 Kennedy Road","Scarborough ON M1V 4Y3"],"phone":"(416) 912-9555","hstNumber":"719366486","active":true,
   "netsuite":{"subsidiaryId":"1","locationId":"1","additionalSubsidiaryIds":[],"defaultTermsId":"4","defaultCreditLevelId":"5","defaultPriceLevelId":"3","defaultStatusId":"13"}},
  {"key":"MBBS-2967","company":"MBBS","label":"MBBS · 2967 Kennedy Rd","yardLocationId":28,"legalName":"Mr Bin Building Supply LTD",
   "addressLines":["2967 Kennedy Road","Scarborough ON M1V 1S9"],"phone":"(416) 912-9555","hstNumber":"719366486","active":true,
   "netsuite":{"subsidiaryId":"1","locationId":"28","additionalSubsidiaryIds":[],"defaultTermsId":"4","defaultCreditLevelId":"5","defaultPriceLevelId":"3","defaultStatusId":"13"}},
  {"key":"MBBS-150","company":"MBBS","label":"MBBS · 150 Clark Blvd","yardLocationId":26,"legalName":"Mr Bin Building Supply LTD",
   "addressLines":["150 Clark Blvd","Brampton ON L6T 4Y8"],"phone":"(416) 912-9555","hstNumber":"719366486","active":true,
   "netsuite":{"subsidiaryId":"1","locationId":"26","additionalSubsidiaryIds":[],"defaultTermsId":"4","defaultCreditLevelId":"5","defaultPriceLevelId":"3","defaultStatusId":"13"}},
  {"key":"MBT","company":"MBT","label":"MBT · Mr Bin Trucking","yardLocationId":null,"legalName":"Mr Bin Trucking Inc.",
   "addressLines":["3445 Kennedy Road","Scarborough ON M1V 4Y3"],"phone":"(416) 912-9555","hstNumber":"778254540","active":true,
   "netsuite":{"subsidiaryId":"3","locationId":"5","additionalSubsidiaryIds":["7"],"defaultTermsId":"4","defaultCreditLevelId":"5","defaultPriceLevelId":"3","defaultStatusId":"13"}},
  {"key":"MBR","company":"MBR","label":"MBR · Mr Bin Equipment Rental","yardLocationId":null,"legalName":"Mr Bin Equipment Rental Inc.",
   "addressLines":["3445 Kennedy Road","Scarborough ON M1V 4Y3"],"phone":"(416) 912-9555","hstNumber":"777557869","active":true,
   "netsuite":{"subsidiaryId":"7","locationId":"","additionalSubsidiaryIds":["3"],"defaultTermsId":"4","defaultCreditLevelId":"5","defaultPriceLevelId":"3","defaultStatusId":"13"}}
 ],
 "attestation": {
  "en": "I certify that the information in this application is true and complete, that I am authorized to apply for an account on behalf of the business named above, and I authorize {company} to verify the information provided.",
  "zh": "本人证明本申请表所填信息真实完整，本人有权代表上述企业申请账户，并授权{company}核实所提供的信息。"
 },
 "cardAuthorization": {
  "en": "I authorize {company} to keep this credit card on file and to charge it for purchases made on this account.",
  "zh": "本人授权{company}保存此信用卡信息，并用于支付本账户的购货款项。"
 }
}$json$::jsonb);

CREATE SEQUENCE account_application_number_seq;
CREATE FUNCTION account_application_next_number() RETURNS text LANGUAGE sql VOLATILE AS $$
 SELECT 'ACC-'||to_char(clock_timestamp(),'YYYY')||'-'||CASE WHEN length(value)>6 THEN value ELSE lpad(value,6,'0') END
 FROM (SELECT nextval('account_application_number_seq')::text AS value) next_number
$$;

CREATE TABLE account_applications (
 id uuid PRIMARY KEY,
 number text NOT NULL UNIQUE DEFAULT account_application_next_number(),
 status text NOT NULL DEFAULT 'sent'
   CHECK(status IN ('sent','opened','submitted','creating','created','rejected','expired','cancelled')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 company text NOT NULL CHECK(company IN ('MBBS','MBT','MBR')),
 profile_key text NOT NULL,
 profile_snapshot jsonb NOT NULL,
 customer_name text NOT NULL CHECK(length(customer_name) BETWEEN 1 AND 200),
 contact_phone text NOT NULL DEFAULT '',
 contact_email text NOT NULL DEFAULT '',
 staff_note text NOT NULL DEFAULT '',
 created_by text NOT NULL REFERENCES operators(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 active_link_id uuid,
 expires_at timestamptz NOT NULL,
 opened_at timestamptz,
 submitted_at timestamptz,
 -- Customer submission
 submission_id uuid UNIQUE,
 submission_sha256 text,
 legal_name text,
 trade_name text,
 street text,
 city text,
 province text,
 postal_code text,
 phone text,
 email text,
 nature text[] CHECK(nature IS NULL OR (cardinality(nature)>0 AND nature <@ ARRAY['renovation','landscaping']::text[])),
 signer_name text,
 signer_title text,
 language text CHECK(language IS NULL OR language IN ('en','zh-CN')),
 attestation_text text,
 card_authorization_text text,
 signature_png bytea,
 signature_sha256 text,
 submitted_ip text,
 submitted_user_agent text,
 pdf bytea,
 pdf_sha256 text,
 -- Card reference only. The card itself is in the vault.
 card_ref text,
 card_brand text,
 card_last4 text CHECK(card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
 card_exp_month integer CHECK(card_exp_month IS NULL OR card_exp_month BETWEEN 1 AND 12),
 card_exp_year integer,
 card_has_cvv boolean NOT NULL DEFAULT false,
 card_cvv_purged_at timestamptz,
 card_charged_at timestamptz,
 card_deleted_at timestamptz,
 -- Accounting decision
 approval jsonb,
 reviewed_by text REFERENCES operators(id),
 reviewed_at timestamptz,
 reject_reason text,
 netsuite_customer_id text,
 netsuite_external_id text,
 netsuite_error text,
 netsuite_attempted_at timestamptz,
 CHECK(status NOT IN ('submitted','creating','created','rejected') OR (submitted_at IS NOT NULL AND submission_id IS NOT NULL
   AND submission_sha256 IS NOT NULL AND legal_name IS NOT NULL AND signature_png IS NOT NULL AND pdf IS NOT NULL)),
 CHECK(status<>'created' OR netsuite_customer_id IS NOT NULL),
 CHECK((card_ref IS NULL) = (card_last4 IS NULL))
);
CREATE TABLE account_application_links (
 id uuid PRIMARY KEY,
 application_id uuid NOT NULL REFERENCES account_applications(id),
 token_hash text NOT NULL UNIQUE,
 encrypted_token jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 invalidated_at timestamptz
);
CREATE UNIQUE INDEX account_application_links_active_unique ON account_application_links(application_id) WHERE invalidated_at IS NULL;
ALTER TABLE account_applications ADD CONSTRAINT account_application_active_link_fk
 FOREIGN KEY(active_link_id) REFERENCES account_application_links(id);

CREATE TABLE account_application_uploads (
 id uuid PRIMARY KEY,
 application_id uuid NOT NULL REFERENCES account_applications(id),
 kind text NOT NULL CHECK(kind IN ('business_card','drivers_license')),
 vault_ref text NOT NULL UNIQUE,
 mime_type text NOT NULL,
 byte_size integer NOT NULL CHECK(byte_size>0),
 sha256 text NOT NULL,
 attached boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 deleted_at timestamptz
);
CREATE INDEX account_application_uploads_by_application ON account_application_uploads(application_id,kind) WHERE deleted_at IS NULL;

CREATE TABLE account_application_events (
 id bigserial PRIMARY KEY,
 application_id uuid NOT NULL REFERENCES account_applications(id),
 kind text NOT NULL CHECK(kind IN ('created','link_issued','link_regenerated','opened','submitted','extended','cancelled','expired',
   'card_revealed','document_viewed','card_charged','cvv_purged','card_deleted','documents_deleted','approved','netsuite_failed',
   'netsuite_created','linked_existing','rejected')),
 actor_id text REFERENCES operators(id),
 details jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX account_application_events_history ON account_application_events(application_id,id);
CREATE INDEX account_applications_expiry ON account_applications(expires_at) WHERE status IN ('sent','opened');
CREATE INDEX account_applications_by_creator ON account_applications(created_by,updated_at DESC);
CREATE INDEX account_applications_list ON account_applications(updated_at DESC,id);
CREATE INDEX account_applications_cvv_backstop ON account_applications(submitted_at) WHERE card_has_cvv AND card_cvv_purged_at IS NULL AND card_deleted_at IS NULL;
