CREATE TABLE IF NOT EXISTS app_menu_order_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  orders jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(orders)='object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_by text REFERENCES operators(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_menu_order_settings(id) VALUES(true) ON CONFLICT DO NOTHING;
