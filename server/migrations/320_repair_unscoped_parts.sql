-- Physical parts requests and usage belong to a repair job independently of quotes.
ALTER TABLE repair_part_requests ALTER COLUMN quote_id DROP NOT NULL;
ALTER TABLE repair_part_requests ALTER COLUMN quote_line_id DROP NOT NULL;
ALTER TABLE repair_part_usages ALTER COLUMN quote_line_id DROP NOT NULL;
ALTER TABLE repair_attachments ADD COLUMN part_request_id uuid REFERENCES repair_part_requests(id);
ALTER TABLE repair_attachments DROP CONSTRAINT repair_attachments_kind_check;
ALTER TABLE repair_attachments ADD CONSTRAINT repair_attachments_kind_check CHECK(kind IN ('defect','work','handover','receipt','purchase_photo','part_request'));
ALTER TABLE repair_attachments ADD CONSTRAINT repair_attachment_parts_photo CHECK((kind='part_request')=(part_request_id IS NOT NULL) AND (part_request_id IS NULL OR (request_id IS NOT NULL AND job_id IS NOT NULL)));
CREATE INDEX repair_attachments_part_request ON repair_attachments(part_request_id) WHERE part_request_id IS NOT NULL;
