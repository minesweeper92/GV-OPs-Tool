-- Collections: what was said to a customer about an overdue invoice, what
-- they promised, what is disputed, whether new sales are on hold, and which
-- reminders are due. Nothing here sends a message: reminders are follow-ups a
-- person completes and records, until a delivery integration is approved.
CREATE TABLE collection_contacts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,entity_id uuid NOT NULL,company_id uuid NOT NULL,invoice_id uuid,
 kind text NOT NULL CHECK(kind IN ('Call','Meeting','Email','Note')),
 summary text NOT NULL CHECK(length(btrim(summary)) BETWEEN 1 AND 2000),
 contacted_on date NOT NULL,
 promise_date date,promise_amount_minor bigint CHECK(promise_amount_minor>0),
 next_action text NOT NULL DEFAULT '' CHECK(length(next_action)<=200),next_action_due date,assignee_id uuid,
 activity_id uuid NOT NULL,task_id uuid,
 created_by uuid NOT NULL REFERENCES users(id),created_by_name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,
 CHECK((promise_date IS NULL)=(promise_amount_minor IS NULL)),
 CHECK((next_action='')=(next_action_due IS NULL)),CHECK((next_action='')=(assignee_id IS NULL)),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id),FOREIGN KEY(tenant_id,company_id) REFERENCES companies(tenant_id,id),
 FOREIGN KEY(tenant_id,entity_id,invoice_id) REFERENCES invoices(tenant_id,entity_id,id),
 FOREIGN KEY(tenant_id,assignee_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE INDEX ON collection_contacts(tenant_id,company_id,contacted_on DESC);
-- A dispute pauses reminders on its invoice until it is resolved. Opening and
-- resolving are separate immutable facts; one invoice has one open dispute.
CREATE TABLE invoice_disputes (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,entity_id uuid NOT NULL,company_id uuid NOT NULL,invoice_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 owner_id uuid NOT NULL,task_id uuid NOT NULL,
 opened_by uuid NOT NULL REFERENCES users(id),opened_by_name text NOT NULL,opened_on date NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,entity_id,invoice_id) REFERENCES invoices(tenant_id,entity_id,id),
 FOREIGN KEY(tenant_id,company_id) REFERENCES companies(tenant_id,id),FOREIGN KEY(tenant_id,owner_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE TABLE invoice_dispute_resolutions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,dispute_id uuid NOT NULL,
 resolution text NOT NULL CHECK(length(btrim(resolution)) BETWEEN 1 AND 1000),resolved_on date NOT NULL,
 resolved_by uuid NOT NULL REFERENCES users(id),resolved_by_name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,dispute_id),FOREIGN KEY(tenant_id,dispute_id) REFERENCES invoice_disputes(tenant_id,id)
);
-- A credit hold applies to one customer in one legal entity. "warn" shows a
-- warning on new sales; "block" refuses new quotes and invoices on the server.
CREATE TABLE customer_credit_holds (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,entity_id uuid NOT NULL,company_id uuid NOT NULL,
 mode text NOT NULL CHECK(mode IN ('warn','block')),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 placed_by uuid NOT NULL REFERENCES users(id),placed_by_name text NOT NULL,placed_on date NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id),FOREIGN KEY(tenant_id,company_id) REFERENCES companies(tenant_id,id)
);
CREATE TABLE customer_credit_hold_releases (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,hold_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),released_on date NOT NULL,
 released_by uuid NOT NULL REFERENCES users(id),released_by_name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,hold_id),FOREIGN KEY(tenant_id,hold_id) REFERENCES customer_credit_holds(tenant_id,id)
);
-- Reminder schedules are versioned: saving creates a new version and earlier
-- versions stay as the record of what applied when a follow-up was done.
CREATE TABLE reminder_schedules (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,entity_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
 steps jsonb NOT NULL CHECK(jsonb_typeof(steps)='array' AND jsonb_array_length(steps) BETWEEN 0 AND 12),
 pause_on_promise boolean NOT NULL DEFAULT true,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,entity_id,version),FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id)
);
-- A reminder step is "followed up" only when a person records that they did
-- it and how. No row means it is still waiting; nothing is sent automatically.
CREATE TABLE reminder_followups (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,entity_id uuid NOT NULL,invoice_id uuid NOT NULL,schedule_id uuid NOT NULL,
 step_key text NOT NULL CHECK(length(step_key) BETWEEN 1 AND 40),
 outcome text NOT NULL CHECK(outcome IN ('Done manually','Skipped')),contact_id uuid,
 note text NOT NULL DEFAULT '' CHECK(length(note)<=1000),followed_up_on date NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),created_by_name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,invoice_id,step_key),
 FOREIGN KEY(tenant_id,entity_id,invoice_id) REFERENCES invoices(tenant_id,entity_id,id),FOREIGN KEY(tenant_id,schedule_id) REFERENCES reminder_schedules(tenant_id,id),
 FOREIGN KEY(tenant_id,contact_id) REFERENCES collection_contacts(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['collection_contacts','invoice_disputes','invoice_dispute_resolutions','customer_credit_holds','customer_credit_hold_releases','reminder_schedules','reminder_followups'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE INDEX ON %I (tenant_id)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO gv_workspace_runtime',t);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION immutable_record()',t);
 END LOOP; END $$;
-- Row locks serialize a second dispute or hold on the same record.
GRANT UPDATE ON invoice_disputes,customer_credit_holds TO gv_workspace_runtime;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['collection_contacts','invoice_disputes','customer_credit_holds','reminder_schedules','reminder_followups'] LOOP
 EXECUTE format('CREATE POLICY entity_scope ON %I AS RESTRICTIVE TO gv_workspace_runtime USING (gv_entity_visible(entity_id))',t);
 END LOOP; END $$;
CREATE POLICY entity_scope ON invoice_dispute_resolutions AS RESTRICTIVE TO gv_workspace_runtime USING (
 EXISTS(SELECT 1 FROM invoice_disputes d WHERE d.tenant_id=invoice_dispute_resolutions.tenant_id AND d.id=dispute_id));
CREATE POLICY entity_scope ON customer_credit_hold_releases AS RESTRICTIVE TO gv_workspace_runtime USING (
 EXISTS(SELECT 1 FROM customer_credit_holds h WHERE h.tenant_id=customer_credit_hold_releases.tenant_id AND h.id=hold_id));
