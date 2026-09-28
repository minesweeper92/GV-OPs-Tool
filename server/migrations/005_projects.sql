-- Preserve every existing invoice as a standalone immutable financial snapshot.
ALTER TABLE invoices ADD COLUMN lines jsonb;
ALTER TABLE invoices ADD COLUMN net_minor bigint;
ALTER TABLE invoices ADD COLUMN tax_minor bigint;
ALTER TABLE invoices ADD COLUMN total_minor bigint;
ALTER TABLE invoices DISABLE TRIGGER invoice_history;
UPDATE invoices i SET lines=q.lines,net_minor=q.net_minor,tax_minor=q.tax_minor,total_minor=q.total_minor FROM quotes q WHERE q.id=i.quote_id;
ALTER TABLE invoices ENABLE TRIGGER invoice_history;
ALTER TABLE invoices ALTER COLUMN lines SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN net_minor SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN tax_minor SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN total_minor SET NOT NULL;
ALTER TABLE invoices ADD CHECK(net_minor>=0 AND tax_minor>=0 AND total_minor=net_minor+tax_minor AND total_minor>0 AND paid_minor<=total_minor);
ALTER TABLE invoices DROP CONSTRAINT invoices_tenant_id_deal_id_key;
ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CHECK(status IN ('Draft','Issued','Paid','Voided','Cancelled'));
ALTER TABLE invoices ADD COLUMN billing_kind text NOT NULL DEFAULT 'earned' CHECK(billing_kind IN ('earned','advance'));
ALTER TABLE invoices ADD COLUMN label text NOT NULL DEFAULT 'Accepted quote';
ALTER TABLE invoices ADD COLUMN request_key uuid;
ALTER TABLE invoices ADD COLUMN request_payload jsonb;
CREATE UNIQUE INDEX invoice_retry ON invoices(tenant_id,request_key) WHERE request_key IS NOT NULL;

CREATE TABLE projects (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL, deal_id uuid NOT NULL, quote_id uuid NOT NULL,
 name text NOT NULL, code text NOT NULL, start_date date NOT NULL, end_date date,
 budget_minor bigint NOT NULL CHECK(budget_minor>=0), status text NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','On hold','Completed')),
 version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,deal_id), UNIQUE(tenant_id,entity_id,id), UNIQUE(tenant_id,entity_id,code), CHECK(end_date IS NULL OR end_date>=start_date),
 FOREIGN KEY(tenant_id,deal_id,quote_id) REFERENCES quotes(tenant_id,deal_id,id), FOREIGN KEY(tenant_id,entity_id,deal_id) REFERENCES deals(tenant_id,entity_id,id)
);
CREATE TABLE project_milestones (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, project_id uuid NOT NULL, name text NOT NULL, due_date date NOT NULL,
 net_minor bigint NOT NULL CHECK(net_minor>0), billing_kind text NOT NULL CHECK(billing_kind IN ('earned','advance')),
 status text NOT NULL DEFAULT 'Planned' CHECK(status IN ('Planned','Cancelled')), created_at timestamptz NOT NULL DEFAULT now(),
 request_key uuid NOT NULL, request_payload jsonb NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_key), FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,id)
);
ALTER TABLE invoices ADD COLUMN milestone_id uuid;
ALTER TABLE invoices ADD FOREIGN KEY(tenant_id,milestone_id) REFERENCES project_milestones(tenant_id,id);
CREATE UNIQUE INDEX active_milestone_invoice ON invoices(tenant_id,milestone_id) WHERE status NOT IN ('Voided','Cancelled');
CREATE TABLE revenue_recognitions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, invoice_id uuid NOT NULL, recognition_date date NOT NULL,
 net_minor bigint NOT NULL CHECK(net_minor>0), base_minor bigint NOT NULL CHECK(base_minor>=0), reference text NOT NULL,
 request_key uuid NOT NULL, request_payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_key), FOREIGN KEY(tenant_id,invoice_id) REFERENCES invoices(tenant_id,id)
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON revenue_recognitions FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION project_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.deal_id,NEW.quote_id,NEW.code,NEW.created_by,NEW.created_at) IS DISTINCT FROM
 ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.deal_id,OLD.quote_id,OLD.code,OLD.created_by,OLD.created_at) OR NEW.version<>OLD.version+1
 THEN RAISE EXCEPTION 'Project identity is immutable; updates require a new version'; END IF; RETURN NEW; END $$;
CREATE TRIGGER project_history BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION project_history_guard();
CREATE FUNCTION milestone_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.project_id,NEW.name,NEW.due_date,NEW.net_minor,NEW.billing_kind,NEW.created_at,NEW.request_key,NEW.request_payload) IS DISTINCT FROM
 ROW(OLD.id,OLD.tenant_id,OLD.project_id,OLD.name,OLD.due_date,OLD.net_minor,OLD.billing_kind,OLD.created_at,OLD.request_key,OLD.request_payload) OR OLD.status<>'Planned' OR NEW.status<>'Cancelled'
 THEN RAISE EXCEPTION 'Cancel a milestone and create a replacement'; END IF; RETURN NEW; END $$;
CREATE TRIGGER milestone_history BEFORE UPDATE ON project_milestones FOR EACH ROW EXECUTE FUNCTION milestone_history_guard();
CREATE OR REPLACE FUNCTION invoice_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.deal_id,NEW.quote_id,NEW.issue_date,NEW.due_date,NEW.created_at,NEW.lines,NEW.net_minor,NEW.tax_minor,NEW.total_minor,NEW.billing_kind,NEW.label,NEW.milestone_id,NEW.request_key,NEW.request_payload)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.deal_id,OLD.quote_id,OLD.issue_date,OLD.due_date,OLD.created_at,OLD.lines,OLD.net_minor,OLD.tax_minor,OLD.total_minor,OLD.billing_kind,OLD.label,OLD.milestone_id,OLD.request_key,OLD.request_payload)
 OR (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number)
 THEN RAISE EXCEPTION 'Invoice history is immutable'; END IF;
 IF OLD.status IN ('Paid','Voided','Cancelled') THEN RAISE EXCEPTION 'A closed invoice cannot be changed'; END IF;
 IF (OLD.status='Draft' AND NEW.status NOT IN ('Issued','Cancelled')) OR (OLD.status='Issued' AND NEW.status NOT IN ('Issued','Paid','Voided'))
 THEN RAISE EXCEPTION 'Invalid invoice status transition'; END IF; RETURN NEW; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['projects','project_milestones','revenue_recognitions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE INDEX ON %I (tenant_id)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO gv_workspace_runtime',t);
 END LOOP; END $$;
GRANT UPDATE ON projects,project_milestones TO gv_workspace_runtime;
INSERT INTO accounts(tenant_id,entity_id,code,name,type) SELECT tenant_id,id,'2300','Deferred service revenue','Liability' FROM entities;
