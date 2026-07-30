ALTER TABLE scm_smart_settings
  ALTER COLUMN execution_mode SET DEFAULT 'live';

UPDATE scm_smart_settings
   SET execution_mode = 'live',
       updated_at = now()
 WHERE id = 1
   AND execution_mode = 'mock';
