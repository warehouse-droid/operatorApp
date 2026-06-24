CREATE TABLE IF NOT EXISTS dispatch_parser_rules (
  rule_key text PRIMARY KEY,
  rule_value text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO dispatch_parser_rules (rule_key, rule_value, description)
VALUES
  ('address_labels', 'Delivery Address,Address,Ship to,Deliver to,Add,送货地址', 'Comma separated labels that mean delivery address.'),
  ('time_labels', 'Delivery Time,Delivery Window,送货时间', 'Comma separated labels that mean delivery time.'),
  ('instruction_labels', 'Drop-off Loc,Drop off,Drop-off,砖的放置,放置', 'Comma separated labels that should become delivery instructions.'),
  ('am_window', '08:00-12:00', 'Window used when note says AM/上午.'),
  ('pm_window', '12:00-22:00', 'Window used when note says PM/下午.'),
  ('noon_window', '11:00-14:00', 'Window used when note says noon/中午.'),
  ('whole_day_window', '08:00-17:00', 'Window used when note has a date but no time window.'),
  ('am_terms', 'AM,上午', 'Comma separated fuzzy AM terms.'),
  ('pm_terms', 'PM,下午', 'Comma separated fuzzy PM terms.'),
  ('noon_terms', 'noon,中午', 'Comma separated fuzzy noon terms.')
ON CONFLICT (rule_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS dispatch_ollama_audit (
  id bigserial PRIMARY KEY,
  parser_type text NOT NULL,
  model text NOT NULL,
  source_ref text,
  prompt text NOT NULL,
  response text,
  parsed jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_ollama_audit_created
  ON dispatch_ollama_audit (created_at DESC);
