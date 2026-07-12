CREATE SEQUENCE IF NOT EXISTS canonical_order_line_id_seq;

SELECT setval(
  'canonical_order_line_id_seq',
  GREATEST(
    COALESCE((SELECT MAX(id) FROM sales_order_lines), 0),
    COALESCE((SELECT MAX(id) FROM transfer_order_lines), 0),
    COALESCE((SELECT MAX(id) FROM purchase_order_lines), 0),
    1
  ),
  true
);

ALTER TABLE sales_order_lines
  ALTER COLUMN id SET DEFAULT nextval('canonical_order_line_id_seq');

ALTER TABLE transfer_order_lines
  ALTER COLUMN id SET DEFAULT nextval('canonical_order_line_id_seq');

ALTER TABLE purchase_order_lines
  ALTER COLUMN id SET DEFAULT nextval('canonical_order_line_id_seq');
