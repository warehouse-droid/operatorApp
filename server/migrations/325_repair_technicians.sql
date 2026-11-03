CREATE TABLE repair_technicians (
 id text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]*$'),
 name text NOT NULL CHECK (length(trim(name))>0),
 active boolean NOT NULL DEFAULT true,
 source text NOT NULL DEFAULT 'wor',
 refreshed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE repair_part_usages ADD COLUMN data jsonb NOT NULL DEFAULT '{}'::jsonb;
