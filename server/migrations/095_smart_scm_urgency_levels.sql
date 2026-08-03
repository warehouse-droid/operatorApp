ALTER TABLE scm_smart_proposals
  ADD COLUMN IF NOT EXISTS urgency_level text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS urgency_score numeric NOT NULL DEFAULT 0;

ALTER TABLE scm_smart_proposal_lines
  ADD COLUMN IF NOT EXISTS urgency_level text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS urgency_score numeric NOT NULL DEFAULT 0;

UPDATE scm_smart_proposals
   SET urgency_level = CASE WHEN urgent THEN 'urgent' ELSE 'normal' END,
       urgency_score = CASE WHEN urgent THEN GREATEST(0, LEAST(100, urgency_score)) ELSE 0 END
 WHERE urgency_level IS NULL
    OR urgency_level NOT IN ('normal', 'urgent', 'super_urgent', 'ultimate_urgent')
    OR (urgent AND urgency_level = 'normal')
    OR (NOT urgent AND urgency_level <> 'normal');

UPDATE scm_smart_proposal_lines
   SET urgency_level = CASE WHEN urgent THEN 'urgent' ELSE 'normal' END,
       urgency_score = CASE WHEN urgent THEN GREATEST(0, LEAST(100, urgency_score)) ELSE 0 END
 WHERE urgency_level IS NULL
    OR urgency_level NOT IN ('normal', 'urgent', 'super_urgent', 'ultimate_urgent')
    OR (urgent AND urgency_level = 'normal')
    OR (NOT urgent AND urgency_level <> 'normal');

ALTER TABLE scm_smart_proposals
  DROP CONSTRAINT IF EXISTS scm_smart_proposals_urgency_level_check,
  DROP CONSTRAINT IF EXISTS scm_smart_proposals_urgency_score_check;

ALTER TABLE scm_smart_proposals
  ADD CONSTRAINT scm_smart_proposals_urgency_level_check CHECK (
    urgency_level IN ('normal', 'urgent', 'super_urgent', 'ultimate_urgent')
  ),
  ADD CONSTRAINT scm_smart_proposals_urgency_score_check CHECK (
    urgency_score >= 0 AND urgency_score <= 100
  );

ALTER TABLE scm_smart_proposal_lines
  DROP CONSTRAINT IF EXISTS scm_smart_proposal_lines_urgency_level_check,
  DROP CONSTRAINT IF EXISTS scm_smart_proposal_lines_urgency_score_check;

ALTER TABLE scm_smart_proposal_lines
  ADD CONSTRAINT scm_smart_proposal_lines_urgency_level_check CHECK (
    urgency_level IN ('normal', 'urgent', 'super_urgent', 'ultimate_urgent')
  ),
  ADD CONSTRAINT scm_smart_proposal_lines_urgency_score_check CHECK (
    urgency_score >= 0 AND urgency_score <= 100
  );

CREATE INDEX IF NOT EXISTS idx_scm_smart_proposals_urgency
  ON scm_smart_proposals (run_id, urgency_level, urgency_score DESC, id);

COMMENT ON COLUMN scm_smart_proposal_lines.urgency_level IS
  'Yard-relative replenishment urgency: normal, urgent, super urgent, or ultimate urgent.';

COMMENT ON COLUMN scm_smart_proposal_lines.urgency_score IS
  'Empirical yard demand percentile from 0 through 100 used to order lines within an urgency tier.';

COMMENT ON COLUMN scm_smart_proposals.urgency_level IS
  'Highest urgency level among the proposal lines. The legacy urgent flag remains true for every non-normal level.';
