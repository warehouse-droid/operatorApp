-- Verified material mismatches need explicit correction, not one retry per minute.
-- Keep failed state and the transaction identity so manual recovery stays available.
ALTER TABLE return_batch_authorizations
  ADD COLUMN IF NOT EXISTS sync_error_code text,
  ADD COLUMN IF NOT EXISTS automatic_retry_blocked boolean NOT NULL DEFAULT false;

UPDATE return_batch_authorizations
   SET sync_error_code = CASE
         WHEN sync_error LIKE 'Credit Memo verification failed:%' THEN 'RETURN_CM_VERIFICATION_FAILED'
         ELSE 'RETURN_RA_VERIFICATION_FAILED'
       END,
       automatic_retry_blocked = true
 WHERE sync_status = 'failed'
   AND (sync_error LIKE 'Credit Memo verification failed:%'
        OR sync_error LIKE 'Return Authorization verification failed:%');
