ALTER TABLE scm_transport_schedule
  ADD COLUMN IF NOT EXISTS dispatch_assignment_note text;

-- Older dispatch syncs wrote their generated truck/load label into the manual
-- notes field. Move only rows whose creator and latest writer are both clearly
-- dispatch sessions; SCM-edited notes remain untouched.
UPDATE scm_transport_schedule
   SET dispatch_assignment_note = notes,
       notes = NULL
 WHERE COALESCE(notes, '') <> ''
   AND COALESCE(created_by, '') ~ '^dispatch($|-)'
   AND COALESCE(updated_by, '') ~ '^dispatch($|-)'
   AND COALESCE(dispatch_assignment_note, '') = '';
