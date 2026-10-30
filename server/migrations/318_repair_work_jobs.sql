CREATE TABLE repair_jobs (
 id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES repair_requests(id),number text NOT NULL UNIQUE,
 sequence integer NOT NULL CHECK(sequence>0),revision integer NOT NULL DEFAULT 1,
 status text NOT NULL CHECK(status IN ('queuing','in_progress','waiting_for_parts','completed','re_inspect','cancelled')),
 priority text NOT NULL CHECK(priority IN ('normal','urgent')),outcome text NOT NULL CHECK(outcome IN ('repaired','declined')),
 data jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(request_id,sequence));
INSERT INTO repair_jobs(id,request_id,number,sequence,revision,status,priority,outcome,data,created_at,updated_at)
 SELECT id,id,number||'-J01',1,revision,status,priority,outcome,
 jsonb_strip_nulls(jsonb_build_object('inspectionRequired',true,'inspectionComplete',coalesce((data->>'inspectionComplete')::boolean,false),'phase',coalesce(data->>'phase','inspection'),'defect',data->>'defect','nextStep',data->>'nextStep','assignedTechnician',data->>'assignedTechnician','completedAt',data->>'completedAt')),created_at,updated_at FROM repair_requests;
ALTER TABLE repair_quotes ADD COLUMN job_id uuid REFERENCES repair_jobs(id);
UPDATE repair_quotes SET job_id=request_id,scope_id=request_id;
ALTER TABLE repair_quotes ALTER COLUMN job_id SET NOT NULL;
ALTER TABLE repair_part_requests ADD COLUMN job_id uuid REFERENCES repair_jobs(id);
ALTER TABLE repair_part_usages ADD COLUMN job_id uuid REFERENCES repair_jobs(id);
ALTER TABLE repair_work_entries ADD COLUMN job_id uuid REFERENCES repair_jobs(id);
ALTER TABLE repair_purchase_lines ADD COLUMN job_id uuid REFERENCES repair_jobs(id);
ALTER TABLE repair_stock_movements ADD COLUMN job_id uuid REFERENCES repair_jobs(id);
ALTER TABLE repair_attachments ADD COLUMN job_id uuid REFERENCES repair_jobs(id);
ALTER TABLE repair_events ADD COLUMN job_id uuid REFERENCES repair_jobs(id);
UPDATE repair_part_requests SET job_id=request_id;
UPDATE repair_part_usages SET job_id=request_id;
UPDATE repair_work_entries SET job_id=request_id;
UPDATE repair_purchase_lines SET job_id=request_id;
UPDATE repair_stock_movements SET job_id=request_id;
UPDATE repair_attachments SET job_id=request_id;
UPDATE repair_events SET job_id=request_id;
CREATE INDEX repair_part_requests_job ON repair_part_requests(job_id);
CREATE INDEX repair_work_entries_job ON repair_work_entries(job_id);
CREATE TABLE repair_issues(id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES repair_requests(id),source_job_id uuid NOT NULL REFERENCES repair_jobs(id),job_id uuid REFERENCES repair_jobs(id),description text NOT NULL,status text NOT NULL DEFAULT 'reported' CHECK(status IN ('reported','quoted','dismissed')),reason text NOT NULL DEFAULT '',created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX repair_issues_request ON repair_issues(request_id,status);
