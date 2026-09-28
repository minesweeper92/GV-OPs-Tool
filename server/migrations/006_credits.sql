ALTER TABLE entities ADD COLUMN next_credit integer NOT NULL DEFAULT 1;
ALTER TABLE invoices ADD COLUMN credited_minor bigint NOT NULL DEFAULT 0 CHECK(credited_minor>=0);
ALTER TABLE invoices ADD COLUMN credited_base_minor bigint NOT NULL DEFAULT 0 CHECK(credited_base_minor>=0);
ALTER TABLE invoices ADD CHECK(paid_minor+credited_minor<=total_minor);
-- Locate the current generated status check without depending on PostgreSQL's suffix naming.
DO $$ DECLARE c record; BEGIN FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='invoices'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP EXECUTE format('ALTER TABLE invoices DROP CONSTRAINT %I',c.conname); END LOOP; END $$;
ALTER TABLE invoices ADD CHECK(status IN ('Draft','Issued','Paid','Settled','Voided','Cancelled'));
CREATE OR REPLACE FUNCTION invoice_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.deal_id,NEW.quote_id,NEW.issue_date,NEW.due_date,NEW.created_at,NEW.lines,NEW.net_minor,NEW.tax_minor,NEW.total_minor,NEW.billing_kind,NEW.label,NEW.milestone_id,NEW.request_key,NEW.request_payload)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.deal_id,OLD.quote_id,OLD.issue_date,OLD.due_date,OLD.created_at,OLD.lines,OLD.net_minor,OLD.tax_minor,OLD.total_minor,OLD.billing_kind,OLD.label,OLD.milestone_id,OLD.request_key,OLD.request_payload)
 OR (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number)
 THEN RAISE EXCEPTION 'Invoice history is immutable'; END IF;
 IF OLD.status IN ('Paid','Voided','Cancelled') THEN RAISE EXCEPTION 'A closed invoice cannot be changed'; END IF;
 IF (OLD.status='Draft' AND NEW.status NOT IN ('Issued','Cancelled')) OR (OLD.status IN ('Issued','Settled') AND NEW.status NOT IN ('Issued','Paid','Settled','Voided'))
 THEN RAISE EXCEPTION 'Invalid invoice status transition'; END IF; RETURN NEW; END $$;
CREATE TABLE credit_notes (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,entity_id uuid NOT NULL,invoice_id uuid NOT NULL,number text NOT NULL,credit_date date NOT NULL,
 lines jsonb NOT NULL,net_minor bigint NOT NULL CHECK(net_minor>0),tax_minor bigint NOT NULL CHECK(tax_minor>=0),total_minor bigint NOT NULL CHECK(total_minor=net_minor+tax_minor),
 net_base_minor bigint NOT NULL CHECK(net_base_minor>=0),tax_base_minor bigint NOT NULL CHECK(tax_base_minor>=0),base_minor bigint NOT NULL CHECK(base_minor=net_base_minor+tax_base_minor AND base_minor>0),
 treatment text NOT NULL CHECK(treatment IN ('earned','deferred')),reason text NOT NULL,request_key uuid NOT NULL,request_payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),UNIQUE(tenant_id,entity_id,number),FOREIGN KEY(tenant_id,entity_id,invoice_id) REFERENCES invoices(tenant_id,entity_id,id)
);
CREATE TABLE credit_applications (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,credit_id uuid NOT NULL,invoice_id uuid NOT NULL,application_date date NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),credit_base_minor bigint NOT NULL CHECK(credit_base_minor>=0),ar_base_minor bigint NOT NULL CHECK(ar_base_minor>=0),
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,credit_id) REFERENCES credit_notes(tenant_id,id),FOREIGN KEY(tenant_id,invoice_id) REFERENCES invoices(tenant_id,id)
);
CREATE TABLE customer_refunds (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,credit_id uuid NOT NULL,refund_date date NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),
 credit_base_minor bigint NOT NULL CHECK(credit_base_minor>=0),fx_micros bigint NOT NULL CHECK(fx_micros>0),bank_account_id uuid,reference text NOT NULL,
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,credit_id) REFERENCES credit_notes(tenant_id,id),FOREIGN KEY(tenant_id,bank_account_id) REFERENCES bank_accounts(tenant_id,id)
);
CREATE TABLE credit_reversals (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,credit_id uuid NOT NULL,reversal_date date NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,credit_id),FOREIGN KEY(tenant_id,credit_id) REFERENCES credit_notes(tenant_id,id)
);
CREATE TABLE application_reversals (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,application_id uuid NOT NULL,reversal_date date NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,application_id),FOREIGN KEY(tenant_id,application_id) REFERENCES credit_applications(tenant_id,id)
);
CREATE TABLE refund_reversals (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,refund_id uuid NOT NULL,reversal_date date NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,refund_id),FOREIGN KEY(tenant_id,refund_id) REFERENCES customer_refunds(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['credit_notes','credit_applications','customer_refunds','credit_reversals','application_reversals','refund_reversals'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE INDEX ON %I (tenant_id)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO gv_workspace_runtime',t);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION immutable_record()',t);
 END LOOP; END $$;
INSERT INTO accounts(tenant_id,entity_id,code,name,type) SELECT tenant_id,id,'2400','Customer credits payable','Liability' FROM entities;
-- PostgreSQL requires UPDATE privilege to take a row lock. The immutable trigger
-- still rejects every actual edit; locking serializes applications and refunds.
GRANT UPDATE ON credit_notes TO gv_workspace_runtime;
