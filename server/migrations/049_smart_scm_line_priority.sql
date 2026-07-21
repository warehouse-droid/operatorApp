ALTER TABLE scm_smart_proposal_lines
  ADD COLUMN IF NOT EXISTS urgent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provisional boolean NOT NULL DEFAULT false;

UPDATE scm_smart_proposal_lines line
   SET urgent = proposal.urgent,
       provisional = proposal.provisional
  FROM scm_smart_proposals proposal
 WHERE proposal.id = line.proposal_id
   AND (proposal.urgent OR proposal.provisional);

COMMENT ON COLUMN scm_smart_proposal_lines.urgent IS
  'Line-level replenishment priority. Urgent and non-urgent lines may share the same physical load.';

COMMENT ON COLUMN scm_smart_proposal_lines.provisional IS
  'Line-level indication that the recommendation depends on unconfirmed vendor supply; it does not split a compatible load.';
