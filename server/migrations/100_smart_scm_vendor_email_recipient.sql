ALTER TABLE scm_smart_vendor_workflows
  ADD COLUMN IF NOT EXISTS email_to text NOT NULL DEFAULT '';

COMMENT ON COLUMN scm_smart_vendor_workflows.email_to IS
  'User-maintained recipient list for the Vendor Replies email draft.';
