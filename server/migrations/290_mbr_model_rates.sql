-- Model defaults are copied into contract forms; saved contract prices remain independent.
CREATE TABLE mbr_model_rates (
 model text PRIMARY KEY CHECK(length(model) BETWEEN 1 AND 300),
 daily_rate_minor bigint CHECK(daily_rate_minor BETWEEN 0 AND 999999999999),
 weekly_rate_minor bigint CHECK(weekly_rate_minor BETWEEN 0 AND 999999999999),
 monthly_rate_minor bigint CHECK(monthly_rate_minor BETWEEN 0 AND 999999999999),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_by text REFERENCES operators(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- The existing equipment roster calls ER636H "ER636H Cab".
INSERT INTO mbr_model_rates(model,daily_rate_minor,weekly_rate_minor,monthly_rate_minor) VALUES
 ('ER620H',28000,125000,330000),
 ('ER627H',33000,130000,375000),
 ('ER636H Cab',37000,145000,400000),
 ('ER655H',45000,150000,450000),
 ('ER680H',68000,220000,620000),
 ('STR1000H',25000,100000,300000),
 ('ATL1000',25000,100000,300000),
 ('TV1100H',45000,150000,340000),
 ('S1932E',15000,28500,59000),
 ('S2632E',16000,35000,73000),
 ('S4046E',23000,65000,149000);
