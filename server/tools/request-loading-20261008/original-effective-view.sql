SELECT event.* FROM dispatch_order_completion_events event
WHERE NOT EXISTS (
  SELECT 1 FROM dispatch_driver_co_identity_corrections correction
  WHERE event.completion_evidence_type = 'driver_job'
    AND event.completion_evidence_id = correction.job_id
    AND lower(btrim(event.order_ref)) = ANY(dispatch_co_identity_ref_set(correction.original_order_refs))
)
  AND NOT EXISTS (
    SELECT 1 FROM dispatch_direct_ship_completion_corrections correction
    WHERE correction.completion_event_id = event.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM driver_job_corrections correction
    WHERE event.completion_evidence_type = 'driver_job'
      AND correction.action = 'reopen'
      AND correction.id > COALESCE(event.reopen_correction_id, 0)
      AND (correction.job_id = event.completion_evidence_id
        OR correction.result->'physicalVisitJobIds' ? event.completion_evidence_id)
  )
