-- Existing quote history belongs to the original scope; new scopes are additive.
ALTER TABLE repair_quotes ADD COLUMN scope_id uuid;
ALTER TABLE repair_quotes ADD COLUMN scope_number integer NOT NULL DEFAULT 1 CHECK(scope_number>0);
ALTER TABLE repair_quotes ADD COLUMN scope_revision integer NOT NULL DEFAULT 1 CHECK(scope_revision>0);
ALTER TABLE repair_quotes ADD COLUMN title text NOT NULL DEFAULT '';
UPDATE repair_quotes q SET scope_id=first_quote.id,scope_revision=q.version
FROM (SELECT DISTINCT ON (request_id) request_id,id FROM repair_quotes ORDER BY request_id,version) first_quote
WHERE first_quote.request_id=q.request_id;
ALTER TABLE repair_quotes ALTER COLUMN scope_id SET NOT NULL;
CREATE UNIQUE INDEX repair_active_quote_scope ON repair_quotes(request_id,scope_id) WHERE status IN ('pending','decided');
CREATE UNIQUE INDEX repair_quote_scope_revision ON repair_quotes(request_id,scope_number,scope_revision);
