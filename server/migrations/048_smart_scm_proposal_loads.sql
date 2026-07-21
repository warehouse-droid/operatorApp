ALTER TABLE scm_smart_proposals
  ADD COLUMN IF NOT EXISTS route_stops jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS manually_grouped boolean NOT NULL DEFAULT false;

ALTER TABLE scm_smart_proposal_lines
  ADD COLUMN IF NOT EXISTS destination_location_id bigint,
  ADD COLUMN IF NOT EXISTS destination_name text;

UPDATE scm_smart_proposal_lines line
   SET destination_location_id = proposal.destination_location_id,
       destination_name = proposal.destination_name
  FROM scm_smart_proposals proposal
 WHERE proposal.id = line.proposal_id
   AND (line.destination_location_id IS NULL OR NULLIF(BTRIM(line.destination_name), '') IS NULL);

ALTER TABLE scm_smart_proposal_lines
  ALTER COLUMN destination_location_id SET NOT NULL,
  ALTER COLUMN destination_name SET NOT NULL;

ALTER TABLE scm_smart_proposal_lines
  DROP CONSTRAINT IF EXISTS scm_smart_proposal_lines_proposal_id_item_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scm_smart_proposal_lines_item_destination
  ON scm_smart_proposal_lines (proposal_id, item_id, destination_location_id);

WITH stops AS (
  SELECT proposal_id,
         jsonb_agg(
           jsonb_build_object(
             'locationId', destination_location_id,
             'name', destination_name,
             'sequence', stop_sequence
           )
           ORDER BY stop_sequence
         ) AS route_stops
    FROM (
      SELECT proposal_id,
             destination_location_id,
             MIN(destination_name) AS destination_name,
             row_number() OVER (
               PARTITION BY proposal_id
               ORDER BY MIN(id)
             ) AS stop_sequence
        FROM scm_smart_proposal_lines
       GROUP BY proposal_id, destination_location_id
    ) distinct_stops
   GROUP BY proposal_id
)
UPDATE scm_smart_proposals proposal
   SET route_stops = stops.route_stops
  FROM stops
 WHERE stops.proposal_id = proposal.id
   AND proposal.route_stops = '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_scm_smart_proposal_lines_destination
  ON scm_smart_proposal_lines (destination_location_id, proposal_id);

COMMENT ON COLUMN scm_smart_proposals.route_stops IS
  'Ordered physical drop list for a Smart SCM load; PO loads may contain multiple destination yards.';

COMMENT ON COLUMN scm_smart_proposal_lines.destination_location_id IS
  'Destination yard for this proposal line, allowing one vendor pickup load to serve multiple yards.';
