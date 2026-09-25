-- The quote is the parent of company Sales Orders. Retained child rows are
-- aliases/history only; no existing revision, evidence, or command is deleted.
ALTER TABLE field_sales_quotes ADD COLUMN parent_quote_id uuid REFERENCES field_sales_quotes(id),
 ADD CONSTRAINT field_sales_quotes_parent CHECK(parent_quote_id<>id);
CREATE INDEX field_sales_quotes_parent ON field_sales_quotes(parent_quote_id) WHERE parent_quote_id IS NOT NULL;
ALTER TABLE field_sales_order_jobs DROP CONSTRAINT field_sales_order_jobs_quote_id_key,
 ADD COLUMN company text GENERATED ALWAYS AS (payload->>'company') STORED NOT NULL CHECK(company IN ('MBBS','MBT','MBR')),
 ADD CONSTRAINT field_sales_order_jobs_quote_company UNIQUE(quote_id,company);

-- Consolidate proven batches
DO $$
DECLARE receipt record; root record; member record; ids uuid[]; amount integer;
 combined jsonb; lines jsonb; totals jsonb; profiles jsonb; documents jsonb; history jsonb;
BEGIN
 FOR receipt IN SELECT response FROM field_sales_commands
   WHERE kind='quote.saveGroup' AND jsonb_typeof(response->'quotes')='array'
   ORDER BY created_at DESC,id LOOP
  SELECT array_agg((p->>'id')::uuid) INTO ids FROM jsonb_array_elements(receipt.response->'quotes') p;
  IF cardinality(ids) NOT BETWEEN 2 AND 3 THEN CONTINUE; END IF;
  -- Current, distinct companies with a common customer/site and no acceptance
  -- or downstream posting. A later independent edit is not silently merged.
  SELECT count(*) INTO amount FROM field_sales_quotes q
   JOIN jsonb_array_elements(receipt.response->'quotes') p ON q.id=(p->>'id')::uuid
   JOIN field_sales_quote_revisions r ON r.quote_id=q.id AND r.revision=q.revision
   WHERE q.id=ANY(ids) AND q.parent_quote_id IS NULL AND q.company IS NOT NULL
    AND q.revision=(p->>'revision')::integer AND q.confirmation IS NULL
    AND r.snapshot->>'schemaVersion'='2' AND q.customer_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM field_sales_order_jobs j WHERE j.quote_id=q.id)
    AND NOT EXISTS(SELECT 1 FROM field_sales_posting_jobs j WHERE j.quote_id=q.id)
    AND NOT EXISTS(SELECT 1 FROM field_sales_estimates e WHERE e.quote_id=q.id);
  IF amount<>cardinality(ids) THEN CONTINUE; END IF;
  IF (SELECT count(DISTINCT company) FROM field_sales_quotes WHERE id=ANY(ids))<>amount
    OR (SELECT count(DISTINCT jobsite_id) FROM field_sales_quotes WHERE id=ANY(ids))<>1
    OR (SELECT count(DISTINCT customer_id) FROM field_sales_quotes WHERE id=ANY(ids))<>1 THEN CONTINUE; END IF;
  SELECT q.*,r.snapshot INTO root FROM field_sales_quotes q JOIN field_sales_quote_revisions r
   ON r.quote_id=q.id AND r.revision=q.revision WHERE q.id=ANY(ids) ORDER BY q.quote_number LIMIT 1;
  IF (SELECT count(DISTINCT jsonb_build_array(r.snapshot->'note',r.snapshot->'salesRep',r.snapshot->'shippingMethod',r.snapshot->'customerRepresentativeId',r.snapshot->'customer',r.snapshot->'quoteDate'))
    FROM field_sales_quote_revisions r JOIN field_sales_quotes q ON q.id=r.quote_id AND q.revision=r.revision WHERE q.id=ANY(ids))<>1 THEN CONTINUE; END IF;
  lines='[]';totals='{}';profiles='{}';documents='{}';history='[]';
  FOR member IN SELECT q.*,r.snapshot FROM field_sales_quotes q JOIN field_sales_quote_revisions r
    ON r.quote_id=q.id AND r.revision=q.revision WHERE q.id=ANY(ids) ORDER BY q.quote_number LOOP
   lines=lines||COALESCE((SELECT jsonb_agg(l||jsonb_build_object('id',member.company||'-'||md5(l->>'id')) ORDER BY n) FROM jsonb_array_elements(member.snapshot->'lines') WITH ORDINALITY e(l,n)),'[]'::jsonb); totals=totals||(member.snapshot->'companies');
   profiles=profiles||(member.snapshot->'companyProfiles');
   documents=documents||jsonb_build_object(member.company,jsonb_build_object('id',member.id,
    'number','FS-'||member.company||'-'||lpad(member.quote_number::text,6,'0'),'validUntil',member.snapshot->>'validUntil'));
   history=history||jsonb_build_array(jsonb_build_object('id',member.id,'company',member.company,
    'number','FS-'||member.company||'-'||lpad(member.quote_number::text,6,'0'),'revision',member.revision));
  END LOOP;
  IF jsonb_array_length(lines)>200 OR (SELECT sum((v->>'totalMinor')::bigint) FROM jsonb_each(totals) e(k,v))>999999999999 THEN CONTINUE; END IF;
  combined=root.snapshot||jsonb_build_object('schemaVersion',3,'company',null,'revision',root.revision+1,
    'lines',lines,'companies',totals,'companyProfiles',profiles,'documents',documents,'sourceQuotes',history,
    'subtotalMinor',(SELECT sum((v->>'subtotalMinor')::bigint) FROM jsonb_each(totals) e(k,v)),
    'taxMinor',(SELECT sum((v->>'taxMinor')::bigint) FROM jsonb_each(totals) e(k,v)),
    'totalMinor',(SELECT sum((v->>'totalMinor')::bigint) FROM jsonb_each(totals) e(k,v)));
  INSERT INTO field_sales_quote_revisions(quote_id,revision,snapshot,created_by)
   VALUES(root.id,root.revision+1,combined,root.created_by);
  UPDATE field_sales_quotes SET company=NULL,revision=revision+1,updated_at=now() WHERE id=root.id;
  UPDATE field_sales_quotes SET parent_quote_id=root.id WHERE id=ANY(ids) AND id<>root.id;
 END LOOP;
END $$;
